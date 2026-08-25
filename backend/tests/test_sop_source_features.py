"""Features C (SOP source-context injection into scoring) and D (opt-in SOP coverage check).

C is default-on prompt enrichment: each rubric item that links a source document gets a fuller SOP
passage appended to the judging prompt. It must NOT change the score for a given set of judgments —
the pure engine never sees it. D is an opt-in advisory audit: off by default (no extra LLM call, no
report field), on it appends "SOP points the rubric may not cover" to the report WITHOUT touching a
single score.

All paths run on the deterministic mock LLM (SPEC P2) — no Azure.
"""

import json

import pytest

from app.interview import state_machine
from app.interview.scoring_engine import RubricItem
from app.models.sop import SopChunk, SopDocument
from app.services import checklist_service, question_service, scoring_service, sop_coverage
from app.services.anonymous_session_service import create_anonymous_session


async def _doc_with_text(db, text: str, *, page: str = "p.1") -> str:
    """Persist a one-chunk SOP document and return its id."""
    doc = SopDocument(name="sop.txt", status="chunked", size=len(text))
    db.add(doc)
    await db.flush()
    db.add(
        SopChunk(document_id=doc.id, chunk_index=0, content=text, page_label=page, token_count=5)
    )
    await db.commit()
    return doc.id


async def _question_with_sourced_checklist(db, *, text="Describe the safety procedure."):
    """A question whose checklist items link a real SOP document (so C/D have text to read)."""
    bank = await question_service.create_bank(db, name="B", is_default=True)
    q = await question_service.add_question(
        db, bank_id=bank.id, text=text, order_index=0, expected_points=json.dumps([])
    )
    await checklist_service.draft_checklist(db, q.id)  # mock drafts a 3-item checklist
    doc_id = await _doc_with_text(
        db,
        "Always verify the guard is engaged before starting. Log the result and never bypass the "
        "safety check under any circumstances.",
    )
    checklist = await checklist_service.get_default_checklist(db, q.id)
    items = await checklist_service.list_items(db, checklist.id)
    for it in items:
        it.source_document_id = doc_id
        it.source_page = "p.1"
    await db.commit()
    return q


# --- C: prompt enrichment, no score impact ---------------------------------


def test_build_prompt_appends_source_passage_when_present():
    rubric = [RubricItem(item_id="i1", kind="required", text="Do the thing", weight=100)]
    without = scoring_service._build_scoring_prompt("Q?", "A", rubric)
    withctx = scoring_service._build_scoring_prompt(
        "Q?", "A", rubric, {"i1": "the fuller original SOP passage"}
    )
    assert "原文依据" not in without
    assert "原文依据" in withctx
    assert "the fuller original SOP passage" in withctx


@pytest.mark.asyncio
async def test_source_context_does_not_change_score(db_session):
    q = await _question_with_sourced_checklist(db_session)
    answer = "I followed the documented steps in order and explained my reasoning clearly."
    with_ctx = await scoring_service.score_answer_against_checklist(
        db_session,
        question_id=q.id,
        question_text=q.text,
        answer_text=answer,
        include_source_context=True,
    )
    without_ctx = await scoring_service.score_answer_against_checklist(
        db_session,
        question_id=q.id,
        question_text=q.text,
        answer_text=answer,
        include_source_context=False,
    )
    # Same deterministic judgments → identical score, regardless of the prompt enrichment.
    assert with_ctx is not None and without_ctx is not None
    assert with_ctx.score == without_ctx.score


@pytest.mark.asyncio
async def test_source_context_collected_for_sourced_items(db_session):
    q = await _question_with_sourced_checklist(db_session)
    checklist = await checklist_service.get_default_checklist(db_session, q.id)
    items = await checklist_service.list_items(db_session, checklist.id)
    rubric = [
        RubricItem(
            item_id=it.id,
            kind=it.kind,
            text=it.text,
            weight=it.weight,
            source_document_id=it.source_document_id,
            source_page=it.source_page,
        )
        for it in items
    ]
    ctx = await scoring_service._collect_source_context(db_session, rubric)
    assert ctx  # at least one item resolved a passage
    assert any("verify the guard" in passage for passage in ctx.values())


# --- D: opt-in, advisory, never affects a score ----------------------------


async def _run_interview(db):
    await _question_with_sourced_checklist(db)
    cand, _ = await create_anonymous_session(db, ip_address="1.2.3.4")
    interview = await state_machine.start_interview(db, cand.id)
    interview = await state_machine.answer_finalized(
        db, interview, "I followed each documented step and checked safety.", source="text"
    )
    assert interview.status == "completed"
    return interview


@pytest.mark.asyncio
async def test_coverage_check_off_by_default(db_session, monkeypatch):
    interview = await _run_interview(db_session)
    # Fail loudly if the coverage service is called when the flag is off.
    called = False

    async def _boom(*args, **kwargs):
        nonlocal called
        called = True
        return []

    monkeypatch.setattr(sop_coverage, "check_question_coverage", _boom)
    report = await state_machine.score_and_finalize(db_session, interview)
    assert report["sop_coverage"] is None
    assert called is False  # no coverage LLM work when opted out


@pytest.mark.asyncio
async def test_coverage_check_on_appends_findings_without_changing_scores(db_session):
    # Score once WITHOUT the check to capture the baseline per-question scores.
    interview = await _run_interview(db_session)
    baseline = await state_machine.score_and_finalize(db_session, interview)
    baseline_scores = {e["question_id"]: e.get("score") for e in baseline["per_question"]}

    # Fresh interview, same question set, WITH the check on.
    cand, _ = await create_anonymous_session(db_session, ip_address="5.6.7.8")
    iv2 = await state_machine.start_interview(db_session, cand.id)
    iv2 = await state_machine.answer_finalized(
        db_session, iv2, "I followed each documented step and checked safety.", source="text"
    )
    with_check = await state_machine.score_and_finalize(db_session, iv2, sop_coverage_check=True)

    # Findings are attached (mock returns one uncovered point), grouped per question.
    assert with_check["sop_coverage"]
    group = with_check["sop_coverage"][0]
    assert group["missing"] and group["missing"][0]["point"]

    # And every per-question score is identical to the opt-out run — D never touches a score.
    with_scores = {e["question_id"]: e.get("score") for e in with_check["per_question"]}
    assert with_scores == baseline_scores
    assert with_check["total_score"] == baseline["total_score"]


@pytest.mark.asyncio
async def test_coverage_returns_empty_without_sourced_checklist(db_session):
    # A checklist whose items link NO source document → nothing to audit → [].
    bank = await question_service.create_bank(db_session, name="B", is_default=True)
    q = await question_service.add_question(db_session, bank_id=bank.id, text="Q?", order_index=0)
    await checklist_service.draft_checklist(db_session, q.id)
    missing = await sop_coverage.check_question_coverage(
        db_session, question_id=q.id, question_text="Q?"
    )
    assert missing == []
