"""Interview state machine unit tests (SPEC F6).

Exercises the channel-agnostic answer_finalized event and the status lifecycle directly against
the service, independent of the HTTP layer.
"""

import pytest
from sqlalchemy import select

from app.interview import state_machine
from app.interview.questions import FALLBACK_QUESTIONS, question_at
from app.interview.state_machine import InterviewStateError
from app.models.interview import InterviewTurn
from app.services.anonymous_session_service import create_anonymous_session

# These unit tests run against a bare in-memory DB with no seeded bank, so the state machine
# resolves the built-in fallback set. Bind the expected shape to that (not a DB bank).
QUESTIONS = FALLBACK_QUESTIONS
QUESTION_COUNT = len(FALLBACK_QUESTIONS)


async def _turns(db, interview_id):
    return (
        (
            await db.execute(
                select(InterviewTurn)
                .where(InterviewTurn.interview_session_id == interview_id)
                .order_by(InterviewTurn.turn_index)
            )
        )
        .scalars()
        .all()
    )


# Index of the demo question that carries a follow-up, so tests don't hardcode a position.
_FOLLOW_UP_Q_INDEX = next(i for i, q in enumerate(QUESTIONS) if q.max_follow_ups > 0)


async def _candidate(db):
    session, _ = await create_anonymous_session(db, ip_address="1.2.3.4")
    return session


async def _answer_until_complete(db, interview, text="a sufficiently long answer for scoring"):
    """Drive the interview to completion, regardless of how many follow-ups fire (F6 AC #4)."""
    for _ in range(20):  # generous cap: a bug loops-out instead of hanging the suite
        if interview.status != "in_progress":
            break
        interview = await state_machine.answer_finalized(db, interview, text)
    return interview


@pytest.mark.asyncio
async def test_start_sets_in_progress_and_first_question(db_session):
    cand = await _candidate(db_session)
    interview = await state_machine.start_interview(db_session, cand.id)
    assert interview.status == "in_progress"
    assert interview.current_question_index == 0
    q = await state_machine.get_current_question(db_session, interview)
    assert q["index"] == 0
    assert q["total"] == QUESTION_COUNT


@pytest.mark.asyncio
async def test_full_progression_advances_then_completes(db_session):
    cand = await _candidate(db_session)
    interview = await state_machine.start_interview(db_session, cand.id)

    # A main answer to q1 (no follow-up) advances exactly one question.
    assert interview.current_question_index == 0
    interview = await state_machine.answer_finalized(
        db_session, interview, "answer with enough length", source="text"
    )
    assert interview.current_question_index == 1

    interview = await _answer_until_complete(db_session, interview)
    assert interview.status == "completed"
    assert await state_machine.get_current_question(db_session, interview) is None


@pytest.mark.asyncio
async def test_voice_and_verbal_cue_use_same_event(db_session):
    cand = await _candidate(db_session)
    interview = await state_machine.start_interview(db_session, cand.id)
    interview = await state_machine.answer_finalized(
        db_session, interview, "spoken answer, long enough", source="voice"
    )
    assert interview.current_question_index == 1


@pytest.mark.asyncio
async def test_answer_with_no_current_question_is_rejected(db_session):
    # Defensive guard: in_progress but the index has run past the question set (inconsistent state).
    cand = await _candidate(db_session)
    interview = await state_machine.start_interview(db_session, cand.id)
    interview.current_question_index = QUESTION_COUNT + 5
    with pytest.raises(InterviewStateError):
        await state_machine.answer_finalized(db_session, interview, "orphan answer")


@pytest.mark.asyncio
async def test_unknown_source_rejected(db_session):
    cand = await _candidate(db_session)
    interview = await state_machine.start_interview(db_session, cand.id)
    with pytest.raises(InterviewStateError):
        await state_machine.answer_finalized(db_session, interview, "x", source="carrier-pigeon")


@pytest.mark.asyncio
async def test_cannot_answer_after_completion(db_session):
    cand = await _candidate(db_session)
    interview = await state_machine.start_interview(db_session, cand.id)
    interview = await _answer_until_complete(db_session, interview)
    with pytest.raises(InterviewStateError):
        await state_machine.answer_finalized(db_session, interview, "too late")


@pytest.mark.asyncio
async def test_score_only_after_completed(db_session):
    cand = await _candidate(db_session)
    interview = await state_machine.start_interview(db_session, cand.id)
    with pytest.raises(InterviewStateError):
        await state_machine.score_and_finalize(db_session, interview)  # still in_progress


@pytest.mark.asyncio
async def test_score_completed_produces_report_and_flips_status(db_session):
    cand = await _candidate(db_session)
    interview = await state_machine.start_interview(db_session, cand.id)
    interview = await _answer_until_complete(db_session, interview)
    report = await state_machine.score_and_finalize(db_session, interview)
    assert report["status"] == "scored"
    assert interview.status == "scored"
    # Answers are grouped per question, so the report has one entry per question even though a
    # question generated a follow-up (F6 AC #4).
    assert len(report["per_question"]) == QUESTION_COUNT
    assert report["is_stub"] is True


