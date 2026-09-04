"""Orchestration for the external interview brain (SPEC Phase 2, vendor-neutral).

The parallel of :mod:`app.interview.state_machine`, but for sessions whose ``brain_mode`` is
``external``: the built-in question bank is not consulted at all — the client's external interview
API/server owns the interview's progression, and we drive it turn-by-turn **as an API client**
(never a Foundry-agent tool) through :mod:`app.services.external_interview_client`.

Why a separate module (not a branch inside ``state_machine``): the two engines share nothing but
the ``InterviewSession``/``InterviewTurn`` rows. The bank machine derives progression from recorded
turns + a local question list; the external machine round-trips an **opaque state blob** and treats
the brain's ``session_complete`` as authoritative. Keeping them apart means the bank path — the
shipped, load-bearing one — is untouched by Phase 2.

Correctness spine (all three matter, all three are tested in the Slice-1 chaos suite):

1. **Submit-time turn lock (CAS).** A single guarded ``UPDATE ... WHERE turn_version = :seen AND
   external_phase = 'idle'`` atomically reserves the turn (bumps the version, flips to ``awaiting``)
   BEFORE any external call. Two distinct answers racing the same turn: exactly one UPDATE matches;
   the loser gets :class:`ExternalTurnConflict` (→ 409) and never reaches the brain. The version
   guard alone is sufficient under SQLite's serialized writers; the phase guard additionally blocks
   a submit while a turn is already in flight or while recovery is owed.

2. **Stateless + retry ⇒ pure function.** Because the brain is stateless and every attempt re-sends
   the SAME committed state + the SAME pending answer, a retry is a pure re-application
   ``f(committed_state, answer)`` — it can neither fork nor double-advance the interview. That is
   what makes bounded auto-retry (:data:`_RETRY_ATTEMPTS`) SAFE. Exhaustion is not a crash: it flips
   to ``recovery_required``, a resumable sub-state the candidate clears with an explicit 恢复.

3. **Commit-before-speech.** The new state blob + the candidate-safe last response are persisted
   atomically BEFORE the speech text is handed back. A crash after speaking but before persisting
   would otherwise replay a turn against stale state; committing first means resume always re-drives
   from a coherent point.

Privacy invariant (SPEC P3/P12): the opaque state blob (``final_session_state_json``) is
backend-only — it carries live per-question scores/rubric. It lives ONLY in
``InterviewSession.external_state``.
It is NEVER written to an ``InterviewTurn`` row, NEVER placed in ``external_last_response``, and
NEVER returned to the browser. Interviewer turns store the **scrubbed** ``display_text`` only.
"""

import json
import logging

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.interview.state_machine import find_resumable_interview
from app.models.interview import InterviewSession, InterviewTurn
from app.services.external_config_service import resolve_external_connection
from app.services.external_interview_client import (
    EVENT_END,
    EVENT_MESSAGE,
    EVENT_START,
    ExternalInterviewError,
    ExternalTurn,
    get_external_provider,
)

logger = logging.getLogger(__name__)

# Total attempts per external turn before flipping to recovery_required. Safe to retry because the
# brain is stateless and every attempt re-sends the same committed state + answer (see module docs).
_RETRY_ATTEMPTS = 2


class ExternalTurnConflict(Exception):
    """Raised when the CAS turn reservation loses the race (a concurrent submit, a submit while a
    turn is in flight, or a normal submit while recovery is owed). The route maps it to 409."""


# --------------------------------------------------------------------------- helpers


async def _next_turn_index(db: AsyncSession, session_id: str) -> int:
    """The next free ``turn_index`` for this session (max + 1, or 0). Mirrors the bank machine's
    private helper — re-implemented locally so the two engines stay decoupled."""
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


async def _interviewer_turn_count(db: AsyncSession, session_id: str) -> int:
    """How many interviewer turns (= questions the brain has posed) exist for this session.

    Doubles as the 0-based ordinal of the NEXT question, so the candidate-facing projection can show
    a stable "Question N" index without the external brain exposing a total (which it never does).
    """
    rows = (
        (
            await db.execute(
                select(InterviewTurn.id).where(
                    InterviewTurn.interview_session_id == session_id,
                    InterviewTurn.role == "interviewer",
                )
            )
        )
        .scalars()
        .all()
    )
    return len(rows)


