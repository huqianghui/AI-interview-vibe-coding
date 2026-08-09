"""SOP ingestion pipeline (SPEC F1): segment extraction, chunk persistence with labels, and the
graceful-failure path for unsupported/corrupt files (AC #1, AC #4)."""

import pytest

from app.models.sop import SopChunk, SopDocument
from app.services import sop_ingestion
from app.sop.extraction import extract_segments


def test_extract_segments_plain_text_one_body_segment():
    segs = extract_segments(b"hello world\n\nsecond para", "notes.txt")
    assert segs == [("body", "hello world\n\nsecond para")]


def test_extract_segments_markdown_labelled_body():
    segs = extract_segments(b"# Title\n\nbody text", "readme.md")
    assert len(segs) == 1
    assert segs[0][0] == "body"


def test_extract_segments_empty_is_no_segments():
    assert extract_segments(b"   \n  ", "blank.txt") == []


def test_extract_segments_unknown_type_is_no_segments():
    # AC #4 foundation: an unsupported extension yields no segments (→ graceful failed ingest).
    assert extract_segments(b"\x00\x01binary", "mystery.xyz") == []


async def _chunks_for(db, document_id: str):
    from sqlalchemy import select

    return (
        (
            await db.execute(
                select(SopChunk)
                .where(SopChunk.document_id == document_id)
                .order_by(SopChunk.chunk_index)
            )
        )
        .scalars()
        .all()
    )


@pytest.mark.asyncio
async def test_ingest_txt_persists_document_and_labelled_chunks(db_session, tmp_path, monkeypatch):
    # Point the local blob store at a temp dir so the test writes nowhere permanent.
    from app.services import storage

    monkeypatch.setattr(storage, "_STORES", {})
    monkeypatch.setattr(storage, "_default_root", lambda: str(tmp_path))

    result = await sop_ingestion.ingest_document(
        db_session,
        filename="sop.txt",
        content=b"Step one: verify the guard.\n\nStep two: log the result.",
        content_type="text/plain",
    )
    assert result.status == "chunked"
    assert result.chunk_count >= 1

    doc = await db_session.get(SopDocument, result.document_id)
    assert doc is not None
    assert doc.status == "chunked"
    assert doc.size > 0

    chunks = await _chunks_for(db_session, result.document_id)
    assert len(chunks) == result.chunk_count
    # AC #1: every chunk carries a page/section label (here the plain-text "body" label).
    assert all(c.page_label == "body" for c in chunks)
    assert all(c.token_count >= 1 for c in chunks)


@pytest.mark.asyncio
async def test_ingest_unsupported_file_fails_gracefully(db_session, tmp_path, monkeypatch):
    # AC #4: a corrupt/unsupported file is recorded as failed, never crashes ingestion.
    from app.services import storage

    monkeypatch.setattr(storage, "_STORES", {})
    monkeypatch.setattr(storage, "_default_root", lambda: str(tmp_path))

    result = await sop_ingestion.ingest_document(
        db_session,
        filename="broken.xyz",
        content=b"\x00\x01\x02 not a document",
        content_type="application/octet-stream",
    )
    assert result.status == "failed"
    assert result.chunk_count == 0

    doc = await db_session.get(SopDocument, result.document_id)
    assert doc is not None and doc.status == "failed"  # row persisted despite no extractable text
    assert await _chunks_for(db_session, result.document_id) == []


@pytest.mark.asyncio
async def test_ingest_survives_storage_failure(db_session, monkeypatch):
    # A blob-store write failure must not lose the document record (blob_path just stays empty).
    from app.services import storage

    class _BoomStore:
        name = "boom"

        def save(self, key, content):
            raise OSError("disk full")

        def load(self, blob_path):
            raise OSError

    monkeypatch.setattr(storage, "get_storage", lambda name=None: _BoomStore())

    result = await sop_ingestion.ingest_document(
        db_session, filename="sop.txt", content=b"some content here", content_type="text/plain"
    )
    assert result.status == "chunked"
    doc = await db_session.get(SopDocument, result.document_id)
    assert doc is not None and doc.blob_path == ""
