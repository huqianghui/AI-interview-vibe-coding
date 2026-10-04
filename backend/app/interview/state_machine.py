"""Turn-by-turn interview state machine (SPEC F6), Step 0 thin slice.

Channel-agnostic by design (SPEC P9): text submit, voice end-of-utterance, and verbal-cue
finalization all converge on ONE event — ``answer_finalized(db, session, text, source)``. The
three producers differ only in how they detect end-of-answer (transport); the progression logic
is shared through this single entry point, not through a forced shared abstraction.

Follow-up hook (F6 AC #4): a question may carry up to ``max_follow_ups`` follow-up turns.
The progression ``asking → answering → (follow_up × 0..N) → judged → next`` is derived from the
turns already recorded — ``current_question_index`` names the question, and the count of
follow-up interviewer turns for it tells us whether the next answer is a ``main`` or a
``follow_up``. All follow-up content joins that question's answer group for scoring (see
``app.interview.scoring.group_answers``). Since v0.39.2.0 ``answer_finalized`` itself never
originates a follow-up in production (a submit always advances, every turn mode); follow-ups are
written only by :func:`record_follow_up` — the judge's pre-submit path in ``judged`` sessions.

Status lifecycle enforced: created → in_progress → completed → scored.

Concurrency (TODOS.md, "mutation routes race on a stale session snapshot"): production runs
SQLite, where ``SELECT ... FOR UPDATE`` is a silent no-op (the dialect drops it) — a row lock would
look correct in review and protect nothing. ``answer_finalized`` and ``abandon_interview`` instead
reuse the CAS already proven in ``external_runner._reserve_turn``: a single guarded
``UPDATE ... WHERE turn_version = :seen AND <status guard>`` that bumps ``turn_version`` atomically.
Zero rows affected means another commit (an interleaved ``/answer`` or ``/restart``) landed first,
and the caller re-checked ``session.current_question_index``/``status`` against a value that never
became stale between load and write — the exact TOCTOU the TODO names.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.interview.questions import Question, question_at, resolve_questions
from app.interview.scoring import group_answers
from app.interview.scoring_engine import (
    QuestionResult,
    build_narrative,
    cap_outcome,
    grade_for_score,
    outcome_for_score,
)
from app.interview.verbal_cue import strip_verbal_cue
from app.models.checklist import Checklist, ChecklistItem
from app.models.interview import InterviewSession, InterviewTurn
from app.models.sop import SopDocument
from app.services import scoring_service, sop_coverage

logger = logging.getLogger(__name__)

# Sources that can finalize an answer (P9). All route through answer_finalized().
ANSWER_SOURCES = ("text", "voice", "verbal_cue")

# How often the report stream emits a keepalive while questions are being graded. Must stay well
# under Azure Container Apps' ingress "idle request timeout" (default 4 minutes, configurable 4-30);
# 20 s leaves an order of magnitude of headroom and costs one ~70-byte line per interval.
SCORING_HEARTBEAT_SECONDS = 20.0

# How many questions are graded at once. Measured sequentially against the live default bank:
# ~18.4 s median per question, 166 s for nine. Three at a time brings that to roughly 60 s, four to
# ~45 s. It is bounded rather than unlimited because Azure enforces a tokens-per-minute limit and
# nine simultaneous ~4k-char prompts would throttle — which would cost more in 429 backoff than
# the concurrency saved. Three is the conservative starting point; raise it only with a live
# measurement showing no throttling at the higher number.
SCORING_CONCURRENCY = 3


class InterviewStateError(Exception):
    """Raised on an illegal state transition (e.g. answering a completed interview)."""


async def find_resumable_interview(
    db: AsyncSession, candidate_session_id: str
) -> InterviewSession | None:
    """The candidate's most recent still-in-progress interview, or None.

    Lets ``start_interview`` resume instead of orphaning an in-progress session on a page reload
    (edge case b). Ordered by creation so the latest wins if more than one somehow exists.
    """
    return (
        (
            await db.execute(
                select(InterviewSession)
                .where(
                    InterviewSession.candidate_session_id == candidate_session_id,
                    InterviewSession.status == "in_progress",
                )
                .order_by(InterviewSession.created_at.desc())
            )
        )
        .scalars()
        .first()
    )


# Bound on abandon_interview's CAS retry loop. Each attempt is a single local UPDATE (no I/O, no
# LLM call), so looping is cheap; this only exists to make a hypothetical hot loop impossible, not
# because contention this tight is expected.
_ABANDON_CAS_MAX_ATTEMPTS = 5


async def abandon_interview(db: AsyncSession, session: InterviewSession) -> InterviewSession:
    """Mark a live interview ``abandoned`` — the candidate chose to start over (v0.38.3.0).

    ``abandoned`` is a TERMINAL status alongside ``completed``/``scored``: the session and its turns
    stay in the DB for the record, but it is never resumed (``find_resumable_interview`` matches
    ``in_progress`` only), never reviewed or scored (those routes require ``completed``), and never
    offered a voice session. Accepts ``in_progress`` (bank, or an external session whose brain
    could not be notified) and ``completed`` (an external session that was just sent the ``end``
    signal by the restart route — it must not linger as a scoreless "finished" interview); anything
    else is an illegal transition.

    CAS-guarded (module docstring) against a concurrent ``/answer`` that advances or completes the
    same session between the caller's load and this write. Unlike ``answer_finalized``, a lost race
    here is safe to just retry: restart's intent — "abandon whatever is currently live" — does not
    depend on which question the candidate was on, so re-reading and re-attempting the same CAS
    cannot write content against the wrong question the way retrying an answer could. Only a status
    that has left the accepted set (e.g. a second concurrent restart already abandoned it) is a real
    conflict, and that already raises above on the next loop iteration.
    """
    for _ in range(_ABANDON_CAS_MAX_ATTEMPTS):
        if session.status not in ("in_progress", "completed"):
            raise InterviewStateError(f"Cannot abandon an interview in status {session.status!r}")
        result = await db.execute(
            update(InterviewSession)
            .where(
                InterviewSession.id == session.id,
                InterviewSession.turn_version == session.turn_version,
                InterviewSession.status.in_(("in_progress", "completed")),
            )
            .values(
                status="abandoned",
                completed_at=_now(),
                turn_version=InterviewSession.turn_version + 1,
            )
        )
        if result.rowcount == 1:
            await db.commit()
            await db.refresh(session)
            return session
        # Someone else's commit (a concurrent /answer, or a second /restart) landed since we last
        # looked — re-read live state and loop; the top-of-loop status check catches a genuine
        # conflict (already abandoned) instead of retrying forever.
        await db.rollback()
        await db.refresh(session)
    raise InterviewStateError("Interview session is changing too fast to abandon — please retry")


async def start_interview(
    db: AsyncSession, candidate_session_id: str, *, turn_mode: str = "linear"
) -> InterviewSession:
    """Start a new interview — or resume the candidate's existing in-progress one.

    ``turn_mode`` (issue #114, review D6) is the persona's ``bank_turn_mode`` at this moment,
    SNAPSHOTTED onto the session so later persona edits never re-interpret a live interview.

    Resuming (edge case b) prevents a reload from stranding a live interview behind a second,
    disconnected session. Only a fresh start records the first interviewer turn (asking question 1);
    a resumed session already has its turns, and ``get_current_question`` replays the pending one.
    """
    existing = await find_resumable_interview(db, candidate_session_id)
    if existing is not None:
        return existing

    session = InterviewSession(
        candidate_session_id=candidate_session_id,
        status="in_progress",
        current_question_index=0,
        turn_mode=turn_mode if turn_mode in TURN_MODES else "linear",
    )
    session.started_at = _now()
    db.add(session)
    await db.flush()  # assign session.id before writing the turn (avoids a second round-trip)

    questions = await resolve_questions(db)
    first = question_at(questions, 0)
    if first is not None:
        db.add(
            InterviewTurn(
                interview_session_id=session.id,
                question_id=first.id,
                turn_index=0,
                role="interviewer",
                turn_kind="main",
                source="text",
                content=first.prompt,
            )
        )
    else:
        # No questions resolved at all (only reachable if FALLBACK_QUESTIONS is emptied — see
        # questions.resolve_questions). Nothing to ask → the interview is immediately complete
        # rather than a live session with no question (edge case a: a defined terminal state).
        session.status = "completed"
        session.completed_at = _now()
    await db.commit()
    await db.refresh(session)
    return session


# --- Follow-up providers (issue #114, review D3) -------------------------------------------------
# ``(question, answer_text, follow_ups_asked) -> follow-up text | None``. The state machine only
# RECORDS what a provider returns; it never decides content or calls an LLM itself.
#
# Since v0.39.2.0 NO route passes a provider: a submit ("I'm done") ALWAYS advances, in every turn
# mode (owner rule, 2026-09-24). Follow-ups exist only as the judge's pre-submit
# :func:`record_follow_up` writes (``judged`` sessions), gated by the question's ``max_follow_ups``.
# The hook stays so a future provider can be wired in without touching the transaction.
FollowUpProvider = Callable[[Question, str, int], Awaitable[str | None]]

# Turn contract values snapshotted onto ``InterviewSession.turn_mode`` (see the model).
TURN_MODES = ("linear", "judged")


async def follow_ups_asked(db: AsyncSession, session_id: str, question_id: str) -> int:
    """Public alias of the follow-up counter (used by the /judge route's stale-id check)."""
    return await _follow_ups_asked(db, session_id, question_id)


async def follow_up_texts(db: AsyncSession, session_id: str, question_id: str) -> list[str]:
    """The interviewer follow-up texts already asked on ``question_id`` (judge context)."""
    rows = (
        await db.execute(
            select(InterviewTurn.content)
            .where(
                InterviewTurn.interview_session_id == session_id,
                InterviewTurn.question_id == question_id,
                InterviewTurn.role == "interviewer",
                InterviewTurn.turn_kind == "follow_up",
            )
            .order_by(InterviewTurn.turn_index)
        )
    ).scalars()
    return list(rows)


async def record_follow_up(
    db: AsyncSession, session: InterviewSession, question_id: str, text: str
) -> InterviewTurn:
    """Write an interviewer ``follow_up`` turn for the current question WITHOUT a candidate turn —
    the judge's pre-submit follow-up / redirect (issue #114). The pending follow-up then shows in
    ``get_current_question`` (``is_follow_up``) exactly like a template one, and the candidate's
    eventual single submit joins this question's answer group as a ``follow_up`` answer."""
    turn = InterviewTurn(
        interview_session_id=session.id,
        question_id=question_id,
        turn_index=await _next_turn_index(db, session.id),
        role="interviewer",
        turn_kind="follow_up",
        source="text",
        content=text,
    )
    db.add(turn)
    await db.commit()
    await db.refresh(turn)
    return turn


async def answer_finalized(
    db: AsyncSession,
    session: InterviewSession,
    text: str,
    source: str = "text",
    follow_up_provider: FollowUpProvider | None = None,
) -> InterviewSession:
    """The single channel-agnostic finalization event (P9).

    Records the candidate turn for the current question, then ADVANCES: records the next question's
    interviewer turn, or marks the interview completed when none remain. Owner rule (2026-09-24,
    v0.39.2.0): a submit ("I'm done") always moves to the next question in EVERY turn mode —
    ``linear`` sessions no longer get the authored template follow-up at submit (the question's
    ``max_follow_ups`` is consulted only by the judge, during pauses, in ``judged`` sessions via
    :func:`record_follow_up`). The LLM is never called inside this transaction.

    ``follow_up_provider`` is the retained hook (no route passes one): if given AND the question
    still has a follow-up slot, its text is recorded as an interviewer ``follow_up`` turn and the
    session stays on the same question (the next answer joins this question's answer group).
    """
    if source not in ANSWER_SOURCES:
        raise InterviewStateError(f"Unknown answer source {source!r}")
    if session.status != "in_progress":
        raise InterviewStateError(f"Cannot answer in status {session.status!r}")

    questions = await resolve_questions(db)
    current = question_at(questions, session.current_question_index)
    if current is None:
        raise InterviewStateError("No current question to answer")

    # A verbal cue ("我答完了"/"done") is transport signalling, not answer content — strip it so
    # the stored/scored answer is the substance the candidate actually gave.
    content = strip_verbal_cue(text) if source == "verbal_cue" else text

    # Requirement 3: an empty answer cannot pass. The API layer already 422s a blank ``text``, but
    # a verbal-cue message that is ONLY the cue (e.g. "我答完了") strips to empty here and would
    # otherwise be recorded as a silent blank answer — reject it so no question is finalized without
    # substance. Route catches InterviewStateError → 409.
    if not content.strip():
        raise InterviewStateError("Answer content must not be empty")

    # CAS reservation (module docstring): bump turn_version now, before any turn writes, so a
    # concurrent /answer (double-submit) or /restart that already committed against this same
    # session is caught here instead of racing silently to two different outcomes. Zero rows means
    # someone else's write landed first — roll back and make the candidate retry against fresh
    # state rather than write turns beside (or on top of) it.
    reserved = await db.execute(
        update(InterviewSession)
        .where(
            InterviewSession.id == session.id,
            InterviewSession.turn_version == session.turn_version,
            InterviewSession.status == "in_progress",
        )
        .values(turn_version=InterviewSession.turn_version + 1)
    )
    if reserved.rowcount != 1:
        await db.rollback()
        raise InterviewStateError("Interview session changed concurrently — please retry")

    follow_ups_asked = await _follow_ups_asked(db, session.id, current.id)
    next_turn_index = await _next_turn_index(db, session.id)
    # This candidate turn is a follow-up answer iff at least one follow-up has already been asked.
    turn_kind = "follow_up" if follow_ups_asked > 0 else "main"
    db.add(
        InterviewTurn(
            interview_session_id=session.id,
            question_id=current.id,
            turn_index=next_turn_index,
            role="candidate",
            turn_kind=turn_kind,
            source=source,
            content=content,
        )
    )

    follow_up_text = (
        await follow_up_provider(current, content, follow_ups_asked)
        if follow_up_provider is not None and follow_ups_asked < current.max_follow_ups
        else None
    )
    if follow_up_text:
        # Owe another follow-up: ask it and stay on this question.
        db.add(
            InterviewTurn(
                interview_session_id=session.id,
                question_id=current.id,
                turn_index=next_turn_index + 1,
                role="interviewer",
                turn_kind="follow_up",
                source="text",
                content=follow_up_text,
            )
        )
    else:
        # Question fully answered → advance to the next question, or complete.
        session.current_question_index += 1
        following = question_at(questions, session.current_question_index)
        if following is not None:
            db.add(
                InterviewTurn(
                    interview_session_id=session.id,
                    question_id=following.id,
                    turn_index=next_turn_index + 1,
                    role="interviewer",
                    turn_kind="main",
                    source="text",
                    content=following.prompt,
                )
            )
        else:
            session.status = "completed"
            session.completed_at = _now()

    await db.commit()
    await db.refresh(session)
    return session


async def score_and_finalize(
    db: AsyncSession, session: InterviewSession, *, sop_coverage_check: bool = False
) -> dict:
    """Score a completed interview and return the report dict (batch wrapper).

    Thin non-streaming wrapper over :func:`score_and_finalize_events` — drains the event stream
    and returns the final report. Kept as the stable entry point for the batch ``POST /report``
    endpoint and every existing test; the streaming endpoint consumes the generator directly.
    """
    report: dict | None = None
    async for event in score_and_finalize_events(
        db, session, sop_coverage_check=sop_coverage_check
    ):
        if event["type"] == "report":
            report = event["report"]
    assert report is not None  # the generator always ends with a report event
    return report


async def score_and_finalize_events(
    db: AsyncSession, session: InterviewSession, *, sop_coverage_check: bool = False
):
    """Score a completed interview, yielding per-question progress; flips status to ``scored``.

    F4: each answer is graded against its question's default checklist into a 4-state judgment per
    item with SOP + answer quotes (the traceable, weighted score the demo leads with). A question
    with no checklist authored yet falls back to the length-based stub row, so the report always
    covers every question. Only allowed once ``completed`` (F8 AC #4: report only when scored).

    An async generator so the scoring-progress screen can show REAL progress (each LLM grading
    call takes seconds; a 10-question interview used to sit behind one long batch request while
    the UI faked its numerator). Yields, in order:

    - ``{"type": "progress", "done": i, "total": n, "question_id": ...}`` — BEFORE grading each
      answer (``done`` = answers already graded), so the UI can say "analyzing answer i+1 of n";
    - ``{"type": "report", "report": <the full report dict>}`` — exactly once, last.

    ``sop_coverage_check`` (feature D, default off) is a reference-only audit: when on, each
    graded question is additionally checked for SOP points its checklist may not cover, and the
    findings are attached under ``sop_coverage``. It NEVER affects any score — the numbers below
    are computed from the checklist alone regardless of this flag.
    """
    if session.status not in ("completed", "scored"):
        raise InterviewStateError(f"Cannot score in status {session.status!r}")

    # question_id → prompt text, so the scorer can build a cross-language judging prompt.
    questions = await resolve_questions(db)
    prompt_by_id = {q.id: q.prompt for q in questions}
    # question_id → aggregate weight (default 1). A question weighted 0 or missing still scores per
    # question but contributes nothing to the interview-level mean.
    weight_by_id = {q.id: max(q.weight, 0) for q in questions}

    answers = await _candidate_answers(db, session.id)

    # SOP document_id → display name, so each scored item can carry a human-readable source label
    # alongside the id the report links to. One query up front (SOP corpus is small); items whose
    # source doc was deleted simply resolve to no name and the link falls back to the page label.
    doc_names = {
        doc_id: name
        for doc_id, name in (await db.execute(select(SopDocument.id, SopDocument.name))).all()
    }

    per_question: list[dict] = []
    weighted_sum = 0.0
    weight_total = 0
    all_warnings: list[str] = []
    graded_results: list = []
    any_graded = False
    any_capped = False
    # Feature D: reference-only "SOP points the rubric may not cover", collected per question when
    # the opt-in flag is on. Never touches any score below.
    coverage_findings: list[dict] = []

    unscored: list[str] = []

    # ── Phase 1: every database read, sequentially ────────────────────────────────────────────
    # SQLAlchemy's AsyncSession is NOT safe for concurrent use — two coroutines awaiting the same
    # session corrupt it — so all of the per-question queries (checklist, items, SOP passages)
    # happen before anything is dispatched. They are three cheap local queries per question.
    prepared: list[tuple[str, str, scoring_service.ScoringTask | None]] = []
    for question_id, answer_text in answers:
        prepared.append(
            (
                question_id,
                answer_text,
                await scoring_service.prepare_scoring(
                    db,
                    question_id=question_id,
                    question_text=prompt_by_id.get(question_id, ""),
                    answer_text=answer_text,
                ),
            )
        )

    # ── Phase 2: the LLM calls, concurrently ──────────────────────────────────────────────────
    # Grading one question is ~18 s against the live bank, and the questions are independent, so
    # running them one at a time cost 166 s for a nine-question report — nearly three minutes of a
    # candidate watching a progress bar. Bounded by a semaphore rather than dispatched all at once:
    # Azure enforces a tokens-per-minute limit, and nine simultaneous ~4k prompts would throttle.
    #
    # `done` now counts questions FINISHED, not the index of the one being started. With concurrency
    # there is no single "current" question to name, and "4 of 9 done" is both accurate and more
    # useful than the old "analyzing answer 4 of 9".
    total = len(answers)
    completed = 0
    yield {"type": "progress", "done": 0, "total": total}

    # A question with no authored checklist needs no LLM call at all — it takes the length-based
    # stub row. Count those as finished immediately, so the numerator and the denominator describe
    # the same set: an interview whose bank has no checklists at all must still report progress
    # climbing to its total, not sit at 0 of N forever.
    for question_id, _answer_text, task in prepared:
        if task is None:
            completed += 1
            yield {
                "type": "progress",
                "done": completed,
                "total": total,
                "question_id": question_id,
            }

    semaphore = asyncio.Semaphore(SCORING_CONCURRENCY)

    async def _judge(task):
        async with semaphore:
            return await scoring_service.judge_prepared(task)

    owner: dict[asyncio.Future, str] = {}
    for question_id, _answer_text, task in prepared:
        if task is not None:
            owner[asyncio.ensure_future(_judge(task))] = question_id

    results: dict[str, QuestionResult] = {}
    errors: dict[str, Exception] = {}
    pending: set = set(owner)
    while pending:
        # Heartbeat on the timeout branch: the connection must never sit idle past Azure Container
        # Apps' ingress idle timeout (default 4 minutes), which is what turned one stalled call into
        # `504 stream timeout` and cost the candidate an entire report.
        finished, pending = await asyncio.wait(
            pending, timeout=SCORING_HEARTBEAT_SECONDS, return_when=asyncio.FIRST_COMPLETED
        )
        if not finished:
            yield {"type": "ping", "done": completed, "total": total}
            continue
        for future in finished:
            question_id = owner[future]
            completed += 1
            try:
                results[question_id] = future.result()
            except Exception as exc:  # noqa: BLE001 — one question must not cost the whole report
                errors[question_id] = exc
                logger.warning("Scoring failed for question %s: %s", question_id, exc)
                yield {
                    "type": "question_error",
                    "done": completed,
                    "total": total,
                    "question_id": question_id,
                    "detail": type(exc).__name__,
                }
            else:
                yield {
                    "type": "progress",
                    "done": completed,
                    "total": total,
                    "question_id": question_id,
                }

    # ── Phase 3: aggregate in BANK ORDER ──────────────────────────────────────────────────────
    # Not completion order: the report reads top to bottom as the candidate answered (req. 2),
    # and concurrency finishes questions in whatever order the model returns them. The opt-in SOP
    # coverage check lives here too — it is another DB call, so it stays sequential.
    for question_id, answer_text, task in prepared:
        if task is None:
            # No checklist authored for this question — length-based stub row.
            per_question.append(scoring_service.stub_result_dict(question_id, answer_text))
            continue
        failure = errors.get(question_id)
        if failure is not None:
            # Per-question isolation. The question is recorded as NOT SCORED and excluded from the
            # score the same way a stub question is (out of both numerator and denominator), so the
            # candidate keeps every answer that did grade. Scoring it 0 instead would be the
            # under-count P7 forbids — a question nobody judged is not a question answered badly.
            unscored.append(question_id)
            per_question.append(
                {
                    "question_id": question_id,
                    "is_stub": False,
                    "scoring_failed": True,
                    "scoring_error": type(failure).__name__,
                    "items": [],
                }
            )
            continue
        result = results[question_id]
        any_graded = True
        if sop_coverage_check:
            missing = await sop_coverage.check_question_coverage(
                db,
                question_id=question_id,
                question_text=prompt_by_id.get(question_id, ""),
            )
            if missing:
                coverage_findings.append(
                    {
                        "question_id": question_id,
                        "question_text": prompt_by_id.get(question_id, ""),
                        "missing": missing,
                    }
                )
        q_weight = weight_by_id.get(question_id, 1)
        weighted_sum += result.score * q_weight
        weight_total += q_weight
        all_warnings.extend(result.warnings)
        graded_results.append(result)
        any_capped = any_capped or result.capped
        per_question.append(
            {
                "question_id": result.question_id,
                "score": result.score,
                "coverage_pct": result.coverage_pct,
                "grade": grade_for_score(result.score),
                "outcome": result.outcome,
                "capped": result.capped,
                "weight": q_weight,
                "items": [
                    {
                        "kind": it.kind,
                        "judgment": it.judgment,
                        "weight": it.weight,
                        "advisory": it.advisory,
                        "rationale": it.rationale,
                        "answer_quote": it.answer_quote,
                        "source_quote": it.source_quote,
                        "source_page": it.source_page,
                        # Clickable-citation anchors: the id the candidate SOP endpoint serves, and
                        # a display name for the link text. Both None/absent when the item has no
                        # linked SOP document (the report then shows plain source text, no link).
                        "source_document_id": it.source_document_id,
                        "source_document_name": doc_names.get(it.source_document_id),
                    }
                    for it in result.items
                ],
                "is_stub": False,
            }
        )

    # Interview-level score = weight-weighted mean of graded question scores (SPEC F8). Weights
    # default to 1, so an all-equal bank reproduces the historical simple mean; stub questions are
    # excluded from both numerator and denominator. Falls back to a plain count if every graded
    # question is weighted 0 (never divide by zero).
    if weight_total > 0:
        total_score = round(weighted_sum / weight_total, 1)
    elif graded_results:
        total_score = round(sum(r.score for r in graded_results) / len(graded_results), 1)
    else:
        total_score = 0.0

    # Interview-level classification: the natural outcome from the aggregate score, capped to "Needs
    # Improvement" if ANY graded question was capped by a confirmed critical error.
    outcome, outcome_capped = cap_outcome(outcome_for_score(total_score), critical_fired=any_capped)

    session.status = "scored"
    await db.commit()
    await db.refresh(session)

    yield {
        "type": "report",
        "report": {
            "interview_session_id": session.id,
            "status": session.status,
            "coverage_pct": total_score,
            "total_score": total_score,
            "grade": grade_for_score(total_score) if any_graded else None,
            "outcome": outcome if any_graded else None,
            "capped": outcome_capped,
            "narrative": build_narrative(graded_results) if any_graded else "",
            "per_question": per_question,
            "warnings": all_warnings,
            "is_stub": not any_graded,
            # Questions whose grading failed outright. Present only when there are any, so the
            # report can say "N questions could not be scored" instead of quietly averaging fewer
            # questions than the candidate answered. They are excluded from the score above, NOT
            # scored zero: an unjudged question is not a badly answered one (P7).
            "unscored_question_ids": unscored or None,
            # Feature D: present only when the opt-in check ran and found something; None otherwise
            # so the report renders the panel only when there are findings. Never affects scores.
            "sop_coverage": coverage_findings
            if (sop_coverage_check and coverage_findings)
            else None,
        },
    }


async def get_current_question(db: AsyncSession, session: InterviewSession) -> dict | None:
    """The question the candidate should answer now, or None if the interview is over.

    Candidate-safe projection (SPEC P3): only ``question_id`` / ``prompt`` / position — never the
    question's ``expected_points`` (those link to the rubric and stay interviewer-internal).
    """
    questions = await resolve_questions(db)
    q = question_at(questions, session.current_question_index)
    if q is None:
        return None
    # F7: when a follow-up is pending for this question, show ITS prompt (which cites the
    # candidate's prior answer) instead of the base question — that's the visible memory moment.
    follow_up = await _pending_follow_up_prompt(db, session.id, q.id)
    return {
        "question_id": q.id,
        "prompt": follow_up or q.prompt,
        "index": session.current_question_index,
        "total": len(questions),
        # Voice must NOT verbatim-read a follow-up: the agent's own server-VAD auto-response already
        # voices a clarification, so reading this too would speak it twice + duplicate the bubble.
        "is_follow_up": follow_up is not None,
        "follow_ups_asked": await _follow_ups_asked(db, session.id, q.id),
    }


async def _pending_follow_up_prompt(
    db: AsyncSession, session_id: str, question_id: str
) -> str | None:
    """The latest follow-up interviewer prompt for this question if it's still awaiting an answer.

    A follow-up is pending when the count of interviewer follow-up turns exceeds the count of
    candidate follow-up answers for the question — i.e. the last thing said was the follow-up.
    """
    turns = (
        (
            await db.execute(
                select(InterviewTurn)
                .where(
                    InterviewTurn.interview_session_id == session_id,
                    InterviewTurn.question_id == question_id,
                    InterviewTurn.turn_kind == "follow_up",
                )
                .order_by(InterviewTurn.turn_index)
            )
        )
        .scalars()
        .all()
    )
    asked = [t for t in turns if t.role == "interviewer"]
    answered = [t for t in turns if t.role == "candidate"]
    if len(asked) > len(answered):
        return asked[-1].content
    return None


async def _follow_ups_asked(db: AsyncSession, session_id: str, question_id: str) -> int:
    """Count follow-up interviewer turns already asked for ``question_id`` in this session."""
    rows = (
        (
            await db.execute(
                select(InterviewTurn.id).where(
                    InterviewTurn.interview_session_id == session_id,
                    InterviewTurn.question_id == question_id,
                    InterviewTurn.role == "interviewer",
                    InterviewTurn.turn_kind == "follow_up",
                )
            )
        )
        .scalars()
        .all()
    )
    return len(rows)


async def _next_turn_index(db: AsyncSession, session_id: str) -> int:
    turns = (
        (
            await db.execute(
                select(InterviewTurn.turn_index).where(
                    InterviewTurn.interview_session_id == session_id
                )
            )
        )
        .scalars()
        .all()
    )
    return (max(turns) + 1) if turns else 0


async def _candidate_answers(db: AsyncSession, session_id: str) -> list[tuple[str, str]]:
    """Candidate turns as (question_id, content) in turn order, grouped into one answer per
    question (main + 0..N follow_up joined) — see ``group_answers`` (F6 AC #4)."""
    rows = (
        (
            await db.execute(
                select(InterviewTurn)
                .where(
                    InterviewTurn.interview_session_id == session_id,
                    InterviewTurn.role == "candidate",
                )
                .order_by(InterviewTurn.turn_index)
            )
        )
        .scalars()
        .all()
    )
    return group_answers([(t.question_id, t.content) for t in rows])


async def cited_document_ids(db: AsyncSession, session: InterviewSession) -> set[str]:
    """The set of SOP document ids the candidate is allowed to open for THIS interview.

    Authorization scope for the candidate SOP endpoint (the clickable-citation feature): a document
    is reachable only if a default-checklist item of a question this interview actually answered
    cites it. This is the IDOR guard — a candidate cannot fetch an arbitrary SOP document id, only
    the specific sources behind their own report's citations. Returns an empty set (deny-all) for an
    interview with no cited sources.
    """
    answered_qids = {qid for qid, _ in await _candidate_answers(db, session.id)}
    if not answered_qids:
        return set()
    rows = (
        await db.execute(
            select(ChecklistItem.source_document_id)
            .join(Checklist, ChecklistItem.checklist_id == Checklist.id)
            .where(
                Checklist.question_id.in_(answered_qids),
                Checklist.is_default.is_(True),
                ChecklistItem.source_document_id.is_not(None),
            )
        )
    ).all()
    return {doc_id for (doc_id,) in rows if doc_id}


async def review_answers(db: AsyncSession, session: InterviewSession) -> list[dict]:
    """Every question that has a candidate answer, paired with that answer, in bank order.

    Powers the pre-scoring review screen (requirement 4). Reuses the SAME question_id join that
    ``score_and_finalize`` uses (``resolve_questions`` + ``_candidate_answers``), so the review list
    can never disagree with what gets scored, and the order matches the question bank exactly
    (requirement 2). Candidate-safe: only prompt + the grouped answer text, no rubric (P3).
    """
    questions = await resolve_questions(db)
    answers_by_id = dict(await _candidate_answers(db, session.id))
    out: list[dict] = []
    for index, q in enumerate(questions):
        answer_text = answers_by_id.get(q.id)
        if answer_text is None:
            continue
        out.append(
            {
                "question_id": q.id,
                "prompt": q.prompt,
                "index": index,
                "answer_text": answer_text,
            }
        )
    return out


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)
