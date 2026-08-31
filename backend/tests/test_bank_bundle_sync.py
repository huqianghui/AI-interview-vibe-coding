"""Bank-bundle export/import sync (deploy-time bank sync over the admin API).

Covers the channel that makes the ephemeral server's bank identical to a local one: export a bank
to a portable bundle, import it into another DB, and prove the rubric survives verbatim — including
``advisory`` gates and SOP citations resolved by document *name* (not id, which differs per DB).

All data here is synthetic (this is a public repo — no client content).
"""

import pytest

from app.interview.checklist_draft import ChecklistDraft, DraftItem
from app.models.sop import SopDocument
from app.services import bank_bundle_service, checklist_service, question_service

AUTH: dict = {}


@pytest.fixture(autouse=True)
def _admin_token(admin_auth):
    AUTH.clear()
    AUTH.update(admin_auth)
    yield


async def _seed_bank_with_rubric(db, sop_doc_id: str | None) -> str:
    """Create a synthetic default bank: 1 question + a 3-item rubric (incl. an advisory gate)."""
    bank = await question_service.create_bank(
        db, name="Synthetic Sync Bank", description="d", language="en-US", is_default=True
    )
    q = await question_service.add_question(
        db,
        bank_id=bank.id,
        text="Describe the inspection intake procedure.",
        order_index=0,
        language="en-US",
        expected_points='["identity check", "scope"]',
        max_follow_ups=1,
        follow_up_prompt="Tell me more.",
    )
    items = [
        DraftItem(kind="required", text="States identity verification", weight=60, order_index=0),
        DraftItem(kind="required", text="States scope confirmation", weight=40, order_index=1),
        DraftItem(
            kind="forbidden",
            text="Skips conflict-of-interest disclosure",
            weight=0,
            order_index=2,
            advisory=True,
            source_document_id=sop_doc_id,
            source_quote="COI must be disclosed",
            source_page="3",
        ),
    ]
    await checklist_service._persist_draft(
        db, q.id, ChecklistDraft(prompt_version="synthetic_v1", items=items)
    )
    await db.commit()
    return bank.id


async def _add_sop(db, name: str) -> str:
    doc = SopDocument(name=name, status="indexed", size=1, blob_path="")
    db.add(doc)
    await db.commit()
    await db.refresh(doc)
    return doc.id


async def test_export_carries_rubric_advisory_and_sop_name(db_session):
    doc_id = await _add_sop(db_session, "coi_policy.md")
    bank_id = await _seed_bank_with_rubric(db_session, doc_id)

    bundle = await bank_bundle_service.export_bank_bundle(db_session, bank_id)

    assert bundle["format_version"] == 1
    assert bundle["bank"]["name"] == "Synthetic Sync Bank"
    assert bundle["bank"]["is_default"] is True
    assert len(bundle["questions"]) == 1
    q = bundle["questions"][0]
    assert q["expected_points"] == ["identity check", "scope"]
    items = q["checklist"]["items"]
    assert len(items) == 3
    advisory = next(i for i in items if i["kind"] == "forbidden")
    assert advisory["advisory"] is True
    # SOP link travels as a NAME, never the per-DB id.
    assert advisory["source_document_name"] == "coi_policy.md"
    assert "source_document_id" not in advisory


