"""Interview state machine unit tests (SPEC F6).

Exercises the channel-agnostic answer_finalized event and the status lifecycle directly against
the service, independent of the HTTP layer.
"""

import pytest

from app.interview import state_machine
from app.interview.questions import QUESTION_COUNT
from app.interview.state_machine import InterviewStateError
from app.services.anonymous_session_service import create_anonymous_session


async def _candidate(db):
    session, _ = await create_anonymous_session(db, ip_address="1.2.3.4")
    return session


@pytest.mark.asyncio
async def test_start_sets_in_progress_and_first_question(db_session):
    cand = await _candidate(db_session)
    interview = await state_machine.start_interview(db_session, cand.id)
    assert interview.status == "in_progress"
    assert interview.current_question_index == 0
    q = await state_machine.get_current_question(interview)
    assert q["index"] == 0
    assert q["total"] == QUESTION_COUNT


@pytest.mark.asyncio
async def test_full_progression_advances_then_completes(db_session):
    cand = await _candidate(db_session)
    interview = await state_machine.start_interview(db_session, cand.id)

    # Answer every question; each answer advances exactly one question.
    for i in range(QUESTION_COUNT):
        assert interview.current_question_index == i
        interview = await state_machine.answer_finalized(
            db_session, interview, f"answer number {i} with enough length", source="text"
        )

    assert interview.status == "completed"
    assert await state_machine.get_current_question(interview) is None


@pytest.mark.asyncio
async def test_voice_and_verbal_cue_use_same_event(db_session):
    cand = await _candidate(db_session)
    interview = await state_machine.start_interview(db_session, cand.id)
    interview = await state_machine.answer_finalized(
        db_session, interview, "spoken answer, long enough", source="voice"
    )
    assert interview.current_question_index == 1


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
    for _ in range(QUESTION_COUNT):
        interview = await state_machine.answer_finalized(
            db_session, interview, "long enough answer"
        )
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
    for i in range(QUESTION_COUNT):
        interview = await state_machine.answer_finalized(
            db_session, interview, f"answer {i} that is long enough to score"
        )
    report = await state_machine.score_and_finalize(db_session, interview)
    assert report["status"] == "scored"
    assert interview.status == "scored"
    assert len(report["per_question"]) == QUESTION_COUNT
    assert report["is_stub"] is True