async def _pending_candidate_input(db: AsyncSession, session_id: str) -> str | None:
    """The candidate answer awaiting a committed reply, or None.

    A committed turn always ends with an interviewer turn (the next question / completion), so the
    ONLY way the last turn is a candidate turn is a turn whose external call never committed — i.e.
    the pending answer to re-send on 恢复. Returns its content, or None when there is nothing
    pending (a healthy idle session, or a start that never posed a question).
    """
    last = (
        (
            await db.execute(
                select(InterviewTurn)
                .where(InterviewTurn.interview_session_id == session_id)
                .order_by(InterviewTurn.turn_index.desc())
            )
        )
        .scalars()
        .first()
    )
    if last is not None and last.role == "candidate":
        return last.content
    return None


def _select_provider(endpoint: str):
    """Live ``http`` provider when an endpoint is configured, else the deterministic ``mock`` (so
    CI/dev and a fresh, unconfigured deploy still exercise the whole flow without a gateway)."""
    return get_external_provider("http" if endpoint else "mock")


def _user_field(user_tag: str, session_id: str) -> str:
    """The gateway ``user`` field: the static per-deployment tag prepended to the anonymized session
    id. ``session_id`` is a random UUID (no PII), so this leaks nothing about the candidate."""
    return f"{user_tag}-{session_id}" if user_tag else session_id


def _public_snapshot(turn: ExternalTurn, *, question_index: int) -> dict:
    """The candidate-safe fields of a committed turn, for ``external_last_response`` (silent resume
    replay). Deliberately EXCLUDES ``state_blob`` — the opaque state never rides in this payload."""
    return {
        "speech_text": turn.speech_text,
        "display_text": turn.display_text,
        "session_complete": turn.session_complete,
        "index": question_index,
    }


async def _run_turn_with_retry(
    provider,
    *,
    endpoint: str,
    api_key: str,
    user: str,
    event: str,
    conversation_id: str,
    user_input: str,
    session_state_json: str,
) -> ExternalTurn:
    """Call the brain, retrying transport/protocol failures up to :data:`_RETRY_ATTEMPTS` times.

    Safe because each attempt re-sends the SAME committed state + answer (stateless ⇒ pure). Raises
    the last :class:`ExternalInterviewError` when every attempt fails; the caller then flips to
    ``recovery_required`` rather than surfacing the raw error.
    """
    last_exc: ExternalInterviewError | None = None
    for attempt in range(1, _RETRY_ATTEMPTS + 1):
        try:
            return await provider.run_turn(
                endpoint=endpoint,
                api_key=api_key,
                user=user,
                event=event,
                conversation_id=conversation_id,
                user_input=user_input,
                session_state_json=session_state_json,
            )
        except ExternalInterviewError as exc:
            last_exc = exc
            logger.warning(
                "external interview turn attempt %d/%d failed (event=%s): %s",
                attempt,
                _RETRY_ATTEMPTS,
                event,
                exc,
            )
    assert last_exc is not None  # the loop ran at least once, so a failure was recorded
    raise last_exc


async def _commit_turn(
    db: AsyncSession,
    session: InterviewSession,
    turn: ExternalTurn,
    *,
    question_index: int,
) -> None:
    """Commit-before-speech: atomically persist the new opaque state + candidate-safe last response,
    record the interviewer turn (scrubbed ``display_text`` — never the state blob), release the turn
    lock (``external_phase='idle'``), and flip to ``completed`` when the brain says so. One commit.
    """
    session.external_state = turn.state_blob
    if turn.conversation_id:
        session.external_conversation_id = turn.conversation_id
    session.external_last_response = json.dumps(
        _public_snapshot(turn, question_index=question_index), ensure_ascii=False
    )
    session.external_phase = "idle"

    # The interviewer turn carries ONLY the scrubbed, candidate-safe display text. A completion turn
    # may have empty display text — skip writing an empty interviewer turn in that case.
    if turn.display_text:
        db.add(
            InterviewTurn(
                interview_session_id=session.id,
                question_id=f"external-{question_index}",
                turn_index=await _next_turn_index(db, session.id),
                role="interviewer",
                turn_kind="main",
                source="text",
                content=turn.display_text,
            )
        )

    if turn.session_complete:
        session.status = "completed"
        session.completed_at = _now()

    await db.commit()
    await db.refresh(session)


