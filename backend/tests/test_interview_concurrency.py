"""Genuine-interleaving regression tests for TODOS.md's "mutation routes race on a stale session
snapshot" item (fixed here via a shared ``InterviewSession.turn_version`` CAS token, the same
mechanism already proven for the external engine in ``external_runner._reserve_turn``).

Deliberately NOT the shared ``db_session``/``client`` fixtures from ``conftest.py`` — those hand
every caller the SAME ``AsyncSession`` over a ``:memory:`` + ``StaticPool`` engine, so two "callers"
in one test would just be two Python references to one object with no real writer race between
them. A test built on that fixture can call two mutators back-to-back and would pass whether or not
any guard existed at all. Instead, mirror ``test_external_interview.py``'s pattern: a file-backed
aiosqlite DB (two independent connections are genuinely concurrent writers under SQLite's
serialized-writer model) plus two independent ``AsyncSession`` objects each loading their own copy
of the same row, driven together via ``asyncio.gather`` so the interleaving is real, not simulated
by call order.

Covers the three route pairs the TODO named:
  - ``/answer`` vs ``/answer`` (a double-submit race) — bank engine's ``answer_finalized``.
  - ``/answer`` vs ``/restart`` — ``answer_finalized`` vs ``abandon_interview``.
  - ``/judge`` (and ``/judge/apply``) vs ``/answer`` — the shared ``turn_version_changed``
    freshness check that now guards both judge routes, exercised directly since it has no
    write-side race of its own to synchronize (it is a read-after-a-slow-step check, not a CAS).
"""

import asyncio
import contextlib
from datetime import datetime, timedelta
from pathlib import Path

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import app.models  # noqa: F401 — registers ORM classes on Base.metadata
from app.db import Base
from app.interview import state_machine
from app.interview.judge_flow import turn_version_changed
from app.interview.state_machine import InterviewStateError
from app.models.anonymous_session import AnonymousCandidateSession
from app.models.interview import InterviewSession


