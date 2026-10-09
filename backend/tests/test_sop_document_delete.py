"""Deleting an SOP (owner, 2026-10-09): only one nothing cites — no rubric (current or replaced),
no published bank version, no interview report. A cited SOP is replaced by a new bank or version."""

import json

import pytest

from app.models.sop import SopChunk, SopDocument, SopSection
from app.services import checklist_service, question_service

pytestmark = pytest.mark.asyncio


async def _doc(db, name="Widget SOP.pdf") -> str:
    doc = SopDocument(name=name, status="chunked", markdown_source="text", markdown="x")
    db.add(doc)
    await db.flush()
    db.add(
        SopSection(
            document_id=doc.id,
            order_index=0,
            number="1",
            title="Scope",
            level=1,
            page_start=1,
            page_end=1,
            text="Applies to widgets.",
        )
    )
    db.add(SopChunk(document_id=doc.id, chunk_index=0, content="x", token_count=1))
    await db.commit()
    return doc.id


async def test_an_uncited_sop_is_deleted_with_its_sections_and_chunks(
    client, db_session, admin_auth
):
    doc_id = await _doc(db_session)
    listed = (await client.get("/admin/sop/documents", headers=admin_auth)).json()
    assert listed[0]["cited_in"] == []
    resp = await client.delete(f"/admin/sop/documents/{doc_id}", headers=admin_auth)
    assert resp.status_code == 204
    assert (await client.get("/admin/sop/documents", headers=admin_auth)).json() == []
    db_session.expire_all()
    assert await db_session.get(SopDocument, doc_id) is None
    assert (
        await client.delete(f"/admin/sop/documents/{doc_id}", headers=admin_auth)
    ).status_code == 404


async def test_a_cited_sop_cannot_be_deleted_even_after_the_draft_stops_citing_it(
    client, db_session, admin_auth
):
    doc_id = await _doc(db_session)
    bank = await question_service.create_bank(db_session, name="Widgets", is_default=True)
    q = await question_service.add_question(db_session, bank_id=bank.id, text="Q?", order_index=0)
    checklist = await checklist_service._persist_draft(
        db_session,
        q.id,
        checklist_service.ChecklistDraft(
            prompt_version="t",
            items=[
                checklist_service.DraftItem(
                    kind="required",
                    text="Scopes it",
                    weight=100,
                    source_document_id=doc_id,
                    source_refs=[{"document_id": doc_id, "section": "1"}],
                )
            ],
        ),
    )
    assert (
        await client.post(f"/admin/question-banks/{bank.id}/publish", headers=admin_auth)
    ).json()["published"]

    listed = (await client.get("/admin/sop/documents", headers=admin_auth)).json()
    assert listed[0]["cited_in"] == ["Widgets v1", "rubric of Widgets"]
    held = await client.delete(f"/admin/sop/documents/{doc_id}", headers=admin_auth)
    assert held.status_code == 409 and "Widgets v1" in held.json()["detail"]

    # The draft stops citing it; the published version still does, so it still stays.
    items = [
        {
            "kind": "required",
            "text": "Scopes it",
            "weight": 100,
            "source_quote": "",
            "source_page": None,
            "source_refs": [],
            "source_document_id": None,
        }
    ]
    await client.put(
        f"/admin/checklists/{checklist.id}/items", headers=admin_auth, json={"items": items}
    )
    still = await client.delete(f"/admin/sop/documents/{doc_id}", headers=admin_auth)
    assert still.status_code == 409


async def test_an_sop_a_report_cites_cannot_be_deleted(client, db_session, admin_auth):
    from app.models.interview import InterviewSession
    from app.services.anonymous_session_service import create_anonymous_session

    doc_id = await _doc(db_session)
    cand, _ = await create_anonymous_session(db_session, ip_address="1.2.3.4")
    db_session.add(
        InterviewSession(
            candidate_session_id=cand.id,
            status="scored",
            report_json=json.dumps({"citations": [{"document_id": doc_id}]}),
        )
    )
    await db_session.commit()
    held = await client.delete(f"/admin/sop/documents/{doc_id}", headers=admin_auth)
    assert held.status_code == 409 and "interview reports" in held.json()["detail"]


async def test_a_document_being_converted_or_summarised_is_not_deleted(
    client, db_session, admin_auth, monkeypatch
):
    from app.services import sop_section_service

    doc_id = await _doc(db_session)
    monkeypatch.setattr(sop_section_service, "converting", lambda d: d == doc_id)
    busy = await client.delete(f"/admin/sop/documents/{doc_id}", headers=admin_auth)
    assert busy.status_code == 409 and "converted" in busy.json()["detail"]


async def test_a_relocation_report_counts_as_a_citation_but_only_for_the_delete(
    client, db_session, admin_auth
):
    from app.models.sop import CitationRun

    doc_id = await _doc(db_session)
    bank = await question_service.create_bank(db_session, name="Widgets")
    db_session.add(
        CitationRun(
            bank_id=bank.id,
            status="done",
            report_json=json.dumps([{"old": {"document_id": doc_id}}]),
        )
    )
    await db_session.commit()
    # The list (polled) does not scan reports, so it offers Delete; the delete scans and refuses.
    listed = (await client.get("/admin/sop/documents", headers=admin_auth)).json()
    assert listed[0]["cited_in"] == []
    held = await client.delete(f"/admin/sop/documents/{doc_id}", headers=admin_auth)
    assert held.status_code == 409 and "relocation" in held.json()["detail"]


async def test_removing_a_file_never_leaves_the_storage_root(tmp_path, monkeypatch):
    from app.services import storage

    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "keep.txt"
    outside.write_text("keep")
    monkeypatch.setattr(storage, "_STORES", {})
    monkeypatch.setattr(storage, "_default_root", lambda: str(root))
    storage.remove(str(outside))  # logged and refused, never raised
    assert outside.exists()
    inside = root / "a.pdf"
    inside.write_text("x")
    storage.remove(str(inside))
    assert not inside.exists()
