"""Checklist service (SPEC F3): AI drafting via the mock LLM, the expected_points fallback,
default demotion, and the source/weight invariants (AC #1/#2/#3)."""

import json

import pytest

from app.services import checklist_service as svc
from app.services import question_service


async def _question(db, *, text="Describe the safety procedure.", points=None):
    bank = await question_service.create_bank(db, name="B", is_default=True)
    return await question_service.add_question(
        db,
        bank_id=bank.id,
        text=text,
        order_index=0,
        expected_points=json.dumps(points or []),
    )


@pytest.mark.asyncio
async def test_draft_from_mock_llm_produces_items(db_session):
    q = await _question(db_session)
    checklist = await svc.draft_checklist(db_session, q.id)
    items = await svc.list_items(db_session, checklist.id)
    # The mock LLM returns a checklist-shaped draft (required + recommended + forbidden).
    kinds = {i.kind for i in items}
    assert "required" in kinds
    assert "forbidden" in kinds


@pytest.mark.asyncio
async def test_draft_weights_sum_to_100(db_session):
    # AC #3: weights across a checklist sum to 100 (forbidden items excluded from the budget).
    q = await _question(db_session)
    checklist = await svc.draft_checklist(db_session, q.id)
    items = await svc.list_items(db_session, checklist.id)
    assert sum(i.weight for i in items) == 100
    assert all(i.weight == 0 for i in items if i.kind == "forbidden")


@pytest.mark.asyncio
async def test_draft_items_carry_kind_weight_and_source(db_session):
    # AC #2: each item has kind + weight + source (quote/page from the SOP retrieval or LLM).
    q = await _question(db_session)
    checklist = await svc.draft_checklist(db_session, q.id)
    items = await svc.list_items(db_session, checklist.id)
    assert items
    for i in items:
        assert i.kind in ("required", "recommended", "forbidden")
    # At least one item is source-attributed (the mock draft quotes the SOP).
    assert any(i.source_quote for i in items)


@pytest.mark.asyncio
async def test_fallback_to_expected_points_when_llm_empty(db_session, monkeypatch):
    # When the LLM yields nothing usable, required items are derived from expected_points.
    class _EmptyLLM:
        name = "empty"

        async def complete(self, prompt, *, json_mode=False):
            return "not json at all"

        async def stream(self, prompt):
            yield ""

    # Patch the name as bound in the service module (it imported get_llm_adapter directly).
    monkeypatch.setattr(svc, "get_llm_adapter", lambda name=None: _EmptyLLM())

    q = await _question(db_session, points=["mentions PPE", "logs the result"])
    checklist = await svc.draft_checklist(db_session, q.id)
    items = await svc.list_items(db_session, checklist.id)
    assert [i.text for i in items] == ["mentions PPE", "logs the result"]
    assert sum(i.weight for i in items) == 100


@pytest.mark.asyncio
async def test_redrafting_demotes_prior_default(db_session):
    q = await _question(db_session)
    first = await svc.draft_checklist(db_session, q.id)
    second = await svc.draft_checklist(db_session, q.id)
    assert first.id != second.id
    current = await svc.get_default_checklist(db_session, q.id)
    assert current.id == second.id


@pytest.mark.asyncio
async def test_draft_unknown_question_raises(db_session):
    with pytest.raises(svc.QuestionNotFound):
        await svc.draft_checklist(db_session, "no-such-question")


class _NoSopRetrieval:
    """A retrieval adapter that finds no SOP passages (no SOP corpus configured)."""

    name = "empty-sop"

    async def retrieve_citations(self, query, *, max_citations=3):
        return []


@pytest.mark.asyncio
async def test_draft_without_sop_is_non_empty(db_session, monkeypatch):
    # Design B P2: with NO SOP passages, the LLM still drafts a rubric from the question text; the
    # checklist must be non-empty with weights summing to 100.
    monkeypatch.setattr(svc, "get_retrieval_adapter", lambda name=None: _NoSopRetrieval())

    q = await _question(db_session)
    checklist = await svc.draft_checklist(db_session, q.id)
    items = await svc.list_items(db_session, checklist.id)
    assert items  # non-empty
    assert sum(i.weight for i in items) == 100


@pytest.mark.asyncio
async def test_draft_generic_fallback_when_llm_and_points_empty(db_session, monkeypatch):
    # Design B final non-empty guarantee: LLM yields nothing AND the question has no
    # expected_points → synthesize one generic required item (never an empty checklist → stub).
    class _EmptyLLM:
        name = "empty"

        async def complete(self, prompt, *, json_mode=False):
            return "not json"

        async def stream(self, prompt):
            yield ""

    monkeypatch.setattr(svc, "get_llm_adapter", lambda name=None: _EmptyLLM())
    monkeypatch.setattr(svc, "get_retrieval_adapter", lambda name=None: _NoSopRetrieval())

    q = await _question(db_session, points=[])
    checklist = await svc.draft_checklist(db_session, q.id)
    items = await svc.list_items(db_session, checklist.id)
    assert len(items) == 1
    assert items[0].kind == "required"
    assert items[0].text == svc.GENERIC_REQUIRED_ITEM_TEXT
    assert items[0].weight == 100


@pytest.mark.asyncio
async def test_default_item_counts(db_session):
    # The admin editor's rubric-status marker counts items in each question's default checklist.
    q = await _question(db_session)
    other = await question_service.add_question(
        db_session, bank_id=q.bank_id, text="No rubric here.", order_index=1
    )
    checklist = await svc.draft_checklist(db_session, q.id)
    n_items = len(await svc.list_items(db_session, checklist.id))

    counts = await svc.default_item_counts(db_session, [q.id, other.id])
    assert counts[q.id] == n_items
    assert counts[other.id] == 0
    # Empty input is a no-op (no query).
    assert await svc.default_item_counts(db_session, []) == {}


@pytest.mark.asyncio
async def test_draft_gates_partial_llm_citation(db_session, monkeypatch):
    """A drafted item whose LLM citation is half-present (quote, no page) keeps the item but strips
    the attribution (Phase 5) — no partial SOP citation reaches the report."""

    class _PartialCiteLLM:
        name = "partial"

        async def complete(self, prompt, *, json_mode=False):
            # One complete citation + one partial (quote, no page) + one fully unsourced.
            return (
                '{"items": ['
                '{"kind": "required", "text": "grounded item", "weight": 40,'
                ' "source_quote": "Follow the documented steps.", "source_page": "p.1"},'
                '{"kind": "required", "text": "hallucinated cite", "weight": 30,'
                ' "source_quote": "This quote has no page."},'
                '{"kind": "recommended", "text": "unsourced point", "weight": 30}'
                "]}"
            )

        async def stream(self, prompt):
            yield ""

    monkeypatch.setattr(svc, "get_llm_adapter", lambda name=None: _PartialCiteLLM())

    q = await _question(db_session)
    checklist = await svc.draft_checklist(db_session, q.id)
    items = {i.text: i for i in await svc.list_items(db_session, checklist.id)}

    # All three items kept (never dropped for a bad citation).
    assert set(items) == {"grounded item", "hallucinated cite", "unsourced point"}
    # Complete citation survives.
    assert items["grounded item"].source_quote == "Follow the documented steps."
    assert items["grounded item"].source_page == "p.1"
    # Partial citation stripped.
    assert items["hallucinated cite"].source_quote == ""
    assert items["hallucinated cite"].source_page is None
