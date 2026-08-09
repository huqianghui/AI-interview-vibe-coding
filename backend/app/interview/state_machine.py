"""Turn-by-turn interview state machine (SPEC F6), Step 0 thin slice.

Channel-agnostic by design (SPEC P9): text submit, voice end-of-utterance, and verbal-cue
finalization all converge on ONE event — ``answer_finalized(db, session, text, source)``. The
three producers differ only in how they detect end-of-answer (transport); the progression logic
is shared through this single entry point, not through a forced shared abstraction.

Follow-up hook (F6 AC #4): a question may generate up to ``max_follow_ups`` follow-up turns.
The progression ``asking → answering → (follow_up × 0..N) → judged → next`` is derived from the
turns already recorded — ``current_question_index`` names the question, and the count of
follow-up interviewer turns for it tells us whether the next answer is a ``main`` or a
``follow_up`` and whether another follow-up is owed. All follow-up content joins that question's
answer group for scoring (see ``app.interview.scoring.group_answers``).

Status lifecycle enforced: created → in_progress → completed → scored.
"""

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.interview.memory import build_follow_up_prompt
from app.interview.questions import question_at, resolve_questions
from app.interview.scoring import group_answers
from app.interview.scoring_engine import build_narrative, grade_for_score
from app.interview.verbal_cue import strip_verbal_cue
from app.models.interview import InterviewSession, InterviewTurn
from app.services import scoring_service

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
    await db.commit()
    await db.refresh(session)
    return session


async def answer_finalized(
    db: AsyncSession, session: InterviewSession, text: str, source: str = "text"
) -> InterviewSession:
    """The single channel-agnostic finalization event (P9).

    Records the candidate turn for the current question. If the question still owes a follow-up,
    records the follow-up interviewer turn and stays on the same question (the next answer will be
    a ``follow_up`` turn joining this question's answer group). Otherwise advances: records the
    next question's interviewer turn, or marks the interview completed when none remain.
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

    if follow_ups_asked < current.max_follow_ups:
        # Owe another follow-up: ask it and stay on this question. F7 memory moment — the follow-up
        # references what the candidate just said (from this turn's content), so the interviewer
        # visibly remembers across turns rather than asking a canned probe.
        follow_up_text = build_follow_up_prompt(
            current.follow_up_prompt, content, locale=_infer_locale(content)
        )
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


async def score_and_finalize(db: AsyncSession, session: InterviewSession) -> dict:
    """Score a completed interview against each question's checklist and flip status to ``scored``.

    F4: each answer is graded against its question's default checklist into a 4-state judgment per
    item with SOP + answer quotes (the traceable, weighted score the demo leads with). A question
    with no checklist authored yet falls back to the length-based stub row, so the report always
    covers every question. Only allowed once ``completed`` (F8 AC #4: report only when scored).
    """
    if session.status not in ("completed", "scored"):
        raise InterviewStateError(f"Cannot score in status {session.status!r}")

    # question_id → prompt text, so the scorer can build a cross-language judging prompt.
    questions = await resolve_questions(db)
    prompt_by_id = {q.id: q.prompt for q in questions}
    answers = await _candidate_answers(db, session.id)

    per_question: list[dict] = []
    question_scores: list[float] = []
    all_warnings: list[str] = []
    graded_results: list = []
    any_graded = False

    for question_id, answer_text in answers:
        result = await scoring_service.score_answer_against_checklist(
            db,
            question_id=question_id,
            question_text=prompt_by_id.get(question_id, ""),
            answer_text=answer_text,
        )
        if result is None:
            # No checklist authored for this question — length-based stub row.
            per_question.append(scoring_service.stub_result_dict(question_id, answer_text))
            continue
        any_graded = True
        question_scores.append(result.score)
        all_warnings.extend(result.warnings)
        graded_results.append(result)
        per_question.append(
            {
                "question_id": result.question_id,
                "score": result.score,
                "coverage_pct": result.coverage_pct,
                "grade": grade_for_score(result.score),
                "items": [
                    {
                        "kind": it.kind,
                        "judgment": it.judgment,
                        "weight": it.weight,
                        "rationale": it.rationale,
                        "answer_quote": it.answer_quote,
                        "source_quote": it.source_quote,
                        "source_page": it.source_page,
                    }
                    for it in result.items
                ],
                "is_stub": False,
            }
        )

    # Interview-level score = mean of graded question scores; coverage mirrors it (F8 aggregates).
    total_score = round(sum(question_scores) / len(question_scores), 1) if question_scores else 0.0

    session.status = "scored"
    await db.commit()
    await db.refresh(session)

    return {
        "interview_session_id": session.id,
        "status": session.status,
        "coverage_pct": total_score,
        "total_score": total_score,
        "grade": grade_for_score(total_score) if any_graded else None,
        "narrative": build_narrative(graded_results) if any_graded else "",
        "per_question": per_question,
        "warnings": all_warnings,
        "is_stub": not any_graded,
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
    prompt = await _pending_follow_up_prompt(db, session.id, q.id) or q.prompt
    return {
        "question_id": q.id,
        "prompt": prompt,
        "index": session.current_question_index,
        "total": len(questions),
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


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _infer_locale(text: str) -> str:
    """Rough locale for the follow-up lead-in: zh-CN if the answer is mostly CJK, else en-US.

    The follow-up should read back in the candidate's language; a per-answer heuristic avoids
    threading bank/persona locale through the finalize path for what is a cosmetic lead-in.
    """
    cjk = sum(1 for ch in text if "一" <= ch <= "鿿")
    letters = sum(1 for ch in text if ch.isalpha())
    return "zh-CN" if cjk and cjk >= letters else "en-US"