async def _reserve_turn(
    db: AsyncSession, session: InterviewSession, *, seen_version: int, from_phases: tuple[str, ...]
) -> bool:
    """Atomically reserve the next turn via a single guarded UPDATE; return whether we won.

    The guard is BOTH the optimistic-lock version (``turn_version == seen_version``) AND the phase
    (``external_phase IN from_phases``). Under SQLite's serialized writers the version guard alone
    already makes two concurrent reservations mutually exclusive; the phase guard additionally
    rejects a submit while a turn is in flight (``awaiting``) or, for a normal answer, while a
    recovery is owed. On success we bump the version and flip to ``awaiting``; ``rowcount != 1``
    means a concurrent writer got there first (or the phase moved) — the caller raises
    :class:`ExternalTurnConflict`. Committed immediately so a racing reservation sees the new state.
    """
    result = await db.execute(
        update(InterviewSession)
        .where(
            InterviewSession.id == session.id,
            InterviewSession.turn_version == seen_version,
            InterviewSession.external_phase.in_(from_phases),
        )
        .values(external_phase="awaiting", turn_version=InterviewSession.turn_version + 1)
    )
    await db.commit()
    won = result.rowcount == 1
    if won:
        await db.refresh(session)
    return won


async def _mark_recovery_required(db: AsyncSession, session: InterviewSession) -> None:
    """Flip an in-flight turn to ``recovery_required`` after auto-retry exhaustion. The committed
    state is untouched (we never advanced it), so 恢复 re-drives from the last committed state."""
    session.external_phase = "recovery_required"
    await db.commit()
    await db.refresh(session)


# --------------------------------------------------------------------------- public API


async def start_interview(db: AsyncSession, candidate_session_id: str) -> InterviewSession:
    """Start (or resume) an external-brain interview for a candidate.

    Resume mirrors the bank machine: a still-``in_progress`` session for this candidate is returned
    as-is (its current question replays from ``external_last_response``; ``external_phase`` tells
    the UI whether a 恢复 is owed). A fresh start creates the session, snapshots
    ``brain_mode='external'`` and drives the brain's ``start`` turn. A start that fails after all
    retries is NOT a hard error: the
    session persists in ``recovery_required`` so the candidate can 恢复 (which re-drives ``start``),
    unifying the failure path with mid-interview recovery.
    """
    existing = await find_resumable_interview(db, candidate_session_id)
    if existing is not None:
        return existing

    session = InterviewSession(
        candidate_session_id=candidate_session_id,
        status="in_progress",
        current_question_index=0,
        brain_mode="external",
        external_phase="idle",
        turn_version=0,
    )
    session.started_at = _now()
    db.add(session)
    await db.flush()  # assign session.id before the first external call / turn write

    endpoint, api_key, user_tag = await resolve_external_connection(db)
    provider = _select_provider(endpoint)
    try:
        turn = await _run_turn_with_retry(
            provider,
            endpoint=endpoint,
            api_key=api_key,
            user=_user_field(user_tag, session.id),
            event=EVENT_START,
            conversation_id="",
            user_input="",
            session_state_json="",
        )
    except ExternalInterviewError:
        # Commit the session in a recoverable state rather than orphaning a half-created row.
        await _mark_recovery_required(db, session)
        return session

    await _commit_turn(db, session, turn, question_index=0)
    return session


