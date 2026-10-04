"""LLM-backed scoring (SPEC F4): scoring against a real checklist via the mock LLM, the
cross-language path, retry-on-incomplete, and end-to-end scoring through the state machine."""

import asyncio
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


# --- resilience: bounded calls, merge-across-attempts, per-question isolation ----------------
#
# These four cover the 2026-10-04 live failure: one stalled scoring call went silent for 270 s,
# Azure Container Apps' ingress disconnected the idle request with `504 stream timeout`, and the
# candidate lost the whole report including the three questions that had already graded.


@pytest.mark.asyncio
async def test_stalled_call_is_cut_not_hung(db_session, monkeypatch):
    """A call that never returns must raise, not hang. Without the timeout this test never ends."""
    q = await _question_with_checklist(db_session)

    class _HangingLLM:
        name = "hanging"
        calls = 0

        async def complete(self, prompt, *, json_mode=False):
            type(self).calls += 1
            await asyncio.sleep(3600)  # the stall that killed the live report

        async def stream(self, prompt):
            yield ""

    llm = _HangingLLM()
    monkeypatch.setattr(scoring_service, "get_llm_adapter", lambda name=None: llm)
    monkeypatch.setattr(scoring_service, "SCORING_CALL_TIMEOUT_SECONDS", 0.05)

    with pytest.raises(TimeoutError):
        await scoring_service.score_answer_against_checklist(
            db_session, question_id=q.id, question_text=q.text, answer_text="a long enough answer"
        )
    # Cut on every attempt rather than on the first one only.
    assert llm.calls == scoring_service.MAX_SCORING_ATTEMPTS


@pytest.mark.asyncio
async def test_retry_re_asks_only_the_missing_items_and_keeps_the_partial_answer(
    db_session, monkeypatch
):
    """A first attempt that judges all-but-one item must not be thrown away.

    The old loop re-sent the whole checklist with a "judge ALL of them" suffix and discarded the
    partial result, so the retry had the same full-size job to get right. Now the retry is handed
    ONLY the unjudged item, and the judgments merge.
    """
    q = await _question_with_checklist(db_session)
    checklist = await checklist_service.get_default_checklist(db_session, q.id)
    items = await checklist_service.list_items(db_session, checklist.id)
    assert len(items) >= 2, "fixture needs a multi-item checklist to drop one"
    dropped = items[-1].id

    class _DropsOneLLM:
        name = "drops-one"

        def __init__(self):
            self.prompts: list[str] = []

        async def complete(self, prompt, *, json_mode=False):
            self.prompts.append(prompt)
            if len(self.prompts) == 1:
                judged = [it for it in items if it.id != dropped]  # omit exactly one
            else:
                judged = [it for it in items if it.id == dropped]  # the re-ask
            return json.dumps(
                {
                    "judgments": [
                        {"item_id": it.id, "judgment": "met", "rationale": "r", "answer_quote": "q"}
                        for it in judged
                    ]
                }
            )

        async def stream(self, prompt):
            yield ""

    llm = _DropsOneLLM()
    monkeypatch.setattr(scoring_service, "get_llm_adapter", lambda name=None: llm)

    result = await scoring_service.score_answer_against_checklist(
        db_session, question_id=q.id, question_text=q.text, answer_text="a long enough answer"
    )
    # Every item judged, from the two attempts merged — not from one attempt getting it all right.
    assert len(result.items) == len(items)
    assert len(llm.prompts) == 2
    # The retry prompt carries ONLY the missing item, so the model cannot omit what it never saw.
    retry = llm.prompts[1]
    assert dropped in retry
    assert sum(1 for it in items if it.id in retry) == 1


@pytest.mark.asyncio
async def test_one_failing_question_does_not_discard_the_rest_of_the_report(
    db_session, monkeypatch
):
    """Per-question isolation: Q2 failing must not cost the candidate Q1 and Q3.

    This is the behaviour the live failure violated — the stream died on question 4 and the three
    already-graded questions went with it.
    """
    bank = await question_service.create_bank(db_session, name="B", is_default=True)
    qs = []
    for i in range(3):
        q = await question_service.add_question(
            db_session, bank_id=bank.id, text=f"Q{i + 1}?", order_index=i
        )
        await checklist_service.draft_checklist(db_session, q.id)
        qs.append(q)

    real = scoring_service.score_answer_against_checklist

    async def _fail_on_second(db, *, question_id, question_text, answer_text, **kw):
        if question_id == qs[1].id:
            raise scoring_engine.ScoringIncomplete("LLM did not judge checklist item 'x'")
        return await real(
            db,
            question_id=question_id,
            question_text=question_text,
            answer_text=answer_text,
            **kw,
        )

    monkeypatch.setattr(
        state_machine.scoring_service, "score_answer_against_checklist", _fail_on_second
    )

    cand, _ = await create_anonymous_session(db_session, ip_address="1.2.3.4")
    session = await state_machine.start_interview(db_session, cand.id)
    for _ in qs:
        session = await state_machine.answer_finalized(
            db_session, session, "a long enough answer to score", source="text"
        )

    events = [e async for e in state_machine.score_and_finalize_events(db_session, session)]
    report = next(e["report"] for e in events if e["type"] == "report")

    # The report exists at all — that is the fix.
    assert report["per_question"] and len(report["per_question"]) == 3
    failed = [r for r in report["per_question"] if r.get("scoring_failed")]
    assert [r["question_id"] for r in failed] == [qs[1].id]
    assert report["unscored_question_ids"] == [qs[1].id]
    # The other two really did grade.
    graded = [r for r in report["per_question"] if not r.get("scoring_failed")]
    assert len(graded) == 2 and all(r["items"] for r in graded)
    # P7: the failed question is EXCLUDED from the score, not scored zero. A zero would be an
    # under-count — nobody judged that answer, so there is no basis for calling it bad.
    assert report["total_score"] > 0
    # And the stream told the client which question broke, in band.
    assert [e["question_id"] for e in events if e["type"] == "question_error"] == [qs[1].id]


@pytest.mark.asyncio
async def test_slow_question_emits_heartbeats_so_the_stream_is_never_idle(db_session, monkeypatch):
    """The ingress disconnects an idle request; a slow question must keep the connection alive."""
    q = await _question_with_checklist(db_session)
    cand, _ = await create_anonymous_session(db_session, ip_address="1.2.3.4")
    session = await state_machine.start_interview(db_session, cand.id)
    session = await state_machine.answer_finalized(
        db_session, session, "a long enough answer to score", source="text"
    )

    real = scoring_service.score_answer_against_checklist

    async def _slow(db, **kw):
        await asyncio.sleep(0.25)  # longer than the heartbeat interval below
        return await real(db, **kw)

    monkeypatch.setattr(state_machine.scoring_service, "score_answer_against_checklist", _slow)
    monkeypatch.setattr(state_machine, "SCORING_HEARTBEAT_SECONDS", 0.05)

    events = [e async for e in state_machine.score_and_finalize_events(db_session, session)]
    pings = [e for e in events if e["type"] == "ping"]
    assert pings, "a question slower than the heartbeat interval must emit keepalives"
    assert all(p["question_id"] == q.id and p["total"] == 1 for p in pings)
    assert any(e["type"] == "report" for e in events)