# --- follow-up hook (F6 AC #4) ---------------------------------------------


@pytest.mark.asyncio
async def test_follow_up_stays_on_question_then_advances(db_session):
    cand = await _candidate(db_session)
    interview = await state_machine.start_interview(db_session, cand.id)

    # Advance to the question that has a follow-up.
    while interview.current_question_index < _FOLLOW_UP_Q_INDEX:
        interview = await state_machine.answer_finalized(
            db_session, interview, "long enough main answer"
        )
    fu_question = question_at(QUESTIONS, _FOLLOW_UP_Q_INDEX)
    assert fu_question is not None

    # First (main) answer to it must NOT advance — a follow-up is owed.
    interview = await state_machine.answer_finalized(
        db_session, interview, "my main answer, sufficiently long"
    )
    assert interview.current_question_index == _FOLLOW_UP_Q_INDEX

    # A follow-up interviewer turn was recorded for this question. F7: the follow-up references
    # the candidate's prior answer AND still carries the base probe.
    turns = await _turns(db_session, interview.id)
    fu_prompts = [
        t
        for t in turns
        if t.question_id == fu_question.id
        and t.role == "interviewer"
        and t.turn_kind == "follow_up"
    ]
    assert len(fu_prompts) == 1
    assert fu_question.follow_up_prompt in fu_prompts[0].content
    assert "my main answer" in fu_prompts[0].content  # cites what the candidate actually said

    # The follow-up answer is recorded as a follow_up candidate turn and now advances.
    prev_index = interview.current_question_index
    interview = await state_machine.answer_finalized(
        db_session, interview, "my follow-up elaboration, also long enough"
    )
    assert interview.current_question_index == prev_index + 1

    turns = await _turns(db_session, interview.id)
    fu_answers = [
        t
        for t in turns
        if t.question_id == fu_question.id and t.role == "candidate" and t.turn_kind == "follow_up"
    ]
    assert len(fu_answers) == 1


@pytest.mark.asyncio
async def test_follow_up_content_joins_answer_group_for_scoring(db_session):
    cand = await _candidate(db_session)
    interview = await state_machine.start_interview(db_session, cand.id)
    interview = await _answer_until_complete(db_session, interview)
    report = await state_machine.score_and_finalize(db_session, interview)

    # One scored entry per question, and each distinct question appears once (grouped).
    scored_qids = [q["question_id"] for q in report["per_question"]]
    assert len(scored_qids) == QUESTION_COUNT
    assert len(set(scored_qids)) == QUESTION_COUNT


# --- verbal cue as an answer source (F6 AC #3) -----------------------------


@pytest.mark.asyncio
async def test_verbal_cue_source_strips_cue_from_stored_answer(db_session):
    cand = await _candidate(db_session)
    interview = await state_machine.start_interview(db_session, cand.id)
    q1 = question_at(QUESTIONS, 0)
    assert q1 is not None

    interview = await state_machine.answer_finalized(
        db_session, interview, "this is my substantive answer, 我答完了", source="verbal_cue"
    )

    turns = await _turns(db_session, interview.id)
    answer = next(t for t in turns if t.question_id == q1.id and t.role == "candidate")
    # The cue phrase is transport signalling, not answer content — it must not be stored/scored.
    assert answer.source == "verbal_cue"
    assert "我答完了" not in answer.content
    assert "substantive answer" in answer.content


# --- empty-answer rejection (requirement 3) --------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("blank", ["", "   ", "\n\t "])
async def test_answer_finalized_rejects_empty_content(db_session, blank):
    # Defense in depth behind the API 422: an empty/whitespace answer must never advance the
    # interview or be stored as a silent blank ("未作答" in the report).
    cand = await _candidate(db_session)
    interview = await state_machine.start_interview(db_session, cand.id)
    with pytest.raises(InterviewStateError):
        await state_machine.answer_finalized(db_session, interview, blank)
    # Still on the first question — nothing advanced, no candidate answer recorded (only the
    # opening interviewer question turn exists).
    assert interview.current_question_index == 0
    turns = await _turns(db_session, interview.id)
    assert [t for t in turns if t.role == "candidate"] == []


@pytest.mark.asyncio
async def test_answer_finalized_rejects_verbal_cue_that_strips_to_empty(db_session):
    # A verbal-cue message that is ONLY the cue ("我答完了") strips to empty content — it must be
    # rejected, not stored as a blank answer that advances the interview.
    cand = await _candidate(db_session)
    interview = await state_machine.start_interview(db_session, cand.id)
    with pytest.raises(InterviewStateError):
        await state_machine.answer_finalized(db_session, interview, "我答完了", source="verbal_cue")
    assert interview.current_question_index == 0


