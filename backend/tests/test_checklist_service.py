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
