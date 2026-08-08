"""Turn-by-turn interview state machine (SPEC F6), Step 0 thin slice.

Channel-agnostic by design (SPEC P9): text submit, voice end-of-utterance, and verbal-cue
finalization all converge on ONE event — ``answer_finalized(db, session, text, source)``. The
three producers differ only in how they detect end-of-answer (transport); the progression logic
is shared through this single entry point, not through a forced shared abstraction.

Step 0 scope: main turns only (no follow-ups yet — the hook is reserved in F6/F7). Status
lifecycle enforced: created → in_progress → completed → scored.
"""

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.interview.questions import QUESTION_COUNT, get_question
from app.interview.scoring import score_interview
from app.models.interview import InterviewSession, InterviewTurn

# Sources that can finalize an answer (P9). All route through answer_finalized().
ANSWER_SOURCES = ("text", "voice", "verbal_cue")


class InterviewStateError(Exception):
    """Raised on an illegal state transition (e.g. answering a completed interview)."""


async def start_interview(db: AsyncSession, candidate_session_id: str) -> InterviewSession:
    """Create a session and record the first interviewer turn (asking question 1)."""
    session = InterviewSession(
        candidate_session_id=candidate_session_id,
        status="in_progress",
        current_question_index=0,
    )
    session.started_at = _now()
    db.add(session)
    await db.flush()  # assign session.id before writing the turn (avoids a second round-trip)

    first = get_question(0)
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
    await db.commit()
    await db.refresh(session)
    return session


async def answer_finalized(
    db: AsyncSession, session: InterviewSession, text: str, source: str = "text"
) -> InterviewSession:
    """The single channel-agnostic finalization event (P9).

    Records the candidate turn for the current question, then advances: if more questions
    remain, records the next interviewer turn; otherwise marks the interview completed.
    """
    if source not in ANSWER_SOURCES:
        raise InterviewStateError(f"Unknown answer source {source!r}")
    if session.status != "in_progress":
        raise InterviewStateError(f"Cannot answer in status {session.status!r}")

    current = get_question(session.current_question_index)
    if current is None:
        raise InterviewStateError("No current question to answer")

    next_turn_index = await _next_turn_index(db, session.id)
    db.add(
        InterviewTurn(
            interview_session_id=session.id,
            question_id=current.id,
            turn_index=next_turn_index,
            role="candidate",
            turn_kind="main",
            source=source,
            content=text,
        )
    )

    session.current_question_index += 1
    following = get_question(session.current_question_index)
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


async def score_and_finalize(db: AsyncSession, session: InterviewSession) -> dict:
    """Score a completed interview and flip status to ``scored``, returning a report dict.

    Step 0 placeholder report (SPEC F8 shape, stub scoring from F4-stub). Only allowed once the
    interview is ``completed`` (F8 AC #4: report only when scored).
    """
    if session.status not in ("completed", "scored"):
        raise InterviewStateError(f"Cannot score in status {session.status!r}")

    answers = await _candidate_answers(db, session.id)
    result = score_interview(answers)

    session.status = "scored"
    await db.commit()
    await db.refresh(session)

    return {
        "interview_session_id": session.id,
        "status": session.status,
        "coverage_pct": result.coverage_pct,
        "per_question": result.per_question,
        "is_stub": result.is_stub,
    }


async def get_current_question(session: InterviewSession) -> dict | None:
    """The question the candidate should answer now, or None if the interview is over."""
    q = get_question(session.current_question_index)
    if q is None:
        return None
    return {
        "question_id": q.id,
        "prompt": q.prompt,
        "index": session.current_question_index,
        "total": QUESTION_COUNT,
    }


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
    return [(t.question_id, t.content) for t in rows]


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)