# --- pre-scoring review (requirement 4) ------------------------------------


@pytest.mark.asyncio
async def test_review_answers_pairs_by_question_id_in_bank_order(db_session):
    # Requirement 2/4: review pairs each candidate answer to its question by explicit question_id
    # and returns them in bank order — the exact contract the frontend review screen relies on.
    cand = await _candidate(db_session)
    interview = await state_machine.start_interview(db_session, cand.id)
    interview = await _answer_until_complete(db_session, interview)
    assert interview.status == "completed"

    answers = await state_machine.review_answers(db_session, interview)
    assert answers, "a completed interview must have answers to review"
    # Bank order: indices are strictly ascending and each carries its own prompt + answer text.
    indices = [a["index"] for a in answers]
    assert indices == sorted(indices)
    for a in answers:
        assert a["question_id"]
        assert a["prompt"]
        assert a["answer_text"].strip()
    # Each returned question_id matches the bank question at that index (paired, not positional).
    for a in answers:
        bank_q = question_at(QUESTIONS, a["index"])
        assert bank_q is not None
        assert bank_q.id == a["question_id"]


# --- resume (F6 edge b) ----------------------------------------------------


@pytest.mark.asyncio
async def test_start_resumes_existing_in_progress_interview(db_session):
    """A second start for the same candidate resumes the live session, never orphans it (edge b)."""
    cand = await _candidate(db_session)
    first = await state_machine.start_interview(db_session, cand.id)
    # Advance a turn so the resumed session is mid-interview, not fresh.
    first = await state_machine.answer_finalized(db_session, first, "an answer of ample length")
    resumed = await state_machine.start_interview(db_session, cand.id)
    assert resumed.id == first.id  # same row — not a new session
    assert resumed.current_question_index == first.current_question_index


@pytest.mark.asyncio
async def test_find_resumable_returns_none_after_completion(db_session):
    """A completed interview is not resumable — a later start begins a fresh one (edge b)."""
    cand = await _candidate(db_session)
    interview = await state_machine.start_interview(db_session, cand.id)
    interview = await _answer_until_complete(db_session, interview)
    assert interview.status == "completed"
    assert await state_machine.find_resumable_interview(db_session, cand.id) is None
    fresh = await state_machine.start_interview(db_session, cand.id)
    assert fresh.id != interview.id  # a new session, since the old one is done


# --- multi follow-up (max_follow_ups >= 2) ---------------------------------


@pytest.mark.asyncio
async def test_two_follow_ups_asked_in_order_then_advances(db_session, monkeypatch):
    """A question with max_follow_ups=2 owes exactly two follow-ups before advancing."""
    from app.interview.questions import Question

    two = (
        Question(
            id="mfq", prompt="Main question?", max_follow_ups=2, follow_up_prompt="Tell me more"
        ),
        Question(id="tail", prompt="Last question?"),
    )

    async def _fake_resolve(_db):
        return two

    monkeypatch.setattr(state_machine, "resolve_questions", _fake_resolve)

    cand = await _candidate(db_session)
    interview = await state_machine.start_interview(db_session, cand.id)
    assert interview.current_question_index == 0

    # main answer → follow-up #1 owed, stay
    interview = await state_machine.answer_finalized(db_session, interview, "main answer, long")
    assert interview.current_question_index == 0
    # follow-up #1 answer → follow-up #2 owed, stay
    interview = await state_machine.answer_finalized(db_session, interview, "fu1 answer, long")
    assert interview.current_question_index == 0
    # follow-up #2 answer → both owed follow-ups done, advance
    interview = await state_machine.answer_finalized(db_session, interview, "fu2 answer, long")
    assert interview.current_question_index == 1

    turns = await _turns(db_session, interview.id)
    fu_asked = [
        t
        for t in turns
        if t.question_id == "mfq" and t.role == "interviewer" and t.turn_kind == "follow_up"
    ]
    assert len(fu_asked) == 2  # exactly two follow-ups were asked, no more


# --- empty question set (F6 edge a) ----------------------------------------


@pytest.mark.asyncio
async def test_empty_question_set_completes_immediately(db_session, monkeypatch):
    """Zero resolved questions → the interview starts completed, not a live session with no Q."""

    async def _no_questions(_db):
        return ()

    monkeypatch.setattr(state_machine, "resolve_questions", _no_questions)

    cand = await _candidate(db_session)
    interview = await state_machine.start_interview(db_session, cand.id)
    assert interview.status == "completed"  # defined terminal state, not stuck in_progress
    assert await state_machine.get_current_question(db_session, interview) is None
    turns = await _turns(db_session, interview.id)
    assert turns == []  # no interviewer turn written when there's nothing to ask