@contextlib.asynccontextmanager
async def _file_factory(tmp_path: Path):
    """A real file-backed aiosqlite session factory (see module docstring for why file-backed, not
    :memory:/StaticPool, is required to exercise a genuine writer race)."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'it.db'}")

    @event.listens_for(engine.sync_engine, "connect")
    def _pragmas(dbapi_connection, _record):  # noqa: ANN001
        cur = dbapi_connection.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA busy_timeout=5000")
        cur.close()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        yield factory
    finally:
        await engine.dispose()


async def _seed_candidate(session: AsyncSession) -> str:
    now = datetime(2026, 1, 1)
    cand = AnonymousCandidateSession(expires_at=now + timedelta(days=1), last_activity_at=now)
    session.add(cand)
    await session.commit()
    await session.refresh(cand)
    return cand.id


async def test_two_concurrent_answers_yield_exactly_one_conflict(tmp_path):
    """Double-submit on the SAME question (e.g. a slow page + a retry, or two tabs): exactly one
    of the two concurrent ``answer_finalized`` calls may land. The loser must see
    ``InterviewStateError`` (→ 409 at the route), never a second, out-of-order candidate turn for a
    question the winner already advanced past."""
    async with _file_factory(tmp_path) as factory:
        async with factory() as setup_db:
            cand_id = await _seed_candidate(setup_db)
            started = await state_machine.start_interview(setup_db, cand_id)
            sid = started.id

        # Two independent connections each load the SAME row at the SAME turn_version — the setup
        # required for a genuine CAS race (both see themselves as the sole writer).
        async with factory() as db_a, factory() as db_b:
            sess_a = await db_a.get(InterviewSession, sid)
            sess_b = await db_b.get(InterviewSession, sid)
            assert sess_a is not None and sess_b is not None
            results = await asyncio.gather(
                state_machine.answer_finalized(db_a, sess_a, "answer A"),
                state_machine.answer_finalized(db_b, sess_b, "answer B"),
                return_exceptions=True,
            )

    conflicts = [r for r in results if isinstance(r, InterviewStateError)]
    wins = [r for r in results if isinstance(r, InterviewSession)]
    assert len(conflicts) == 1
    assert len(wins) == 1
    # The winner actually advanced (or completed, for a single-question bank) — not a no-op.
    assert wins[0].turn_version == 1


async def test_concurrent_answer_and_restart_never_corrupt_each_other(tmp_path):
    """``/answer`` and ``/restart`` racing on the same session (the TODO's second named pair).

    Unlike two competing answers, there is no single "correct" winner here — a candidate hitting
    submit at the exact moment they also hit restart has no wrong choice for the system to protect
    against, so this test does not assert which of the two calls wins. What it does assert is the
    invariant that actually matters: restart's intent ("abandon whatever is live") is
    content-independent, so ``abandon_interview``'s bounded retry (state_machine.py) must ALWAYS
    eventually land — it never permanently loses to a concurrent answer — and whichever order the
    two commits happen in, the interview ends up ``abandoned`` with no orphaned write on top of it.
    """
    async with _file_factory(tmp_path) as factory:
        async with factory() as setup_db:
            cand_id = await _seed_candidate(setup_db)
            started = await state_machine.start_interview(setup_db, cand_id)
            sid = started.id

        async with factory() as db_a, factory() as db_b:
            sess_a = await db_a.get(InterviewSession, sid)
            sess_b = await db_b.get(InterviewSession, sid)
            assert sess_a is not None and sess_b is not None
            answer_result, restart_result = await asyncio.gather(
                state_machine.answer_finalized(db_a, sess_a, "an answer submitted mid-restart"),
                state_machine.abandon_interview(db_b, sess_b),
                return_exceptions=True,
            )

        async with factory() as verify_db:
            final = await verify_db.get(InterviewSession, sid)

    # Restart's retry loop means it never fails from this race — either it wins outright, or it
    # loses the first CAS attempt, re-reads the answer's committed state, and succeeds on retry.
    assert isinstance(restart_result, InterviewSession)
    assert restart_result.status == "abandoned"
    # The answer either landed cleanly before the restart (a legitimate, harmless outcome — the
    # candidate's last answer is preserved even though they then restarted) or lost the CAS and
    # was correctly rejected; either way it must never raise anything OTHER than the guard's own
    # InterviewStateError.
    assert isinstance(answer_result, InterviewSession) or isinstance(
        answer_result, InterviewStateError
    )
    # The row itself is never left ambiguous: restart's write is always the one standing at rest.
    assert final is not None
    assert final.status == "abandoned"


async def test_judge_freshness_check_detects_an_answer_committed_during_its_slow_step(tmp_path):
    """``/judge`` (and ``/judge/apply``) hold no lock while their slow step runs — ``/judge``'s LLM
    call, or the gap between ``/judge/apply``'s own staleness re-queries and its write. This proves
    ``turn_version_changed`` (app/interview/judge_flow.py) correctly observes, from a SEPARATE
    connection that has been sitting on a now-stale snapshot, a commit made by a genuinely
    concurrent ``answer_finalized`` on ANOTHER connection while the first connection's "slow step"
    was in flight — the exact shape of the judge-vs-submit race named in the TODO.

    The judge side's ``asyncio.sleep`` stands in for the real slow step (an outbound LLM call /
    ``run_judge``); it does not fix the ordering artificially — it is what makes the two coroutines
    truly overlap on the event loop instead of one finishing before the other is ever scheduled,
    which is the same reason a real slow judge call is what actually opens this window in
    production.
    """
    async with _file_factory(tmp_path) as factory:
        async with factory() as setup_db:
            cand_id = await _seed_candidate(setup_db)
            started = await state_machine.start_interview(setup_db, cand_id, turn_mode="judged")
            sid = started.id

        async with factory() as db_judge, factory() as db_answer:
            judge_session = await db_judge.get(InterviewSession, sid)
            answer_session = await db_answer.get(InterviewSession, sid)
            assert judge_session is not None and answer_session is not None
            seen_turn_version = judge_session.turn_version

            async def judge_side() -> bool:
                await asyncio.sleep(0.05)  # stands in for the real outbound LLM call
                return await turn_version_changed(db_judge, judge_session)

            async def answer_side() -> InterviewSession:
                return await state_machine.answer_finalized(db_answer, answer_session, "answer")

            changed, advanced = await asyncio.gather(judge_side(), answer_side())

    assert advanced.turn_version != seen_turn_version
    assert changed is True
