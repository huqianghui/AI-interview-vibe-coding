"""LLM-backed scoring (SPEC F4): scoring against a real checklist via the mock LLM, the
cross-language path, retry-on-incomplete, and end-to-end scoring through the state machine."""

import asyncio
import json
import re

import pytest

from app.interview import scoring_engine, state_machine
from app.services import checklist_service, question_service, scoring_service
from app.services.agents.adapters.foundry_llm import LLMAdapterError
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
    # Every checklist item got a judgment.
    assert len(result.items) == 3


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
    # Asserted on the checklist BLOCK rather than on the item's id: since v0.45.0.0 the prompt
    # numbers items 1..N instead of printing their 36-char UUIDs, so an id-substring check would
    # test the id format rather than the claim.
    retry = llm.prompts[1]
    item_lines = re.findall(r"^\[\d+\] \(", retry, re.MULTILINE)
    assert len(item_lines) == 1, f"retry should re-ask exactly one item, got {len(item_lines)}"
    dropped_text = next(it.text for it in items if it.id == dropped)
    assert dropped_text in retry
    # And the ids themselves are gone from the prompt — that is the point of the change.
    assert not any(it.id in retry for it in items)


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

    # Patch the concurrent seam: since v0.42.2.0 the generator prepares every question's DB work
    # sequentially and then runs judge_prepared() for each under a semaphore.
    real_judge = scoring_service.judge_prepared

    async def _fail_on_second(task, **kw):
        if task.question_id == qs[1].id:
            raise scoring_engine.ScoringIncomplete("LLM did not judge checklist item 'x'")
        return await real_judge(task, **kw)

    monkeypatch.setattr(state_machine.scoring_service, "judge_prepared", _fail_on_second)

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

    real_judge = scoring_service.judge_prepared

    async def _slow(task, **kw):
        await asyncio.sleep(0.25)  # longer than the heartbeat interval below
        return await real_judge(task, **kw)

    monkeypatch.setattr(state_machine.scoring_service, "judge_prepared", _slow)
    monkeypatch.setattr(state_machine, "SCORING_HEARTBEAT_SECONDS", 0.05)

    events = [e async for e in state_machine.score_and_finalize_events(db_session, session)]
    pings = [e for e in events if e["type"] == "ping"]
    assert pings, "grading slower than the heartbeat interval must emit keepalives"
    # Since v0.42.2.0 questions are graded concurrently, so a ping names no single "current"
    # question — it carries the finished count against a stable total.
    assert all(p["total"] == 1 and p["done"] <= 1 for p in pings), pings
    assert any(e["type"] == "report" for e in events)
    assert q.id


# --- concurrency + transport retries (v0.42.2.0) ---------------------------------------------


@pytest.mark.asyncio
async def test_questions_are_graded_concurrently_from_the_question_count(db_session, monkeypatch):
    """Concurrency is DERIVED from the question count, so every question runs in one generation.

    Sequentially, nine questions at ~18 s each took 166 s live. Pinning concurrency at 3 only got
    that to 70 s, because what sets the wall clock is ceil(N / concurrency) generations of ~20 s —
    and 4 would have bought the same three generations as 3 for a nine-question bank. Measured
    against the live deployment, 12 simultaneous calls finish in 26.3 s with zero failures (one
    call alone takes 26.7 s), so there is nothing to protect by holding the number down.
    """
    bank = await question_service.create_bank(db_session, name="B", is_default=True)
    qs = []
    for i in range(6):
        q = await question_service.add_question(
            db_session, bank_id=bank.id, text=f"Q{i + 1}?", order_index=i
        )
        await checklist_service.draft_checklist(db_session, q.id)
        qs.append(q)

    in_flight = 0
    peak = 0
    real_judge = scoring_service.judge_prepared

    async def _tracked(task, **kw):
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        try:
            await asyncio.sleep(0.05)  # hold the slot so overlap is observable
            return await real_judge(task, **kw)
        finally:
            in_flight -= 1

    monkeypatch.setattr(state_machine.scoring_service, "judge_prepared", _tracked)

    cand, _ = await create_anonymous_session(db_session, ip_address="1.2.3.4")
    session = await state_machine.start_interview(db_session, cand.id)
    for _ in qs:
        session = await state_machine.answer_finalized(
            db_session, session, "a long enough answer to score", source="text"
        )

    events = [e async for e in state_machine.score_and_finalize_events(db_session, session)]
    report = next(e["report"] for e in events if e["type"] == "report")

    # All six at once: one generation, which is what makes the wall clock one question long.
    assert peak == len(qs), f"expected all {len(qs)} in flight at once, peak was {peak}"
    # Every question still scored, and the report rows stay in BANK order, not completion order.
    assert [r["question_id"] for r in report["per_question"]] == [q.id for q in qs]


