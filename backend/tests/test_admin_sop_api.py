"""Admin SOP API (SPEC F1): auth guard, upload+ingest, list, and citation retrieval over HTTP."""

import pytest

from app.config import get_settings  # noqa: F401 — used by later tests in this module

AUTH: dict = {}


@pytest.fixture(autouse=True)
def _admin_token(monkeypatch, tmp_path, admin_auth):
    AUTH.clear()
    AUTH.update(admin_auth)
    # Keep uploaded bytes in a temp dir, not the repo.
    from app.services import storage

    monkeypatch.setattr(storage, "_STORES", {})
    monkeypatch.setattr(storage, "_default_root", lambda: str(tmp_path))
    yield


async def test_sop_routes_require_a_token(client):
    assert (await client.get("/admin/sop/documents")).status_code == 401
    assert (await client.post("/admin/sop/retrieve", json={"query": "x"})).status_code == 401


async def test_upload_txt_ingests_and_lists(client):
    files = {"file": ("sop.txt", b"Step one.\n\nStep two.", "text/plain")}
    resp = await client.post("/admin/sop/documents", headers=AUTH, files=files)
    assert resp.status_code == 201
    body = resp.json()
    assert body["status"] == "chunked"
    assert body["chunk_count"] >= 1
    assert body["name"] == "sop.txt"

    listing = await client.get("/admin/sop/documents", headers=AUTH)
    assert listing.status_code == 200
    docs = listing.json()
    assert len(docs) == 1
    assert docs[0]["chunk_count"] == body["chunk_count"]


async def test_upload_unsupported_file_is_recorded_failed_not_500(client):
    # AC #4: corrupt/unsupported file → status=failed, HTTP 201 (not a crash).
    files = {"file": ("broken.xyz", b"\x00\x01 not a doc", "application/octet-stream")}
    resp = await client.post("/admin/sop/documents", headers=AUTH, files=files)
    assert resp.status_code == 201
    assert resp.json()["status"] == "failed"
    assert resp.json()["chunk_count"] == 0


async def test_retrieve_returns_gated_citations(client):
    # AC #2/#3: mock adapter returns fully-attributed {title,url,page}; the gate drops partials.
    resp = await client.post(
        "/admin/sop/retrieve", headers=AUTH, json={"query": "safety procedure", "max_citations": 3}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["query"] == "safety procedure"
    for c in body["citations"]:
        # Every surfaced citation has all three required fields (strict gate, AC #3).
        assert c["title"] and c["url"] and c["page"]


async def test_upload_rejects_oversize(client, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "material_max_size_mb", 0)  # everything is "too big"
    files = {"file": ("sop.txt", b"x" * 10, "text/plain")}
    resp = await client.post("/admin/sop/documents", headers=AUTH, files=files)
    assert resp.status_code == 413