async def test_import_round_trip_preserves_rubric_and_resolves_sop_by_name(db_session):
    # Export from a source bank (with its own doc id)...
    src_doc = await _add_sop(db_session, "coi_policy.md")
    src_bank = await _seed_bank_with_rubric(db_session, src_doc)
    bundle = await bank_bundle_service.export_bank_bundle(db_session, src_bank)

    # ...then simulate the server: delete the source bank, keep a same-named SOP doc with a
    # DIFFERENT id, and import. The citation must re-bind to the server's own doc id by name.
    await bank_bundle_service._delete_bank_cascade(db_session, src_bank)
    await db_session.commit()
    # give the server a different doc id for the same filename
    from sqlalchemy import delete

    from app.models.sop import SopDocument as _Doc

    await db_session.execute(delete(_Doc))
    await db_session.commit()
    server_doc = await _add_sop(db_session, "coi_policy.md")
    assert server_doc != src_doc

    result = await bank_bundle_service.import_bank_bundle(db_session, bundle)
    assert result.replaced is False
    assert result.question_count == 1
    assert result.checklist_item_count == 3
    assert result.unresolved_sop_names == []

    # The imported rubric's advisory item points at the SERVER's doc id.
    cl = await checklist_service.get_default_checklist(
        db_session,
        (await question_service.list_questions_for_bank(db_session, result.bank_id))[0].id,
    )
    assert cl is not None
    items = await checklist_service.list_items(db_session, cl.id)
    advisory = next(i for i in items if i.kind == "forbidden")
    assert advisory.advisory is True
    assert advisory.source_document_id == server_doc


async def test_import_is_idempotent_by_name(db_session):
    bank_id = await _seed_bank_with_rubric(db_session, None)
    bundle = await bank_bundle_service.export_bank_bundle(db_session, bank_id)

    # Re-importing the same-named bank replaces rather than duplicates.
    result = await bank_bundle_service.import_bank_bundle(db_session, bundle)
    assert result.replaced is True
    banks = [
        b for b in await question_service.list_banks(db_session) if b.name == bundle["bank"]["name"]
    ]
    assert len(banks) == 1


async def test_import_reports_unresolved_sop_names(db_session):
    doc_id = await _add_sop(db_session, "coi_policy.md")
    bank_id = await _seed_bank_with_rubric(db_session, doc_id)
    bundle = await bank_bundle_service.export_bank_bundle(db_session, bank_id)

    # Server has no matching SOP doc: import still succeeds, citation degrades to no link.
    from sqlalchemy import delete

    from app.models.sop import SopDocument as _Doc

    await bank_bundle_service._delete_bank_cascade(db_session, bank_id)
    await db_session.execute(delete(_Doc))
    await db_session.commit()

    result = await bank_bundle_service.import_bank_bundle(db_session, bundle)
    assert result.unresolved_sop_names == ["coi_policy.md"]
    cl = await checklist_service.get_default_checklist(
        db_session,
        (await question_service.list_questions_for_bank(db_session, result.bank_id))[0].id,
    )
    assert cl is not None
    items = await checklist_service.list_items(db_session, cl.id)
    advisory = next(i for i in items if i.kind == "forbidden")
    assert advisory.source_document_id is None  # degraded, but item still present


async def test_export_endpoint_requires_auth(client):
    assert (await client.get("/admin/question-banks/x/export")).status_code == 401


async def test_import_endpoint_requires_auth(client):
    assert (await client.post("/admin/question-banks/import", json={})).status_code == 401


async def test_export_import_endpoints_round_trip_over_http(client, db_session):
    doc_id = await _add_sop(db_session, "coi_policy.md")
    bank_id = await _seed_bank_with_rubric(db_session, doc_id)

    exported = (await client.get(f"/admin/question-banks/{bank_id}/export", headers=AUTH)).json()

    # Wipe the bank (keep the SOP doc) and re-import over HTTP.
    await bank_bundle_service._delete_bank_cascade(db_session, bank_id)
    await db_session.commit()

    resp = await client.post("/admin/question-banks/import", headers=AUTH, json=exported)
    assert resp.status_code == 201
    body = resp.json()
    assert body["question_count"] == 1
    assert body["checklist_item_count"] == 3
    assert body["unresolved_sop_names"] == []


async def test_import_endpoint_rejects_bad_bundle(client):
    resp = await client.post("/admin/question-banks/import", headers=AUTH, json={"questions": []})
    assert resp.status_code == 400


async def test_export_endpoint_404_on_missing_bank(client):
    resp = await client.get("/admin/question-banks/nonexistent/export", headers=AUTH)
    assert resp.status_code == 404