@pytest.mark.asyncio
async def test_progress_counts_finished_questions_and_reaches_the_total(db_session):
    """`done` climbs monotonically from 0 to the total, whatever order the model finishes in."""
    bank = await question_service.create_bank(db_session, name="B", is_default=True)
    qs = []
    for i in range(3):
        q = await question_service.add_question(
            db_session, bank_id=bank.id, text=f"Q{i + 1}?", order_index=i
        )
        await checklist_service.draft_checklist(db_session, q.id)
        qs.append(q)

    cand, _ = await create_anonymous_session(db_session, ip_address="1.2.3.4")
    session = await state_machine.start_interview(db_session, cand.id)
    for _ in qs:
        session = await state_machine.answer_finalized(
            db_session, session, "a long enough answer to score", source="text"
        )

    events = [e async for e in state_machine.score_and_finalize_events(db_session, session)]
    dones = [e["done"] for e in events if e["type"] == "progress"]
    assert dones == sorted(dones), dones
    assert dones[0] == 0
    assert dones[-1] == len(qs)
    assert {e["total"] for e in events if e["type"] == "progress"} == {len(qs)}


@pytest.mark.asyncio
async def test_a_rate_limit_is_retried_but_a_bad_request_is_not(db_session, monkeypatch):
    """Backoff is for transient failures only.

    A 429 arrives in milliseconds and usually succeeds on the next try, so it is worth retrying.
    A 400 (bad parameter, content filter) fails identically every time — retrying it only spends
    the candidate's time, and there was no retry at all on this path before.
    """
    q = await _question_with_checklist(db_session)

    class _Flaky:
        name = "flaky"

        def __init__(self, *, status, retryable, fail_times):
            self.calls = 0
            self.status = status
            self.retryable = retryable
            self.fail_times = fail_times

        async def complete(self, prompt, *, json_mode=False, fast=False):
            self.calls += 1
            if self.calls <= self.fail_times:
                exc = LLMAdapterError(
                    f"boom {self.status}", status_code=self.status, retryable=self.retryable
                )
                raise exc
            items = await checklist_service.list_items(
                db_session, (await checklist_service.get_default_checklist(db_session, q.id)).id
            )
            return json.dumps(
                {
                    "judgments": [
                        {"item_id": it.id, "judgment": "met", "rationale": "r", "answer_quote": "a"}
                        for it in items
                    ]
                }
            )

        async def stream(self, prompt):
            yield ""

    monkeypatch.setattr(scoring_service, "TRANSPORT_BACKOFF_BASE_SECONDS", 0.01)

    # 429 twice, then success — retried, and the question scores.
    rate_limited = _Flaky(status=429, retryable=True, fail_times=2)
    monkeypatch.setattr(scoring_service, "get_llm_adapter", lambda name=None: rate_limited)
    result = await scoring_service.score_answer_against_checklist(
        db_session, question_id=q.id, question_text=q.text, answer_text="a long enough answer"
    )
    assert result is not None
    assert rate_limited.calls == 3  # two failures + the success

    # 400 — raised on the first attempt, never retried.
    bad_request = _Flaky(status=400, retryable=False, fail_times=99)
    monkeypatch.setattr(scoring_service, "get_llm_adapter", lambda name=None: bad_request)
    with pytest.raises(LLMAdapterError):
        await scoring_service.score_answer_against_checklist(
            db_session, question_id=q.id, question_text=q.text, answer_text="a long enough answer"
        )
    assert bad_request.calls == 1, f"a 400 was retried {bad_request.calls} times"


