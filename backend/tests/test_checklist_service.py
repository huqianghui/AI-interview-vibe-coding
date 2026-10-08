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
    # No SOP corpus here: nothing may be attributed (the mock's own quote cannot be checked
    # against any section, so it is dropped — the old "SOP Handbook" bug).
    assert not any(i.source_quote or i.source_document_id for i in items)


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


@pytest.mark.asyncio
async def test_draft_without_sop_is_non_empty(db_session, monkeypatch):
    # Design B P2: with NO SOP sections, the LLM still drafts a rubric from the question text; the
    # checklist must be non-empty with weights summing to 100.

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
async def test_a_drafted_citation_survives_only_if_it_can_be_checked(db_session, monkeypatch):
    """The model sees our own SOP sections as C1..; a citation it gives is kept only when it names
    a section it was shown and its quote is copied verbatim from that section."""
    from app.models.sop import SopDocument, SopSection

    doc = SopDocument(name="Deploy SOP.pdf", status="chunked", markdown_source="text")
    db_session.add(doc)
    await db_session.flush()
    db_session.add(
        SopSection(
            document_id=doc.id,
            order_index=0,
            number="3",
            title="Deployment steps",
            page_start=2,
            page_end=2,
            text="Follow the documented deployment steps in order. Never bypass the safety check.",
        )
    )
    await db_session.commit()

    class _CitingLLM:
        name = "citing"

        async def complete(self, prompt, *, json_mode=False):
            assert (
                '<section id="C1" document="Deploy SOP.pdf" title="3 Deployment steps">' in prompt
            )
            return (
                '{"items": ['
                '{"kind": "required", "text": "grounded item", "weight": 40, "cite": ["C1"],'
                ' "source_quote": "Follow the documented deployment steps in order."},'
                '{"kind": "required", "text": "invented quote", "weight": 30, "cite": ["C1"],'
                ' "source_quote": "Deployments need two approvers."},'
                '{"kind": "recommended", "text": "invented section", "weight": 30, "cite": ["C9"]}'
                "]}"
            )

        async def stream(self, prompt):
            yield ""

    monkeypatch.setattr(svc, "get_llm_adapter", lambda name=None: _CitingLLM())
    q = await _question(db_session, text="How do you follow the deployment steps safely?")
    checklist = await svc.draft_checklist(db_session, q.id)
    items = {i.text: i for i in await svc.list_items(db_session, checklist.id)}

    assert set(items) == {"grounded item", "invented quote", "invented section"}
    grounded = items["grounded item"]
    assert grounded.source_quote == "Follow the documented deployment steps in order."
    assert (grounded.source_document_id, grounded.source_page) == (doc.id, "p. 2")
    assert json.loads(grounded.source_refs) == [{"document_id": doc.id, "section": "3"}]
    # The section is real but the quote is not in it: cited, quote dropped.
    assert items["invented quote"].source_quote == ""
    assert json.loads(items["invented quote"].source_refs) == [
        {"document_id": doc.id, "section": "3"}
    ]
    # A section it was never shown: nothing kept.
    assert items["invented section"].source_refs == "[]"
    assert items["invented section"].source_document_id is None


@pytest.mark.asyncio
async def test_a_bank_about_another_subject_is_drafted_without_sop_sections(
    db_session, monkeypatch
):
    """A behavioural bank grounded in clinical SOPs got clinical rubric items (live Demo bank,
    2026-10-09): when the bank is judged off the library's subject, the model sees no sections."""
    from app.models.sop import SopDocument, SopSection

    doc = SopDocument(name="Safety SOP.pdf", status="chunked", markdown_source="text")
    db_session.add(doc)
    await db_session.flush()
    db_session.add(
        SopSection(
            document_id=doc.id,
            order_index=0,
            number="5",
            title="SAE reporting",
            text="Every serious adverse event is reported to safety within 24 hours.",
        )
    )
    await db_session.commit()
    prompts: list[str] = []

    class OffTopicLLM:
        name = "scripted"

        async def complete(self, prompt, *, json_mode=False, fast=False):
            prompts.append(prompt)
            if "deciding whether a question bank" in prompt:
                return '{"about": false}'
            item = '{"kind": "required", "text": "Gives a concrete example", "weight": 100}'
            return '{"items": [' + item + "]}"

        async def stream(self, prompt):
            yield ""

    monkeypatch.setattr(svc, "get_llm_adapter", lambda name=None: OffTopicLLM())
    q = await _question(db_session, text="Tell me about a time you caught a serious mistake.")
    await svc.draft_checklist(db_session, q.id)
    draft_prompt = next(p for p in prompts if "drafting a scoring checklist" in p)
    assert "(no SOP section found for this question)" in draft_prompt
    assert "SAE reporting" not in draft_prompt
