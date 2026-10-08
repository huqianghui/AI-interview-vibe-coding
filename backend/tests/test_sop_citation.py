"""Rubric items cite SOP sections (spec-sop-section-grounding §3): stored by section number, read
back as the section's full text, carried through the editor, bundles, versions and the report.

Synthetic SOP text only: this repo is public.
"""

import json

import pytest

from app.interview import state_machine
from app.models.sop import SopDocument, SopSection
from app.services import (
    bank_bundle_service,
    bank_version_service,
    checklist_service,
    question_service,
    sop_citation,
    sop_summary_service,
)
from app.services.anonymous_session_service import create_anonymous_session
from app.services.sop_citation import SectionRef

pytestmark = pytest.mark.asyncio


async def _widget_sop(db, name="Widget SOP.pdf") -> str:
    """4 RELEASE › 4.1 Inspection › 4.2 Approval, and 5 RECORDS."""
    doc = SopDocument(name=name, status="chunked", markdown_source="text", markdown="x")
    db.add(doc)
    await db.flush()
    rows = [
        ("4", "RELEASE", 1, None, 3, "Release follows these steps."),
        ("4.1", "Inspection", 2, 0, 3, "Every widget is inspected."),
        ("4.2", "Approval", 2, 0, 4, "The Quality Manager signs within 24 hours."),
        ("5", "RECORDS", 1, None, 5, "Records are kept for 15 years."),
    ]
    for i, (number, title, level, parent, page, text) in enumerate(rows):
        db.add(
            SopSection(
                document_id=doc.id,
                order_index=i,
                number=number,
                title=title,
                level=level,
                parent_index=parent,
                page_start=page,
                page_end=page,
                text=text,
            )
        )
    await db.commit()
    return doc.id


async def test_refs_are_parsed_strictly_and_resolve_to_the_full_section(db_session):
    doc = await _widget_sop(db_session)
    refs = sop_citation.parse_refs(
        json.dumps(
            [
                {"document_id": doc, "section": "4."},
                {"document_id": doc, "section": "4"},  # duplicate after normalising
                {"document_id": "", "section": "1"},
                "junk",
                {"document_id": doc, "section": "9"},
            ]
        )
    )
    assert refs == [SectionRef(doc, "4"), SectionRef(doc, "9")]
    assert sop_citation.parse_refs("not json") == []
    assert sop_citation.parse_refs({"a": 1}) == []

    (four,) = await sop_citation.resolve(db_session, refs)  # §9 does not exist
    assert (four.label, four.pages, four.document_name) == (
        "4 RELEASE",
        "pp. 3-4",
        "Widget SOP.pdf",
    )
    assert "4.2 Approval" in four.text and "24 hours" in four.text  # subsections included
    assert "RECORDS" not in four.text
    assert await sop_citation.missing(db_session, refs) == [SectionRef(doc, "9")]
    described = await sop_citation.describe(db_session, refs)
    assert [(d["section"], d["title"], d["found"]) for d in described] == [
        ("4", "RELEASE", True),
        ("9", "", False),
    ]


async def _bank_question(db, text="How is a widget released?"):
    bank = await question_service.create_bank(db, name="Widgets", is_default=True)
    q = await question_service.add_question(
        db, bank_id=bank.id, text=text, order_index=0, expected_points=json.dumps([])
    )
    await checklist_service.draft_checklist(db, q.id)  # the mock drafts items
    checklist = await checklist_service.get_default_checklist(db, q.id)
    return bank, q, checklist


async def test_the_editor_round_trips_refs_and_drops_a_section_that_does_not_exist(
    client, db_session, admin_auth
):
    doc = await _widget_sop(db_session)
    _, q, checklist = await _bank_question(db_session)
    got = (await client.get(f"/admin/checklists/questions/{q.id}", headers=admin_auth)).json()
    items = [
        {k: it[k] for k in ("kind", "text", "weight", "source_quote", "source_page")}
        for it in got["items"]
    ]
    items[0]["source_refs"] = [
        {"document_id": doc, "section": "4.2"},
        {"document_id": doc, "section": "7.7"},
    ]
    saved = await client.put(
        f"/admin/checklists/{checklist.id}/items", headers=admin_auth, json={"items": items}
    )
    assert saved.status_code == 200
    first = saved.json()["items"][0]
    assert [(r["section"], r["title"], r["found"]) for r in first["source_refs"]] == [
        ("4.2", "Approval", True)
    ]
    assert first["source_document_id"] == doc  # the primary citation's document

    # An older tab that sends no refs keeps the stored ones.
    for it in items:
        it.pop("source_refs", None)
    again = await client.put(
        f"/admin/checklists/{checklist.id}/items", headers=admin_auth, json={"items": items}
    )
    assert [r["section"] for r in again.json()["items"][0]["source_refs"]] == ["4.2"]


async def test_refs_travel_in_bundles_by_document_name_and_in_versions(db_session):
    doc = await _widget_sop(db_session)
    bank, q, checklist = await _bank_question(db_session)
    rows = await checklist_service.list_items(db_session, checklist.id)
    rows[0].source_refs = sop_citation.dump_refs([SectionRef(doc, "4.2")])
    await db_session.commit()

    bundle = await bank_bundle_service.export_bank_bundle(db_session, bank.id)
    exported = bundle["questions"][0]["checklist"]["items"][0]
    assert exported["source_refs"] == [{"document_name": "Widget SOP.pdf", "section": "4.2"}]

    content = await bank_version_service.draft_content(db_session, bank.id)
    item = content["questions"][0]["rubric"][0]
    assert item["source_refs"] == [{"document_id": doc, "section": "4.2"}]
    # An item citing nothing adds no field: an untouched bank keeps its hash.
    assert "source_refs" not in content["questions"][0]["rubric"][1]
    version = (await bank_version_service.publish(db_session, bank.id)).version
    (row, *_) = await bank_version_service.rubric_rows(
        db_session, question_id=q.id, bank_version_id=version.id
    )
    assert row.source_refs == ({"document_id": doc, "section": "4.2"},)


async def test_the_report_names_the_cited_section_and_scoring_reads_it_whole(db_session):
    doc = await _widget_sop(db_session)
    _, q, checklist = await _bank_question(db_session)
    for row in await checklist_service.list_items(db_session, checklist.id):
        row.source_document_id = doc
        row.source_refs = sop_citation.dump_refs([SectionRef(doc, "4")])
    document = await db_session.get(SopDocument, doc)
    await sop_summary_service.save(db_session, document, "**Purpose:** Release.", approve=True)

    from app.services import scoring_service

    task = await scoring_service.prepare_scoring(
        db_session, question_id=q.id, question_text=q.text, answer_text="I inspect and sign."
    )
    prompt = scoring_service._build_scoring_prompt(q.text, "A", task.rubric, task.sources)
    assert "The Quality Manager signs within 24 hours." in prompt  # 4.2, inside cited §4
    assert "**Purpose:** Release." in prompt

    cand, _ = await create_anonymous_session(db_session, ip_address="7.7.7.7")
    interview = await state_machine.start_interview(db_session, cand.id)
    while interview.status == "in_progress":
        interview = await state_machine.answer_finalized(
            db_session, interview, "I inspect it and the manager signs.", source="text"
        )
    report = await state_machine.score_and_finalize(db_session, interview)
    (item, *_) = report["per_question"][0]["items"]
    assert item["source_sections"] == [
        {
            "document_id": doc,
            "document_name": "Widget SOP.pdf",
            "section": "4",
            "title": "RELEASE",
            "page": 3,
        }
    ]
