"""Rubric items cite SOP sections (spec-sop-section-grounding §3): stored by section number, read
back as the section's full text, carried through the editor, bundles, versions and the report.

Synthetic SOP text only: this repo is public.
"""

import json

import pytest

from app.interview import state_machine
from app.models.sop import DEFAULT_LIBRARY_ID, SopDocument, SopSection
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
    # SOP-grounded: bound to the library its documents are in (spec-sop-libraries).
    bank.sop_library_id = DEFAULT_LIBRARY_ID
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


async def test_the_editor_cannot_cite_a_document_outside_the_banks_library(
    client, db_session, admin_auth
):
    from app.models.sop import SopLibrary

    doc = await _widget_sop(db_session)
    other = SopLibrary(name="Elsewhere")
    db_session.add(other)
    await db_session.flush()
    foreign = SopDocument(
        name="Foreign SOP.pdf",
        status="chunked",
        markdown_source="text",
        markdown="x",
        library_id=other.id,
    )
    db_session.add(foreign)
    await db_session.flush()
    db_session.add(
        SopSection(
            document_id=foreign.id,
            order_index=0,
            number="1",
            title="Scope",
            level=1,
            page_start=1,
            page_end=1,
            text="Applies to gadgets.",
        )
    )
    await db_session.commit()
    foreign_id = foreign.id
    _, q, checklist = await _bank_question(db_session)
    got = (await client.get(f"/admin/checklists/questions/{q.id}", headers=admin_auth)).json()
    items = [
        {k: it[k] for k in ("kind", "text", "weight", "source_quote", "source_page")}
        for it in got["items"]
    ]
    items[0]["source_refs"] = [
        {"document_id": foreign_id, "section": "1"},
        {"document_id": doc, "section": "4.2"},
    ]
    saved = await client.put(
        f"/admin/checklists/{checklist.id}/items", headers=admin_auth, json={"items": items}
    )
    first = saved.json()["items"][0]
    assert [r["section"] for r in first["source_refs"]] == ["4.2"]  # the foreign one is dropped
    assert first["source_document_id"] == doc


async def test_an_imported_bank_that_cites_an_sop_is_bound_to_its_library(db_session):
    """A bundle import (and the boot-time importer) creates the bank: citing an SOP binds it."""
    from app.models.question import QuestionBank
    from app.models.sop import DEFAULT_LIBRARY_ID

    await _widget_sop(db_session)
    bundle = {
        "bank": {"name": "Imported", "language": "en-US"},
        "questions": [
            {
                "text": "How is a release approved?",
                "checklist": {
                    "items": [
                        {
                            "kind": "required",
                            "text": "Gets sign-off",
                            "weight": 100,
                            "source_document_name": "Widget SOP.pdf",
                            "source_refs": [{"document_name": "Widget SOP.pdf", "section": "4.2"}],
                        }
                    ]
                },
            }
        ],
    }
    result = await bank_bundle_service.import_bank_bundle(db_session, bundle)
    bank = await db_session.get(QuestionBank, result.bank_id)
    assert bank.sop_library_id == DEFAULT_LIBRARY_ID


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


async def test_a_bundle_import_resolves_refs_by_document_name(db_session):
    doc = await _widget_sop(db_session)
    items, unresolved = bank_bundle_service._draft_items_from_bundle(
        [
            {
                "kind": "required",
                "text": "Approve the release",
                "weight": 100,
                "source_refs": [
                    {"document_name": "Widget SOP.pdf", "section": "4.2"},
                    {"document_name": "Elsewhere.pdf", "section": "1"},
                    {"document_name": "", "section": "1"},
                ],
            }
        ],
        {"Widget SOP.pdf": doc},
    )
    assert items[0].source_refs == [{"document_id": doc, "section": "4.2"}]
    assert unresolved == {"Elsewhere.pdf"}


async def test_a_vanished_section_is_flagged_in_the_editor_and_left_out_of_scoring(
    client, db_session, admin_auth
):
    doc = await _widget_sop(db_session)
    _, q, checklist = await _bank_question(db_session)
    rows = await checklist_service.list_items(db_session, checklist.id)
    rows[0].source_refs = sop_citation.dump_refs([SectionRef(doc, "4.2"), SectionRef(doc, "8")])
    await db_session.commit()
    got = (await client.get(f"/admin/checklists/questions/{q.id}", headers=admin_auth)).json()
    assert [(r["section"], r["found"]) for r in got["items"][0]["source_refs"]] == [
        ("4.2", True),
        ("8", False),
    ]
    from app.services import scoring_service

    task = await scoring_service.prepare_scoring(
        db_session, question_id=q.id, question_text=q.text, answer_text="A"
    )
    assert [s.number for s in task.sources.sections] == ["4.2"]


