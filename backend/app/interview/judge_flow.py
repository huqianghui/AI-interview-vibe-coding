"""The pre-submit judge's orchestration (issue #114): staleness, budget, one call in flight, the
``judge_events`` row, and the deferred delivery of a dry-run verdict (D17).

``judge.py`` owns the LLM call itself (prompt, verdict policy, leak guard, timeout); this module
decides whether to make it and records what it said. The candidate routes in ``api/interview.py``
only map the results to HTTP: an :class:`InterviewStateError` from here is a 409, everything else
is a :class:`JudgeOutcome`.

Every way a request can be stale or over budget returns ``wait`` rather than an error: the judge is
invisible background pacing, so the page simply stays quiet.
"""

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.interview import judge as judge_mod
from app.interview import state_machine
from app.interview.state_machine import InterviewStateError
from app.models.interview import InterviewSession
from app.models.judge_event import JudgeEvent
from app.services import persona_service, rubric_version_service

# Raw LLM calls allowed per question = applied budget × this factor (speculative prefetches that get
# discarded because the candidate kept talking still cost a call; this bounds a very chatty answer).
JUDGE_LLM_CALLS_PER_APPLIED = 3

# One in-flight judge per session (single-process guard; a second concurrent request is a 409 the
# page treats as "wait"). Cleared in a finally block, so a crash can never wedge a session. Valid
# only while the backend runs ONE replica (maxReplicas=1): a second replica would not see it.
_JUDGE_IN_FLIGHT: set[str] = set()


class InterviewNotLive(InterviewStateError):
    """The interview is not ``in_progress``."""


class JudgeInFlight(InterviewStateError):
    """Another judge call for this session has not finished."""


@dataclass(frozen=True)
class JudgeOutcome:
    verdict: str  # wait | nudge
    speech_text: str = ""
    event_id: str | None = None


WAIT = JudgeOutcome(verdict="wait")


async def turn_version_changed(db: AsyncSession, session: InterviewSession) -> bool:
    """Whether `session`'s row has moved (an advancing/completing ``/answer``, or an abandoning
    ``/restart``) since we loaded it (TODOS.md, "mutation routes race on a stale session
    snapshot"). :func:`judge` and :func:`apply` already re-check the question id and follow-up
    count against fresh queries taken close to the write, but neither re-derives
    ``current_question_index``/``status`` itself, and :func:`judge` in particular holds a slow LLM
    call open across the gap. ``turn_version`` is the one column both bank-mutating paths
    (``answer_finalized``, ``abandon_interview``) unconditionally bump on every committed change,
    so a single comparison here catches every way the session could have moved on without
    duplicating each path's own staleness logic.
    """
    current = (
        await db.execute(
            select(InterviewSession.turn_version).where(InterviewSession.id == session.id)
        )
    ).scalar_one()
    return current != session.turn_version


async def _judge_usage(db: AsyncSession, session_id: str, question_id: str) -> tuple[int, int]:
    """(applied verdicts, LLM calls) recorded for this question."""
    rows = (
        await db.execute(
            select(JudgeEvent.applied, JudgeEvent.verdict).where(
                JudgeEvent.interview_session_id == session_id,
                JudgeEvent.question_id == question_id,
            )
        )
    ).all()
    applied = sum(1 for a, _v in rows if a)
    return applied, len(rows)


def _require_live(session: InterviewSession) -> None:
    if session.status != "in_progress":
        raise InterviewNotLive("Interview is not live")