async def answer(
    db: AsyncSession, session: InterviewSession, text: str, source: str = "text"
) -> InterviewSession:
    """Drive one external ``message`` turn: reserve → call (with retry) → commit-before-speech.

    Reserves the turn from ``idle`` (a submit while ``awaiting``/``recovery_required`` loses the CAS
    → :class:`ExternalTurnConflict` → 409). Records the candidate answer immediately (transcript +
    the pending-answer source for 恢复), then calls the brain with the committed state. On success,
    commits the new state and the next question. On retry exhaustion, flips to ``recovery_required``
    and returns (a resumable state, NOT an exception) so the UI shows the 恢复 affordance.
    """
    if session.status != "in_progress":
        raise ExternalTurnConflict(f"Cannot answer in status {session.status!r}")
    if session.brain_mode != "external":
        raise ExternalTurnConflict("Not an external-brain session")

    if not await _reserve_turn(
        db, session, seen_version=session.turn_version, from_phases=("idle",)
    ):
        raise ExternalTurnConflict("Another answer is already being processed for this turn")

    # Record the candidate answer now: it's the transcript truth AND the pending-answer source that
    # 恢复 re-sends if the call below fails. It carries no rubric/state, so recording it early is
    # safe — only the opaque STATE advances at commit, gated behind a successful call.
    db.add(
        InterviewTurn(
            interview_session_id=session.id,
            question_id=f"external-{await _interviewer_turn_count(db, session.id)}",
            turn_index=await _next_turn_index(db, session.id),
            role="candidate",
            turn_kind="main",
            source=source,
            content=text,
        )
    )
    await db.commit()
    await db.refresh(session)

    endpoint, api_key, user_tag = await resolve_external_connection(db)
    provider = _select_provider(endpoint)
    try:
        turn = await _run_turn_with_retry(
            provider,
            endpoint=endpoint,
            api_key=api_key,
            user=_user_field(user_tag, session.id),
            event=EVENT_MESSAGE,
            conversation_id=session.external_conversation_id or "",
            user_input=text,
            session_state_json=session.external_state or "",
        )
    except ExternalInterviewError:
        await _mark_recovery_required(db, session)
        return session

    # The next question's ordinal = interviewer turns already recorded (the candidate turn above is
    # a candidate turn, so it doesn't shift this count).
    await _commit_turn(
        db, session, turn, question_index=await _interviewer_turn_count(db, session.id)
    )
    return session


async def recover(db: AsyncSession, session: InterviewSession) -> InterviewSession:
    """Clear a ``recovery_required``/``awaiting`` external session by re-driving the pending turn.

    Idempotent-by-construction: it re-sends the SAME committed state + the SAME pending answer (the
    last uncommitted candidate turn), so re-driving cannot double-advance. Reserves from
    ``recovery_required``/``awaiting`` (a normal ``idle`` session has nothing to recover → 409).
    With no pending answer (a ``start`` that never posed a question), it re-drives ``start``.
    On repeated failure it stays ``recovery_required`` (the candidate may 恢复 again).
    """
    if session.status != "in_progress":
        raise ExternalTurnConflict(f"Cannot recover in status {session.status!r}")
    if session.brain_mode != "external":
        raise ExternalTurnConflict("Not an external-brain session")

    if not await _reserve_turn(
        db,
        session,
        seen_version=session.turn_version,
        from_phases=("recovery_required", "awaiting"),
    ):
        raise ExternalTurnConflict("Nothing to recover, or a recovery is already in progress")

    pending = await _pending_candidate_input(db, session.id)
    event = EVENT_MESSAGE if pending is not None else EVENT_START

    endpoint, api_key, user_tag = await resolve_external_connection(db)
    provider = _select_provider(endpoint)
    try:
        turn = await _run_turn_with_retry(
            provider,
            endpoint=endpoint,
            api_key=api_key,
            user=_user_field(user_tag, session.id),
            event=event,
            conversation_id=session.external_conversation_id or "",
            user_input=pending or "",
            session_state_json=session.external_state or "",
        )
    except ExternalInterviewError:
        await _mark_recovery_required(db, session)
        return session

    await _commit_turn(
        db, session, turn, question_index=await _interviewer_turn_count(db, session.id)
    )
    return session


async def end(db: AsyncSession, session: InterviewSession) -> InterviewSession:
    """Signal the brain to finalize early (event ``end``) and mark the session completed.

    Reserves the turn from ``idle`` so it can't collide with an in-flight answer. On a transport
    failure it still marks the session ``completed`` locally (the candidate asked to stop; we don't
    strand them behind the gateway) — the brain's own state simply won't get the ``end`` signal.
    """
    if session.status != "in_progress" or session.brain_mode != "external":
        return session

    if not await _reserve_turn(
        db, session, seen_version=session.turn_version, from_phases=("idle",)
    ):
        raise ExternalTurnConflict("A turn is already being processed")

    endpoint, api_key, user_tag = await resolve_external_connection(db)
    provider = _select_provider(endpoint)
    try:
        turn = await _run_turn_with_retry(
            provider,
            endpoint=endpoint,
            api_key=api_key,
            user=_user_field(user_tag, session.id),
            event=EVENT_END,
            conversation_id=session.external_conversation_id or "",
            user_input="",
            session_state_json=session.external_state or "",
        )
    except ExternalInterviewError:
        session.external_phase = "idle"
        session.status = "completed"
        session.completed_at = _now()
        await db.commit()
        await db.refresh(session)
        return session

    # Force completion regardless of the brain's flag — the candidate explicitly ended.
    await _commit_turn(
        db, session, turn, question_index=await _interviewer_turn_count(db, session.id)
    )
    if session.status != "completed":
        session.status = "completed"
        session.completed_at = _now()
        await db.commit()
        await db.refresh(session)
    return session