async def test_an_item_without_refs_brings_only_its_documents_approved_summary(db_session, caplog):
    from app.services import scoring_service

    doc = await _widget_sop(db_session)
    _, q, checklist = await _bank_question(db_session)
    for row in await checklist_service.list_items(db_session, checklist.id):
        row.source_document_id = doc
    document = await db_session.get(SopDocument, doc)
    await sop_summary_service.save(db_session, document, "Approved.", approve=True)
    task = await scoring_service.prepare_scoring(
        db_session, question_id=q.id, question_text=q.text, answer_text="A"
    )
    assert task.sources.sections == ()
    assert task.sources.summaries == (("Widget SOP.pdf", "Approved."),)

    # Over the budget: still sent whole, and a warning says so.
    big = db_session.add(
        SopSection(document_id=doc, order_index=9, number="9", title="BIG", text="x" * 60_001)
    )
    del big
    rows = await checklist_service.list_items(db_session, checklist.id)
    rows[0].source_refs = sop_citation.dump_refs([SectionRef(doc, "9")])
    await db_session.commit()
    task = await scoring_service.prepare_scoring(
        db_session, question_id=q.id, question_text=q.text, answer_text="A"
    )
    assert len(task.sources.sections[0].text) > 60_000
    assert "sent whole" in caplog.text


async def test_a_run_and_an_own_part_resolve_save_and_travel_like_a_section(
    client, db_session, admin_auth
):
    """A merged unit is cited as one run, "4.1" through "5"; an opened section's intro as its own
    text (app/sop/units.py). Both read their exact passage, survive the editor and a bundle."""
    doc = await _widget_sop(db_session)
    run, own = SectionRef(doc, "4.1", "5"), SectionRef(doc, "4", own=True)
    assert sop_citation.parse_refs([run.as_dict(), own.as_dict()]) == [run, own]
    passage, intro = await sop_citation.resolve(db_session, [run, own])
    assert (passage.label, passage.pages) == ("4.1–5 Inspection", "pp. 3-5")
    assert "every widget is inspected" in passage.text.lower() and "15 years" in passage.text
    assert "Release follows" not in passage.text  # 4's own text is not in 4.1-5
    assert intro.text == "## 4 RELEASE\n\nRelease follows these steps."
    assert await sop_citation.missing(db_session, [SectionRef(doc, "4.1", "9")]) == [
        SectionRef(doc, "4.1", "9")
    ]

    bank, q, checklist = await _bank_question(db_session)
    got = (await client.get(f"/admin/checklists/questions/{q.id}", headers=admin_auth)).json()
    items = [
        {k: it[k] for k in ("kind", "text", "weight", "source_quote", "source_page")}
        for it in got["items"]
    ]
    items[0]["source_refs"] = [run.as_dict(), own.as_dict()]
    saved = await client.put(
        f"/admin/checklists/{checklist.id}/items", headers=admin_auth, json={"items": items}
    )
    refs = saved.json()["items"][0]["source_refs"]
    assert [(r["section"], r["through"], r["part"], r["found"]) for r in refs] == [
        ("4.1", "5", "", True),
        ("4", "", "own", True),
    ]
    bundle = await bank_bundle_service.export_bank_bundle(db_session, bank.id)
    exported = bundle["questions"][0]["checklist"]["items"][0]["source_refs"]
    assert exported == [
        {"document_name": "Widget SOP.pdf", "section": "4.1", "through": "5"},
        {"document_name": "Widget SOP.pdf", "section": "4", "part": "own"},
    ]


async def test_a_run_that_ends_before_it_starts_is_reported_gone(db_session):
    """Found in the editor means resolve reads something: "5 through 4.1" reads nothing."""
    doc = await _widget_sop(db_session)
    backwards = SectionRef(doc, "5", "4.1")
    assert await sop_citation.resolve(db_session, [backwards]) == []
    assert await sop_citation.missing(db_session, [backwards]) == [backwards]
    (described,) = await sop_citation.describe(db_session, [backwards])
    assert described["found"] is False