@pytest.mark.asyncio
async def test_concurrency_divisor_splits_the_questions_into_generations(monkeypatch):
    """The owner can trade one generation for two without a code change (N vs N/2)."""
    monkeypatch.setattr(state_machine, "SCORING_CONCURRENCY_DIVISOR", 1)
    assert state_machine.scoring_concurrency(9) == 9  # one generation
    monkeypatch.setattr(state_machine, "SCORING_CONCURRENCY_DIVISOR", 2)
    assert state_machine.scoring_concurrency(9) == 5  # two generations: ceil(9/2)
    assert state_machine.scoring_concurrency(1) == 1  # never zero
    monkeypatch.setattr(state_machine, "SCORING_CONCURRENCY_DIVISOR", 3)
    assert state_machine.scoring_concurrency(9) == 3


# --- ordinal item ids in the judging prompt (v0.45.0.0) --------------------
#
# RCA for `scoring_failed`: the prompt used to print each checklist item's 36-char UUID and require
# the model to echo it verbatim, up to 17 of them per call. One wrong character and that item
# counted as unjudged while the mistyped id counted as invented; with only two attempts the question
# could end up unscored. Items are numbered 1..N now and mapped back in code.


def test_the_prompt_numbers_items_and_never_prints_their_ids():
    rubric = [
        scoring_engine.RubricItem(
            item_id="11111111-2222-3333-4444-555555555555",
            kind="required",
            text="does X",
            weight=50,
        ),
        scoring_engine.RubricItem(
            item_id="66666666-7777-8888-9999-000000000000",
            kind="forbidden",
            text="does Z",
            weight=0,
        ),
    ]
    prompt = scoring_service._build_scoring_prompt("Q?", "A", rubric)
    assert "[1] (required) does X" in prompt
    assert "[2] (forbidden) does Z" in prompt
    for it in rubric:
        assert it.item_id not in prompt


def test_a_question_with_no_sop_is_scored_on_general_criteria():
    """spec-sop-libraries §6: no section, summary or quote behind the checklist, so the prompt does
    not say it was derived from an SOP; one quote is enough to keep the SOP framing."""
    plain = [
        scoring_engine.RubricItem(item_id="a", kind="required", text="Gives an example", weight=100)
    ]
    general = scoring_service._build_scoring_prompt("Q?", "A", plain)
    assert "derived from an SOP" not in general
    assert "No SOP applies to this question" in general
    assert "SOP SECTIONS" not in general

    quoted = [
        scoring_engine.RubricItem(
            item_id="a",
            kind="required",
            text="Gets sign-off",
            weight=100,
            source_quote="The Quality Manager signs the release form.",
        )
    ]
    assert "derived from an SOP" in scoring_service._build_scoring_prompt("Q?", "A", quoted)


def test_an_ordinal_answer_resolves_to_the_right_item():
    rubric = [
        scoring_engine.RubricItem(item_id="uuid-a", kind="required", text="A", weight=50),
        scoring_engine.RubricItem(item_id="uuid-b", kind="required", text="B", weight=50),
    ]
    # "[1]" FIRST because it is what the live model actually sends: gpt-5-mini copies the token as
    # printed in the prompt, brackets included. A bare-digits pattern shipped green here (the mock
    # adapter's regex captures the bracket contents, so it only ever answers "1") and then failed
    # 3 of 3 items on every attempt against real Azure.
    assert scoring_service._resolve_item_id("[1]", rubric) == "uuid-a"
    assert scoring_service._resolve_item_id("[2]", rubric) == "uuid-b"
    assert scoring_service._resolve_item_id("1", rubric) == "uuid-a"
    assert scoring_service._resolve_item_id(2, rubric) == "uuid-b"
    assert scoring_service._resolve_item_id(" #2 ", rubric) == "uuid-b"
    assert scoring_service._resolve_item_id("2.", rubric) == "uuid-b"
    # A model that echoes the real id anyway is still honoured rather than discarded.
    assert scoring_service._resolve_item_id("uuid-b", rubric) == "uuid-b"
    # Out of range, or not in this checklist at all: dropped, NEVER mapped to a neighbour.
    assert scoring_service._resolve_item_id("0", rubric) is None
    assert scoring_service._resolve_item_id("3", rubric) is None
    assert scoring_service._resolve_item_id("[3]", rubric) is None
    assert scoring_service._resolve_item_id("12x", rubric) is None
    assert scoring_service._resolve_item_id("[]", rubric) is None
    assert scoring_service._resolve_item_id("uuid-ghost", rubric) is None
    assert scoring_service._resolve_item_id("", rubric) is None


