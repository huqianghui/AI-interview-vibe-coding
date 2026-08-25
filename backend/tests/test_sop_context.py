"""Read-side SOP source-context reassembly (feature C/D shared data entry): ``get_source_context``.

Covers the four behaviours the scoring/coverage paths rely on: order-by-chunk-index assembly,
page-label preference, max_chars truncation, and graceful "" on missing data (no document, unknown
document, empty corpus, non-positive budget) so the scoring path degrades to quote-only.
"""

import pytest

from app.models.sop import SopChunk, SopDocument
from app.services import sop_context


async def _doc_with_chunks(db, chunks: list[tuple[int, str, str | None]]) -> str:
    """Persist a document + chunks as ``(chunk_index, content, page_label)`` and return its id."""
    doc = SopDocument(name="sop.txt", status="chunked", size=1)
    db.add(doc)
    await db.flush()
    for idx, content, page in chunks:
        db.add(
            SopChunk(
                document_id=doc.id,
                chunk_index=idx,
                content=content,
                page_label=page,
                token_count=max(1, len(content) // 4),
            )
        )
    await db.commit()
    return doc.id


@pytest.mark.asyncio
async def test_assembles_chunks_in_index_order(db_session):
    doc_id = await _doc_with_chunks(
        db_session,
        [(1, "second segment", "body"), (0, "first segment", "body")],
    )
    text = await sop_context.get_source_context(db_session, document_id=doc_id)
    # Ordered by chunk_index, not insertion order.
    assert text == "first segment\nsecond segment"


@pytest.mark.asyncio
async def test_page_label_prefers_matching_chunks(db_session):
    doc_id = await _doc_with_chunks(
        db_session,
        [(0, "page one text", "p.1"), (1, "page two text", "p.2"), (2, "more page two", "p.2")],
    )
    text = await sop_context.get_source_context(db_session, document_id=doc_id, page_label="p.2")
    assert "page two text" in text
    assert "more page two" in text
    assert "page one text" not in text  # only the matching-label chunks are used


@pytest.mark.asyncio
async def test_page_label_no_match_falls_back_to_whole_doc(db_session):
    doc_id = await _doc_with_chunks(db_session, [(0, "only body", "body")])
    text = await sop_context.get_source_context(db_session, document_id=doc_id, page_label="p.99")
    # A label that matches nothing degrades to the document's leading chunks, not "".
    assert text == "only body"


@pytest.mark.asyncio
async def test_truncates_to_max_chars(db_session):
    long = "word " * 400  # ~2000 chars
    doc_id = await _doc_with_chunks(db_session, [(0, long, "body")])
    text = await sop_context.get_source_context(db_session, document_id=doc_id, max_chars=100)
    assert len(text) <= 101  # cap + the single "…" marker
    assert text.endswith("…")


@pytest.mark.asyncio
async def test_missing_or_empty_returns_blank(db_session):
    # No document id at all.
    assert await sop_context.get_source_context(db_session, document_id=None) == ""
    # Unknown document id.
    assert await sop_context.get_source_context(db_session, document_id="does-not-exist") == ""
    # Real document but a non-positive budget.
    doc_id = await _doc_with_chunks(db_session, [(0, "text", "body")])
    assert await sop_context.get_source_context(db_session, document_id=doc_id, max_chars=0) == ""
