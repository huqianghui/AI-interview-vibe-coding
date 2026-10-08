"""SOP section storage, background conversion and the admin section API.

Spec: docs/planning/spec-sop-section-grounding.md.
"""

import pytest

from app.models.sop import SopDocument
from app.services import sop_ingestion, sop_markdown, sop_section_service, storage

pytestmark = pytest.mark.asyncio

SOP_MD = b"""# Widget SOP

## 1. PURPOSE

Why widgets are inspected.

## 2. RESPONSIBILITIES

2.1 Inspector: checks every widget.

2.2 Supervisor: reviews the log.
"""


@pytest.fixture(autouse=True)
def _local_store(monkeypatch, tmp_path):
    monkeypatch.setattr(storage, "_STORES", {})
    monkeypatch.setattr(storage, "_default_root", lambda: str(tmp_path))


async def _ingest(db, name="widget.md", content=SOP_MD) -> SopDocument:
    result = await sop_ingestion.ingest_document(db, filename=name, content=content)
    return await db.get(SopDocument, result.document_id)


async def test_build_stores_the_markdown_and_every_section(db_session):
    doc = await _ingest(db_session)
    assert doc.markdown_source == ""  # ingestion never converts inline
    result = await sop_section_service.build(db_session, doc)
    assert (result.source, result.section_count, result.error) == ("text", 5, "")
    rows = await sop_section_service.list_sections(db_session, doc.id)
    assert [r.number for r in rows] == ["§1", "1", "2", "2.1", "2.2"]
    two = next(r for r in rows if r.number == "2")
    assert sop_section_service.full_text(rows, two.order_index) == (
        "2 RESPONSIBILITIES\n\n2.1 Inspector: checks every widget."
        "\n\n2.2 Supervisor: reviews the log."
    )
    assert doc.markdown.startswith("# Widget SOP")


async def test_a_failed_conversion_keeps_no_sections_and_says_why(db_session, monkeypatch):
    doc = await _ingest(db_session)
    await sop_section_service.build(db_session, doc)

    async def failed(_content, _name):
        return sop_markdown.MarkdownResult("", "failed", "page 3: 34%")

    monkeypatch.setattr(sop_section_service, "to_markdown", failed)
    result = await sop_section_service.build(db_session, doc)
    assert (result.source, result.section_count, result.error) == ("failed", 0, "page 3: 34%")
    assert list(await sop_section_service.list_sections(db_session, doc.id)) == []
    assert (doc.markdown, doc.markdown_error) == ("", "page 3: 34%")


async def test_a_document_without_stored_bytes_fails_cleanly(db_session):
    doc = SopDocument(name="gone.pdf", blob_path="/nowhere/gone.pdf", status="chunked")
    db_session.add(doc)
    await db_session.commit()
    result = await sop_section_service.build(db_session, doc)
    assert (result.source, result.error) == ("failed", "no stored file to convert")


async def test_build_missing_converts_only_unconverted_documents(db_session):
    first = await _ingest(db_session, "a.md")
    second = await _ingest(db_session, "b.md")
    await sop_section_service.build(db_session, first)
    assert await sop_section_service.build_missing(db_session._test_factory) == 1
    await db_session.refresh(second)
    assert second.markdown_source == "text"
    assert await sop_section_service.build_missing(db_session._test_factory) == 0


async def test_admin_section_api(client, db_session, admin_auth):
    doc = await _ingest(db_session)
    await sop_section_service.build(db_session, doc)
    listed = (await client.get("/admin/sop/documents", headers=admin_auth)).json()
    row = next(d for d in listed if d["document_id"] == doc.id)
    assert (row["markdown_source"], row["section_count"], row["markdown_error"]) == ("text", 5, "")

    sections = (
        await client.get(f"/admin/sop/documents/{doc.id}/sections", headers=admin_auth)
    ).json()
    two = next(s for s in sections if s["number"] == "2")
    assert two["full_length"] > len("2 RESPONSIBILITIES")
    text = (
        await client.get(
            f"/admin/sop/documents/{doc.id}/sections/{two['order_index']}", headers=admin_auth
        )
    ).json()
    assert "2.2 Supervisor" in text["full_text"]
    rebuilt = (
        await client.post(f"/admin/sop/documents/{doc.id}/rebuild", headers=admin_auth)
    ).json()
    assert rebuilt["section_count"] == 5

    missing = await client.get("/admin/sop/documents/nope/sections", headers=admin_auth)
    assert missing.status_code == 404
    gone = await client.get(f"/admin/sop/documents/{doc.id}/sections/999", headers=admin_auth)
    assert gone.status_code == 404


async def test_the_section_api_is_admin_only(client, db_session, candidate_auth):
    doc = await _ingest(db_session)
    resp = await client.get(f"/admin/sop/documents/{doc.id}/sections", headers=candidate_auth)
    assert resp.status_code == 403