@pytest.mark.asyncio
async def test_a_retrys_renumbering_lands_on_the_item_it_re_asked(db_session, monkeypatch):
    """The retry re-asks only what is pending, so it renumbers from 1 — and "1" on attempt two is a
    DIFFERENT item than "1" on attempt one.

    This is the failure mode the ordinal scheme could introduce and the UUID scheme could not:
    mapping attempt two's "1" against the full rubric would attribute the judgment to the wrong
    checklist item and score the answer against the wrong requirement, silently.
    """
    q = await _question_with_checklist(db_session)
    checklist = await checklist_service.get_default_checklist(db_session, q.id)
    items = await checklist_service.list_items(db_session, checklist.id)
    assert len(items) >= 2, "fixture needs a multi-item checklist to drop one"
    last = items[-1]

    class _OmitsTheLast:
        name = "omits-last"

        def __init__(self):
            self.calls = 0

        async def complete(self, prompt, *, json_mode=False):
            self.calls += 1
            if self.calls == 1:
                # Judge every item EXCEPT the last, by ordinal.
                judged = [
                    {
                        "item_id": str(n),
                        "judgment": "met",
                        "rationale": "first pass",
                        "answer_quote": "q",
                    }
                    for n in range(1, len(items))
                ]
            else:
                # The sole pending item is renumbered to 1 on this attempt.
                judged = [
                    {
                        "item_id": "1",
                        "judgment": "not_met",
                        "rationale": "second pass",
                        "answer_quote": "q",
                    }
                ]
            return json.dumps({"judgments": judged})

        async def stream(self, prompt):
            yield ""

    llm = _OmitsTheLast()
    monkeypatch.setattr(scoring_service, "get_llm_adapter", lambda name=None: llm)

    result = await scoring_service.score_answer_against_checklist(
        db_session, question_id=q.id, question_text=q.text, answer_text="a long enough answer"
    )
    assert llm.calls == 2
    assert len(result.items) == len(items)
    by_id = {it.item_id: it for it in result.items}
    # The retry's judgment is on the item it re-asked — not on rubric position 1.
    assert by_id[last.id].rationale == "second pass"
    assert by_id[items[0].id].rationale == "first pass"


@pytest.mark.asyncio
async def test_an_out_of_range_ordinal_is_dropped_not_mismapped(db_session, monkeypatch):
    """A number the model was never given is discarded; the rest of the question still scores."""
    q = await _question_with_checklist(db_session)
    checklist = await checklist_service.get_default_checklist(db_session, q.id)
    items = await checklist_service.list_items(db_session, checklist.id)

    class _InventsANumber:
        name = "invents"

        async def complete(self, prompt, *, json_mode=False):
            judged = [
                {"item_id": str(n), "judgment": "met", "rationale": "r", "answer_quote": "q"}
                for n in range(1, len(items) + 1)
            ]
            judged.append(
                {"item_id": "99", "judgment": "violated", "rationale": "ghost", "answer_quote": "g"}
            )
            return json.dumps({"judgments": judged})

        async def stream(self, prompt):
            yield ""

    monkeypatch.setattr(scoring_service, "get_llm_adapter", lambda name=None: _InventsANumber())
    result = await scoring_service.score_answer_against_checklist(
        db_session, question_id=q.id, question_text=q.text, answer_text="a long enough answer"
    )
    assert len(result.items) == len(items)
    assert all(it.rationale != "ghost" for it in result.items)
