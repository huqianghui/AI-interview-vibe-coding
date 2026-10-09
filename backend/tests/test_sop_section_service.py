"""SOP section storage, background conversion and the admin section API.

Spec: docs/planning/spec-sop-section-grounding.md.
"""

import asyncio

import pytest

from app.api import admin_sop
from app.models.sop import DEFAULT_LIBRARY_ID, SopDocument
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


async def _fail(monkeypatch, reason="page 3: 34%"):
    async def failed(_content, _name):
        return sop_markdown.MarkdownResult("", "failed", reason)

    monkeypatch.setattr(sop_section_service, "to_markdown", failed)


async def test_a_failed_conversion_keeps_no_sections_and_says_why(db_session, monkeypatch):
    doc = await _ingest(db_session)
    await _fail(monkeypatch)
    result = await sop_section_service.build(db_session, doc)
    assert (result.source, result.section_count, result.error) == ("failed", 0, "page 3: 34%")
    assert list(await sop_section_service.list_sections(db_session, doc.id)) == []
    assert (doc.markdown, doc.markdown_error) == ("", "page 3: 34%")


async def test_converting_again_and_failing_keeps_the_previous_complete_conversion(
    db_session, monkeypatch
):
    doc = await _ingest(db_session)
    await sop_section_service.build(db_session, doc)
    await _fail(monkeypatch, "TimeoutError")
    result = await sop_section_service.build(db_session, doc)
    assert (result.source, result.section_count) == ("text", 5)
    assert result.error == "converting again failed, the previous conversion is kept: TimeoutError"
    assert len(await sop_section_service.list_sections(db_session, doc.id)) == 5
    assert doc.markdown.startswith("# Widget SOP")


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


async def test_build_missing_retries_a_failed_conversion(db_session, monkeypatch):
    doc = await _ingest(db_session)
    real = sop_section_service.to_markdown
    await _fail(monkeypatch, "429")
    await sop_section_service.build(db_session, doc)
    assert doc.markdown_source == "failed"
    monkeypatch.setattr(sop_section_service, "to_markdown", real)
    assert await sop_section_service.build_missing(db_session._test_factory) == 1
    await db_session.refresh(doc)
    assert (doc.markdown_source, doc.markdown_error) == ("text", "")


async def test_build_missing_never_raises(caplog):
    def broken_factory():
        raise ConnectionError("database is stopped")

    assert await sop_section_service.build_missing(broken_factory) == 0
    assert "Converting SOP documents to sections failed" in caplog.text


async def test_full_lengths_match_each_full_text():
    from types import SimpleNamespace as S

    rows = [
        S(order_index=0, number="§0", title="", text="Intro.", parent_index=None),
        S(order_index=1, number="1", title="SCOPE", text="", parent_index=None),
        S(order_index=2, number="1.1", title="Sites", text="All sites.", parent_index=1),
        S(order_index=3, number="1.1.1", title="", text="", parent_index=2),
        S(order_index=4, number="§1", title="", text="", parent_index=None),
    ]
    assert sop_section_service.full_lengths(rows) == {
        r.order_index: len(sop_section_service.full_text(rows, r.order_index)) for r in rows
    }


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
    rebuilt = await client.post(f"/admin/sop/documents/{doc.id}/rebuild", headers=admin_auth)
    assert rebuilt.status_code == 202
    assert (rebuilt.json()["converting"], rebuilt.json()["section_count"]) == (True, 5)
    await asyncio.gather(*admin_sop._BUILDS)
    listed = (await client.get("/admin/sop/documents", headers=admin_auth)).json()
    row = next(d for d in listed if d["document_id"] == doc.id)
    assert (row["converting"], row["section_count"]) == (False, 5)

    missing = await client.get("/admin/sop/documents/nope/sections", headers=admin_auth)
    assert missing.status_code == 404
    gone = await client.get(f"/admin/sop/documents/{doc.id}/sections/999", headers=admin_auth)
    assert gone.status_code == 404


async def test_the_section_api_is_admin_only(client, db_session, candidate_auth):
    doc = await _ingest(db_session)
    resp = await client.get(f"/admin/sop/documents/{doc.id}/sections", headers=candidate_auth)
    assert resp.status_code == 403


async def test_an_upload_is_converted_to_sections_in_the_background(client, admin_auth):
    resp = await client.post(
        "/admin/sop/documents",
        headers=admin_auth,
        files={"file": ("widget.md", SOP_MD, "text/markdown")},
        data={"library_id": DEFAULT_LIBRARY_ID},
    )
    assert resp.status_code == 201
    await asyncio.gather(*admin_sop._BUILDS)
    listed = (await client.get("/admin/sop/documents", headers=admin_auth)).json()
    row = next(d for d in listed if d["document_id"] == resp.json()["document_id"])
    assert (row["markdown_source"], row["section_count"]) == ("text", 5)


async def test_an_outdated_converter_version_is_converted_again(db_session):
    doc = await _ingest(db_session)
    await sop_section_service.build(db_session, doc)
    assert doc.markdown_converter_version == 1
    assert await sop_section_service.build_missing(db_session._test_factory) == 0
    monkeypatch_versions = {**sop_section_service.CONVERTER_VERSIONS, "text": 2}
    sop_section_service.CONVERTER_VERSIONS.update(monkeypatch_versions)
    try:
        assert await sop_section_service.build_missing(db_session._test_factory) == 1
        await db_session.refresh(doc)
        assert doc.markdown_converter_version == 2
    finally:
        sop_section_service.CONVERTER_VERSIONS["text"] = 1


async def test_an_outdated_conversion_whose_file_is_gone_keeps_its_sections(db_session):
    doc = await _ingest(db_session)
    await sop_section_service.build(db_session, doc)
    doc.markdown_converter_version = 0  # an older converter produced it
    doc.blob_path = "/nowhere/widget.md"
    await db_session.commit()
    assert await sop_section_service.build_missing(db_session._test_factory) == 1
    await db_session.refresh(doc)
    assert (doc.markdown_source, doc.markdown_converter_version) == ("text", 0)
    assert len(await sop_section_service.list_sections(db_session, doc.id)) == 5
    assert doc.markdown_error.startswith("converting again failed")


async def test_resplit_splits_the_stored_markdown_again_without_converting(db_session, monkeypatch):
    """A splitter change alone needs no new conversion (v0.62.4.0): the stored Markdown is split
    again, the converter is never called, and a document never converted is left alone."""
    from sqlalchemy import select

    from app.models.sop import SopSection

    doc = await _ingest(db_session)
    await sop_section_service.build(db_session, doc)
    # The stored Markdown now carries a heading the old splitter missed.
    doc.markdown += "\n######## 3. RECORDS\n\nKept for 3 years.\n"
    await db_session.commit()

    async def no_conversion(*_a, **_k):
        raise AssertionError("resplit must not convert")

    monkeypatch.setattr(sop_section_service, "to_markdown", no_conversion)
    assert await sop_section_service.resplit(db_session, doc) == len(
        sop_section_service.parse_sections(doc.markdown)
    )
    rows = (
        await db_session.execute(
            select(SopSection.number)
            .where(SopSection.document_id == doc.id)
            .order_by(SopSection.order_index)
        )
    ).scalars()
    assert "3" in list(rows)

    never = SopDocument(name="new.pdf", status="uploaded", markdown_source="")
    db_session.add(never)
    await db_session.commit()
    assert await sop_section_service.resplit(db_session, never) == 0