async def current_question(db: AsyncSession, session: InterviewSession) -> dict | None:
    """Candidate-safe projection of the question the candidate should answer now, or None.

    Reads the last committed public response (``external_last_response``) — never the state blob.
    Returns None when the interview is over (completed/scored, or the last turn was a completion).
    ``total`` is 0: the external brain does not expose a question count, so the UI shows progress
    without a denominator. ``prompt`` prefers the display text, falling back to the speech text.
    """
    if session.status != "in_progress":
        return None
    if not session.external_last_response:
        return None
    try:
        data = json.loads(session.external_last_response)
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict) or data.get("session_complete"):
        return None
    prompt = data.get("display_text") or data.get("speech_text") or ""
    if not prompt:
        return None
    index = int(data.get("index", 0))
    return {
        "question_id": f"external-{index}",
        "prompt": prompt,
        "index": index,
        "total": 0,
        "is_follow_up": False,
    }


async def review_answers(db: AsyncSession, session: InterviewSession) -> list[dict]:
    """Every posed question paired with the answer that followed it, in turn order.

    The external analogue of ``state_machine.review_answers``: built ENTIRELY from recorded turns
    (interviewer ``display_text`` = the question, the next candidate turn = the answer) so it can
    never touch the opaque state blob or any score/rubric (SPEC P3/P12 — candidate-safe only). The
    order follows the interview as it happened; a trailing question with no answer yet is omitted.
    """
    turns = (
        (
            await db.execute(
                select(InterviewTurn)
                .where(InterviewTurn.interview_session_id == session.id)
                .order_by(InterviewTurn.turn_index)
            )
        )
        .scalars()
        .all()
    )
    out: list[dict] = []
    pending_question: InterviewTurn | None = None
    index = 0
    for turn in turns:
        if turn.role == "interviewer":
            pending_question = turn
        elif turn.role == "candidate" and pending_question is not None:
            out.append(
                {
                    "question_id": pending_question.question_id,
                    "prompt": pending_question.content,
                    "index": index,
                    "answer_text": turn.content,
                }
            )
            index += 1
            pending_question = None
    return out


def speech_text_for(session: InterviewSession) -> str | None:
    """The last committed turn's speech text (for TTS/voice reading), or None. Candidate-safe."""
    if not session.external_last_response:
        return None
    try:
        data = json.loads(session.external_last_response)
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None
    return data.get("speech_text") or None


async def probe_connection(db: AsyncSession) -> tuple[bool, str]:
    """Health-probe the configured external brain WITHOUT creating any interview rows.

    Sends a single ``start`` turn with a ``{user_tag}-healthcheck`` user id, reporting reachability.
    Used by the admin test-connection button. Creates no ``InterviewSession``/``InterviewTurn`` — it
    only exercises the transport, so an admin can validate the endpoint+key before a candidate ever
    connects. Returns ``(ok, detail)``.
    """
    endpoint, api_key, user_tag = await resolve_external_connection(db)
    if not endpoint:
        return False, "No external interview endpoint configured"
    provider = _select_provider(endpoint)
    user = f"{user_tag}-healthcheck" if user_tag else "healthcheck"
    try:
        await provider.run_turn(
            endpoint=endpoint,
            api_key=api_key,
            user=user,
            event=EVENT_START,
            conversation_id="",
            user_input="",
            session_state_json="",
        )
    except ExternalInterviewError as exc:
        return False, str(exc)
    return True, "OK"


def _now():
    """Naive-UTC now, matching the bank machine's timestamp convention (see state_machine._now)."""
    from datetime import UTC, datetime

    return datetime.now(UTC).replace(tzinfo=None)
