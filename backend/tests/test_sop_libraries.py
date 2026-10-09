"""SOP libraries (spec-sop-libraries): every document in one library, chosen before upload."""

import asyncio

import pytest

from app.api import admin_sop
from app.models.sop import DEFAULT_LIBRARY_ID, SopDocument, SopLibrary
from app.services import sop_ingestion, sop_library_service

pytestmark = pytest.mark.asyncio

BASE = "/admin/sop/libraries"


def _upload(name: str, library_id: str | None) -> dict:
    files = {"file": (name, b"1 PURPOSE\nSign within 24 hours.\n", "text/plain")}
    data = {"library_id": library_id} if library_id is not None else {}
    return {"files": files, "data": data}


async def _post_upload(client, auth, name: str, library_id: str | None):  # noqa: ANN001
    """Upload, then wait for the background conversion it starts: it shares the test database,
    and a request racing it on the one SQLite connection fails ("SQL statements in progress")."""
    resp = await client.post("/admin/sop/documents", headers=auth, **_upload(name, library_id))
    await asyncio.gather(*admin_sop._BUILDS)
    return resp


async def test_libraries_are_created_renamed_and_listed_with_their_counts(client, admin_auth):
    made = await client.post(BASE, headers=admin_auth, json={"name": "  Clinical   SOPs "})
    assert made.status_code == 201 and made.json()["name"] == "Clinical SOPs"
    lib = made.json()["library_id"]
    up = await _post_upload(client, admin_auth, "a.txt", lib)
    assert up.status_code == 201 and up.json()["library_id"] == lib

    listed = {x["name"]: x for x in (await client.get(BASE, headers=admin_auth)).json()}
    assert listed["Clinical SOPs"]["document_count"] == 1
    assert listed["SOP library"]["document_count"] == 0  # the default one, from the migration

    renamed = await client.patch(f"{BASE}/{lib}", headers=admin_auth, json={"name": "Quality SOPs"})
    assert renamed.json()["name"] == "Quality SOPs" and renamed.json()["document_count"] == 1
    docs = (await client.get("/admin/sop/documents", headers=admin_auth)).json()
    assert [d["library_id"] for d in docs] == [lib]


async def test_a_name_is_unique_and_never_blank(client, admin_auth):
    assert (await client.post(BASE, headers=admin_auth, json={"name": "A"})).status_code == 201
    taken = await client.post(BASE, headers=admin_auth, json={"name": "A"})
    assert taken.status_code == 409
    blank = await client.post(BASE, headers=admin_auth, json={"name": "   "})
    assert blank.status_code == 422
    other = (await client.post(BASE, headers=admin_auth, json={"name": "B"})).json()
    clash = await client.patch(
        f"{BASE}/{other['library_id']}", headers=admin_auth, json={"name": "A"}
    )
    assert clash.status_code == 409
    assert (
        await client.patch(f"{BASE}/nope", headers=admin_auth, json={"name": "C"})
    ).status_code == 404


async def test_a_library_that_holds_documents_cannot_be_deleted(client, admin_auth):
    lib = (await client.post(BASE, headers=admin_auth, json={"name": "Full"})).json()["library_id"]
    await _post_upload(client, admin_auth, "a.txt", lib)
    held = await client.delete(f"{BASE}/{lib}", headers=admin_auth)
    assert held.status_code == 409
    empty = (await client.post(BASE, headers=admin_auth, json={"name": "Empty"})).json()[
        "library_id"
    ]
    assert (await client.delete(f"{BASE}/{empty}", headers=admin_auth)).status_code == 204
    names = [x["name"] for x in (await client.get(BASE, headers=admin_auth)).json()]
    assert "Empty" not in names and "Full" in names


async def test_an_upload_names_a_library_that_exists(client, admin_auth):
    none = await _post_upload(client, admin_auth, "a.txt", None)
    assert none.status_code == 422  # the library is chosen first
    unknown = await client.post(
        "/admin/sop/documents", headers=admin_auth, **_upload("a.txt", "nope")
    )
    assert unknown.status_code == 404
    assert (await client.get("/admin/sop/documents", headers=admin_auth)).json() == []


async def test_only_an_admin_manages_libraries(client, candidate_auth):
    assert (await client.get(BASE, headers=candidate_auth)).status_code == 403
    assert (await client.post(BASE, headers=candidate_auth, json={"name": "X"})).status_code == 403


async def test_a_document_stored_without_a_library_goes_to_the_default_one(db_session):
    # Deleted while empty, the default library comes back for the next such document.
    await sop_library_service.delete_library(db_session, DEFAULT_LIBRARY_ID)
    assert await db_session.get(SopLibrary, DEFAULT_LIBRARY_ID) is None

    result = await sop_ingestion.ingest_document(
        db_session, filename="boot.txt", content=b"1 A\nx\n"
    )
    doc = await db_session.get(SopDocument, result.document_id)
    assert doc.library_id == DEFAULT_LIBRARY_ID
    assert await db_session.get(SopLibrary, DEFAULT_LIBRARY_ID) is not None


async def test_a_document_arriving_during_a_delete_keeps_the_library(db_session, monkeypatch):
    lib = await sop_library_service.create_library(db_session, "Racing")
    lib_id = lib.id
    real_scalar = db_session.scalar

    async def count_then_upload(stmt):  # noqa: ANN001
        held = await real_scalar(stmt)
        # Someone uploads into the library right after it was counted empty.
        db_session.add(SopDocument(name="late.txt", library_id=lib_id, status="chunked"))
        await db_session.flush()
        return held

    monkeypatch.setattr(db_session, "scalar", count_then_upload)
    with pytest.raises(sop_library_service.LibraryNotEmpty):
        await sop_library_service.delete_library(db_session, lib_id)


async def test_an_upload_into_a_library_deleted_mid_request_is_a_404(
    client, admin_auth, monkeypatch
):
    lib = (await client.post(BASE, headers=admin_auth, json={"name": "Gone"})).json()["library_id"]
    real_get = sop_library_service.get_library

    async def found_then_deleted(db, library_id):  # noqa: ANN001
        library = await real_get(db, library_id)
        await db.delete(library)  # deleted right after the check
        await db.commit()
        return library

    monkeypatch.setattr(sop_library_service, "get_library", found_then_deleted)
    resp = await _post_upload(client, admin_auth, "a.txt", lib)
    assert resp.status_code == 404


async def test_a_library_a_bank_is_bound_to_cannot_be_deleted(client, db_session, admin_auth):
    from app.services import question_service

    lib = (await client.post(BASE, headers=admin_auth, json={"name": "Bound"})).json()["library_id"]
    bank = await question_service.create_bank(db_session, name="Uses it")
    bank.sop_library_id = lib
    await db_session.commit()
    held = await client.delete(f"{BASE}/{lib}", headers=admin_auth)
    assert held.status_code == 409 and "Uses it" in held.json()["detail"]