async def judge(
    db: AsyncSession,
    session: InterviewSession,
    *,
    question_id: str,
    follow_ups_asked: int,
    draft_text: str,
    trigger: str,
    dry_run: bool,
) -> JudgeOutcome:
    """Ask the judge whether the interviewer should say something DURING the candidate's pause.

    Cheap exits (no LLM call, no ``judge_events`` row): the session is not ``judged`` (snapshot),
    not a live bank session, the ids are stale (question advanced / follow-up count moved), the
    draft is blank, or the per-question call budget is spent — all ⇒ ``wait``. A concurrent judge
    for the same session raises :class:`JudgeInFlight`. Otherwise one LLM call; the only speaking
    verdict is ``nudge`` ("please go on"), returned as text — the judge never writes an interviewer
    turn (the ``follow_up`` / ``redirect`` verdicts were retired 2026-09-28: the judge paces, it
    never probes). Every LLM call writes one ``judge_events`` row.
    """
    _require_live(session)
    if session.turn_mode != "judged" or session.brain_mode != "bank":
        return WAIT
    if not draft_text.strip():
        return WAIT

    questions = await state_machine.resolve_questions(db, session.bank_id)
    current = state_machine.question_at(questions, session.current_question_index)
    if current is None or current.id != question_id:
        return WAIT  # stale: the question advanced
    asked = await state_machine.follow_ups_asked(db, session.id, current.id)
    if asked != follow_ups_asked:
        return WAIT  # stale: a follow-up landed since the page last synced

    persona = await persona_service.get_session_persona(db, session)
    max_calls = persona.judge_max_calls_per_question if persona else 0
    applied_used, llm_used = await _judge_usage(db, session.id, current.id)
    if applied_used >= max_calls:
        return WAIT  # delivered-verdict budget spent for this question
    if llm_used >= max_calls * JUDGE_LLM_CALLS_PER_APPLIED:
        return WAIT  # raw LLM-call bound (speculative prefetch cost guard)

    if session.id in _JUDGE_IN_FLIGHT:
        raise JudgeInFlight("A judge call is already in flight")
    _JUDGE_IN_FLIGHT.add(session.id)
    try:
        items = await rubric_version_service.rubric_rows(
            db, question_id=current.id, rubric_version_id=session.rubric_version_id
        )
        prior = await state_machine.follow_up_texts(db, session.id, current.id)
        inp = judge_mod.JudgeInput(
            question_text=current.prompt,
            locale=current.language,
            persona_prompt=persona.prompt_fragment if persona else "",
            draft_text=draft_text,
            trigger=trigger,
            expected_points=tuple(current.expected_points),
            checklist=tuple(
                judge_mod.RubricItem(
                    kind=i.kind, text=i.text, weight=i.weight, order_index=i.order_index
                )
                for i in items
            ),
            prior_follow_ups=tuple(prior),
            follow_ups_asked=asked,
            max_follow_ups=current.max_follow_ups,
        )
        # Nothing is written above; end the read so the pooled connection is not held while the
        # LLM thinks (on PostgreSQL an open transaction pins a connection; ~15 at once starve the
        # pool for every request).
        await db.commit()
        result = await judge_mod.run_judge(inp, judge_mod.get_judge_adapter())
        # The LLM call above is the slow part; re-check freshness now, right before writing, so a
        # candidate who submitted (or restarted) while it was in flight gets a silent "wait"
        # instead of a judge_events row + budget slot spent on a question they already left.
        if await turn_version_changed(db, session):
            return WAIT
        event = JudgeEvent(
            interview_session_id=session.id,
            question_id=current.id,
            trigger=trigger,
            verdict=result.event_verdict,
            speech_text=result.speech_text,
            reason=(result.reason or result.error or "")[:1000],
            model=result.model[:100],
            latency_ms=result.latency_ms,
            # A dry run is applied later (or never); a one-step call is delivered right now. A
            # silent outcome never consumes budget either way.
            applied=(not dry_run) and result.verdict != "wait",
        )
        db.add(event)
        await db.commit()
        await db.refresh(event)
        return JudgeOutcome(
            verdict=result.verdict, speech_text=result.speech_text, event_id=event.id
        )
    finally:
        _JUDGE_IN_FLIGHT.discard(session.id)


async def apply(
    db: AsyncSession,
    session: InterviewSession,
    *,
    event_id: str,
    question_id: str,
    follow_ups_asked: int,
) -> JudgeOutcome:
    """Deliver a dry-run verdict now that the pause has lasted (D17). Idempotent and stale-safe:
    an unknown / already-applied event, a non-``nudge`` event, a question that advanced or a moved
    follow-up count all come back as ``wait`` and write nothing. ``nudge`` is marked delivered and
    returned as text."""
    _require_live(session)
    event = (
        await db.execute(
            select(JudgeEvent).where(
                JudgeEvent.id == event_id, JudgeEvent.interview_session_id == session.id
            )
        )
    ).scalar_one_or_none()
    if event is None or event.applied or event.verdict != "nudge":
        return JudgeOutcome(verdict="wait", event_id=event_id)
    waited = JudgeOutcome(verdict="wait", event_id=event.id)
    questions = await state_machine.resolve_questions(db, session.bank_id)
    current = state_machine.question_at(questions, session.current_question_index)
    if current is None or current.id != question_id or event.question_id != current.id:
        return waited
    if await state_machine.follow_ups_asked(db, session.id, current.id) != follow_ups_asked:
        return waited
    persona = await persona_service.get_session_persona(db, session)
    max_calls = persona.judge_max_calls_per_question if persona else 0
    applied_used, _llm = await _judge_usage(db, session.id, current.id)
    if applied_used >= max_calls:
        return waited
    # Same freshness re-check as judge(), at the same point relative to the write: the checks above
    # already re-query question id and follow-up count, but not session-level status/turn_version,
    # so a /restart that landed between them and here would otherwise still get delivered as a
    # nudge for an interview the candidate no longer has open.
    if await turn_version_changed(db, session):
        return waited
    event.applied = True
    await db.commit()
    return JudgeOutcome(verdict="nudge", speech_text=event.speech_text, event_id=event.id)
