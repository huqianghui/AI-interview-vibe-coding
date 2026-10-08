"""Admin SOP knowledge-base endpoints (SPEC F1). All routes require the admin bearer token.

SOP upload and listing are admin-only (``require_role("admin")``): the raw SOP corpus and its blob
pointers are interviewer/business internals (SPEC P3/P4). Candidates only ever see server-mediated
citation *text* surfaced during scoring/report, never these routes.

Upload runs the ingestion pipeline inline (extract → chunk → persist with page/section labels).
A corrupt or unsupported file is recorded as ``status="failed"`` and returned in the response, it
never 500s the request (F1 AC #4).
"""

import asyncio

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import get_settings
from app.db import get_db, get_session_factory
from app.dependencies import require_role
from app.models.sop import SopDocument
from app.services import sop_document_service, sop_ingestion, sop_section_service

# Background section builds started by uploads and "Convert again"; held so they are not
# garbage-collected mid-run, and cancelled at shutdown (app.main).
_BUILDS: set[asyncio.Task] = set()

router = APIRouter(
    prefix="/admin/sop", tags=["admin-sop"], dependencies=[Depends(require_role("admin"))]
)


class SopDocumentOut(BaseModel):
    document_id: str
    name: str
    status: str
    size: int
    chunk_count: int
    # Sections (spec-sop-section-grounding): how the document was converted to Markdown
    # ("" = not yet: conversion runs in the background) and how many sections it split into.
    markdown_source: str = ""
    section_count: int = 0
    # Why the conversion failed (all or nothing: a failed document has no sections), or why
    # converting again failed while the previous complete conversion was kept.
    markdown_error: str = ""
    # Queued for or in conversion right now (background).
    converting: bool = False


class SopSectionOut(BaseModel):
    order_index: int
    number: str
    title: str
    level: int
    parent_index: int | None
    page_start: int
    page_end: int
    # Characters of the FULL section (own text + every subsection): what a citation hands over.
    full_length: int


class SopSectionTextOut(BaseModel):
    number: str
    title: str
    page_start: int
    page_end: int
    full_text: str


def _start(coro) -> None:  # noqa: ANN001 — a coroutine
    task = asyncio.create_task(coro)
    _BUILDS.add(task)
    task.add_done_callback(_BUILDS.discard)


def _start_build(session_factory: async_sessionmaker) -> None:
    _start(sop_section_service.build_missing(session_factory))


@router.post("/documents", response_model=SopDocumentOut, status_code=status.HTTP_201_CREATED)
async def upload_document(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    session_factory: async_sessionmaker = Depends(get_session_factory),
) -> SopDocumentOut:
    """Upload one SOP file and ingest it. A corrupt/unsupported file → status=failed, not 500."""
    content = await file.read()
    max_bytes = get_settings().material_max_size_mb * 1024 * 1024
    if len(content) > max_bytes:
        # 413 literal, not status.HTTP_413_* — the constant name differs across Starlette
        # versions (REQUEST_ENTITY vs CONTENT); the number is stable and warning-free.
        raise HTTPException(
            status_code=413,
            detail=f"File exceeds {get_settings().material_max_size_mb} MB limit",
        )
    result = await sop_ingestion.ingest_document(
        db,
        filename=file.filename or "upload",
        content=content,
        content_type=file.content_type or "",
    )
    # Split into sections in the background (Document Intelligence takes seconds per document).
    _start_build(session_factory)
    return SopDocumentOut(
        document_id=result.document_id,
        name=result.name,
        status=result.status,
        size=len(content),
        chunk_count=result.chunk_count,
    )


@router.get("/documents", response_model=list[SopDocumentOut])
async def list_documents(db: AsyncSession = Depends(get_db)) -> list[SopDocumentOut]:
    """List ingested SOP documents with their chunk counts (admin knowledge-base view)."""
    rows = await sop_document_service.list_documents_with_chunk_counts(db)
    sections = await sop_section_service.section_counts(db)
    return [
        SopDocumentOut(
            document_id=d.id,
            name=d.name,
            status=d.status,
            size=d.size,
            chunk_count=chunk_count,
            markdown_source=d.markdown_source,
            section_count=sections.get(d.id, 0),
            markdown_error=d.markdown_error,
            converting=sop_section_service.converting(d.id),
        )
        for d, chunk_count in rows
    ]


async def _document(db: AsyncSession, document_id: str) -> SopDocument:
    document = await db.get(SopDocument, document_id)
    if document is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    return document


@router.get("/documents/{document_id}/sections", response_model=list[SopSectionOut])
async def list_sections(
    document_id: str, db: AsyncSession = Depends(get_db)
) -> list[SopSectionOut]:
    """The document's sections in order, each with the length of its full passage."""
    await _document(db, document_id)
    rows = await sop_section_service.list_sections(db, document_id)
    lengths = sop_section_service.full_lengths(rows)
    return [
        SopSectionOut(
            order_index=s.order_index,
            number=s.number,
            title=s.title,
            level=s.level,
            parent_index=s.parent_index,
            page_start=s.page_start,
            page_end=s.page_end,
            full_length=lengths[s.order_index],
        )
        for s in rows
    ]


@router.get("/documents/{document_id}/sections/{order_index}", response_model=SopSectionTextOut)
async def section_text(
    document_id: str, order_index: int, db: AsyncSession = Depends(get_db)
) -> SopSectionTextOut:
    """One section's full passage: its own text and every subsection's, never truncated."""
    await _document(db, document_id)
    rows = await sop_section_service.list_sections(db, document_id)
    section = next((s for s in rows if s.order_index == order_index), None)
    if section is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Section not found")
    return SopSectionTextOut(
        number=section.number,
        title=section.title,
        page_start=section.page_start,
        page_end=sop_section_service.page_end(rows, order_index),
        full_text=sop_section_service.full_text(rows, order_index),
    )


@router.post(
    "/documents/{document_id}/rebuild",
    response_model=SopDocumentOut,
    status_code=status.HTTP_202_ACCEPTED,
)
async def rebuild_sections(
    document_id: str,
    db: AsyncSession = Depends(get_db),
    session_factory: async_sessionmaker = Depends(get_session_factory),
) -> SopDocumentOut:
    """Convert the document again in the background (after a converter improvement, or a failed
    conversion). Returns at once with ``converting`` set; the list shows the result when done. A
    failure keeps the previous complete conversion, if there is one."""
    document = await _document(db, document_id)
    counts = dict(
        (d.id, n) for d, n in await sop_document_service.list_documents_with_chunk_counts(db)
    )
    sections = await sop_section_service.section_counts(db)
    # The state BEFORE the rebuild: the task starts only after these reads.
    out = SopDocumentOut(
        document_id=document.id,
        name=document.name,
        status=document.status,
        size=document.size,
        chunk_count=counts.get(document.id, 0),
        markdown_source=document.markdown_source,
        section_count=sections.get(document.id, 0),
        markdown_error=document.markdown_error,
        converting=True,
    )
    sop_section_service.mark_converting(document.id)
    _start(sop_section_service.rebuild(session_factory, document.id))
    return out
