"""SOP ingestion pipeline (SPEC F1): upload → extract → chunk → persist with traceability labels.

One entry point, :func:`ingest_document`, ties the pieces together:

1. Persist the raw bytes via the pluggable blob store (kept out of the DB; P4 — candidates never
   get a direct blob URL, only server-mediated citation text later).
2. Record a ``SopDocument`` row immediately, so a corrupt/empty file is still tracked (AC #4:
   fails gracefully, never crashes the batch — the row just ends ``status="failed"``).
3. Extract **segments** ``[(label, text), ...]`` preserving the page/slide boundary, chunk each
   segment, and persist one ``SopChunk`` per chunk carrying that segment's ``page_label`` (AC #1:
   chunks persisted with page/section labels).

Pure-DB + pure-extraction: no Azure, no embedding push here (that's the index-push half, gated on
live creds). The chunker and the segment dispatcher are the CI-covered core; the binary parsers
degrade to empty on a missing dep, which this service treats as a graceful ``failed`` ingest.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.sop import SopChunk, SopDocument
from app.sop.extraction import chunk_text, extract_segments


@dataclass(frozen=True)
class IngestResult:
    """Outcome of ingesting one document — what the upload endpoint returns per file."""

    document_id: str
    name: str
    status: str  # "chunked" (success) | "failed" (no extractable text)
    chunk_count: int


async def ingest_document(
    db: AsyncSession,
    *,
    filename: str,
    content: bytes,
    content_type: str = "",
    storage_key: str | None = None,
) -> IngestResult:
    """Ingest one uploaded SOP file end to end. Never raises on bad content (AC #4).

    The document row is written first and always committed, so an unsupported or corrupt file is
    recorded with ``status="failed"`` rather than vanishing. Chunks are persisted with the page/
    section label of the segment they came from (AC #1).
    """
    # Lazy import so the storage backend (and its config) is resolved at call time, and tests can
    # override it. Local filesystem in dev/CI.
    from app.services.storage import get_storage

    store = get_storage()
    key = storage_key or f"{filename}"
    try:
        blob_path = store.save(key, content)
    except Exception:  # noqa: BLE001 — storage failure shouldn't lose the document record
        blob_path = ""

    document = SopDocument(
        name=filename,
        blob_path=blob_path,
        content_type=content_type,
        size=len(content),
        status="extracting",
    )
    db.add(document)
    await db.flush()  # assign document.id before writing chunks

    segments = extract_segments(content, filename)
    chunk_index = 0
    for label, seg_text in segments:
        for piece in chunk_text(seg_text):
            db.add(
                SopChunk(
                    document_id=document.id,
                    chunk_index=chunk_index,
                    content=piece,
                    page_label=label,
                    section_path=None,
                    token_count=_estimate_tokens(piece),
                )
            )
            chunk_index += 1

    # No extractable text (unknown type, corrupt file, or missing parser) → recorded failure, not
    # a crash. A document with at least one chunk is "chunked" (ready for the index-push half).
    document.status = "chunked" if chunk_index > 0 else "failed"
    await db.commit()
    await db.refresh(document)

    return IngestResult(
        document_id=document.id,
        name=document.name,
        status=document.status,
        chunk_count=chunk_index,
    )


def _estimate_tokens(text: str) -> int:
    """Rough token estimate (~4 chars/token). Good enough for a size hint; not a billing figure."""
    return max(1, len(text) // 4)
