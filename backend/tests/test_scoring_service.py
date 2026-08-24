"""LLM-backed scoring (SPEC F4): scoring against a real checklist via the mock LLM, the
cross-language path, retry-on-incomplete, and end-to-end scoring through the state machine."""

import json

import pytest

from app.interview import scoring_engine, state_machine
from app.services import checklist_service, question_service, scoring_service
from app.services.anonymous_session_service import create_anonymous_session


async def _question_with_checklist(db, *, text="Describe the safety procedure.", points=None):
    bank = await question_service.create_bank(db, name="B", is_default=True)
    q = await question_service.add_question(
        db,
        bank_id=bank.id,
        text=text,
        order_index=0,
        expected_points=json.dumps(points or []),
    )
    await checklist_service.draft_checklist(db, q.id)  # mock LLM drafts a 3-item checklist
    return q


@pytest.mark.asyncio
async def test_score_answer_returns_none_without_checklist(db_session):
    bank = await question_service.create_bank(db_session, name="B", is_default=True)
    q = await question_service.add_question(db_session, bank_id=bank.id, text="hi", order_index=0)
    result = await scoring_service.score_answer_against_checklist(
        db_session, question_id=q.id, question_text="hi", answer_text="an answer here"
    )
    assert result is None  # no checklist → caller falls back to stub


@pytest.mark.asyncio
async def test_score_answer_against_checklist_via_mock_llm(db_session):
    q = await _question_with_checklist(db_session)
    result = await scoring_service.score_answer_against_checklist(
        db_session,
        question_id=q.id,
        question_text=q.text,
        answer_text="I followed the documented steps in order and explained my reasoning clearly.",
    )
    assert result is not None
    # Mock judges required/recommended met, forbidden not_met → weighted score 100.
    assert result.score == 100.0
    # Every checklist item got a judgment with the SOP source carried through.
    assert len(result.items) == 3
    assert any(it.source_quote for it in result.items)


@pytest.mark.asyncio
async def test_cross_language_english_sop_chinese_answer(db_session):
    # AC #4: an English-SOP checklist scores a Chinese answer (mock is language-agnostic; this
    # proves the path runs end to end without a language guard blocking it).
    q = await _question_with_checklist(db_session, text="Describe the safety procedure.")
    result = await scoring_service.score_answer_against_checklist(
        db_session,
        question_id=q.id,
        question_text=q.text,
        answer_text="我严格按照文档步骤操作，并说明了每一步的理由。",
    )
    assert result is not None
    assert result.score == 100.0


@pytest.mark.asyncio
async def test_retry_on_incomplete_then_gives_up(db_session, monkeypatch):
    q = await _question_with_checklist(db_session)

    class _IncompleteLLM:
        name = "incomplete"
        calls = 0

        async def complete(self, prompt, *, json_mode=False):
            type(self).calls += 1
            return json.dumps({"judgments": []})  # never judges any item

        async def stream(self, prompt):
            yield ""

    llm = _IncompleteLLM()
    monkeypatch.setattr(scoring_service, "get_llm_adapter", lambda name=None: llm)
    with pytest.raises(scoring_engine.ScoringIncomplete):
        await scoring_service.score_answer_against_checklist(
            db_session, question_id=q.id, question_text=q.text, answer_text="a long enough answer"
        )
    assert llm.calls == scoring_service.MAX_SCORING_ATTEMPTS  # retried before giving up


# --- end-to-end through the state machine ----------------------------------


@pytest.mark.asyncio
async def test_interview_scored_against_checklist_reports_items(db_session):
    await _question_with_checklist(db_session, points=["mentions PPE"])
    cand, _ = await create_anonymous_session(db_session, ip_address="1.2.3.4")
    interview = await state_machine.start_interview(db_session, cand.id)
    interview = await state_machine.answer_finalized(
        db_session, interview, "I followed each documented step and checked safety.", source="text"
    )
    assert interview.status == "completed"

    report = await state_machine.score_and_finalize(db_session, interview)
    assert report["status"] == "scored"
    assert report["is_stub"] is False  # graded against a real checklist
    assert report["grade"] in ("A", "B", "C", "D", "F")
    entry = report["per_question"][0]
    assert entry["is_stub"] is False
    assert entry["items"]  # per-item judgments present
    for item in entry["items"]:
        assert item["judgment"] in scoring_engine.JUDGMENTS
        assert "source_quote" in item and "answer_quote" in item


@pytest.mark.asyncio
async def test_report_carries_outcome_classification(db_session):
    # F8: a graded report exposes the classification outcome alongside the letter grade.
    await _question_with_checklist(db_session, points=["mentions PPE"])
    cand, _ = await create_anonymous_session(db_session, ip_address="1.2.3.4")
    interview = await state_machine.start_interview(db_session, cand.id)
    interview = await state_machine.answer_finalized(
        db_session, interview, "I followed each documented step and checked safety.", source="text"
    )
    report = await state_machine.score_and_finalize(db_session, interview)
    # Mock judges everything met → score 100 → Meets Expectations, no cap.
    assert report["outcome"] == scoring_engine.MEETS_EXPECTATIONS
    assert report["capped"] is False
    entry = report["per_question"][0]
    assert entry["outcome"] == scoring_engine.MEETS_EXPECTATIONS
    assert entry["capped"] is False
    assert entry["weight"] == 1  # default equal weighting


@pytest.mark.asyncio
async def test_interview_level_weighted_mean_of_question_scores(db_session, monkeypatch):
    # Two questions with unequal weight: the interview score is the weighted mean, not the simple
    # mean. Question A (weight 3) scores 100; question B (weight 1) scores 0.
    bank = await question_service.create_bank(db_session, name="W", is_default=True)
    qa = await question_service.add_question(
        db_session, bank_id=bank.id, text="Question A?", order_index=0, weight=3
    )
    qb = await question_service.add_question(
        db_session, bank_id=bank.id, text="Question B?", order_index=1, weight=1
    )
    await checklist_service.draft_checklist(db_session, qa.id)
    await checklist_service.draft_checklist(db_session, qb.id)

    # Score qa=100 (all met), qb=0 (all not_met) by keying the mock on the question id.
    real = scoring_service.enforce_and_score

    def _keyed(question_id, answer_text, rubric, raw):
        if question_id == qb.id:
            raw = [{"item_id": it.item_id, "judgment": "not_met"} for it in rubric]
        return real(question_id, answer_text, rubric, raw)

    monkeypatch.setattr(scoring_service, "enforce_and_score", _keyed)

    cand, _ = await create_anonymous_session(db_session, ip_address="1.2.3.4")
    interview = await state_machine.start_interview(db_session, cand.id)
    while interview.status != "completed":
        interview = await state_machine.answer_finalized(
            db_session, interview, "a sufficiently detailed answer for scoring", source="text"
        )
    report = await state_machine.score_and_finalize(db_session, interview)
    # Weighted mean = (100*3 + 0*1) / 4 = 75, NOT the simple mean 50.
    assert report["total_score"] == 75.0
    by_q = {e["question_id"]: e for e in report["per_question"]}
    assert by_q[qa.id]["weight"] == 3
    assert by_q[qb.id]["weight"] == 1


@pytest.mark.asyncio
async def test_interview_without_checklist_falls_back_to_stub(db_session):
    # No checklist drafted → report uses the stub rows, is_stub True (unchanged F6 behavior).
    bank = await question_service.create_bank(db_session, name="B", is_default=True)
    await question_service.add_question(db_session, bank_id=bank.id, text="Q1?", order_index=0)
    cand, _ = await create_anonymous_session(db_session, ip_address="1.2.3.4")
    interview = await state_machine.start_interview(db_session, cand.id)
    interview = await state_machine.answer_finalized(
        db_session, interview, "a sufficiently detailed answer", source="text"
    )
    report = await state_machine.score_and_finalize(db_session, interview)
    assert report["is_stub"] is True
    assert report["per_question"][0]["is_stub"] is True
