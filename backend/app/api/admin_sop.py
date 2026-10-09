"""Admin SOP knowledge-base endpoints (SPEC F1). All routes require the admin bearer token.

SOP upload and listing are admin-only (``require_role("admin")``): the raw SOP corpus and its blob
pointers are interviewer/business internals (SPEC P3/P4). Candidates only ever see server-mediated
citation *text* surfaced during scoring/report, never these routes.

Upload runs the ingestion pipeline inline (extract → chunk → persist with page/section labels).
A corrupt or unsupported file is recorded as ``status="failed"`` and returned in the response, it
never 500s the request (F1 AC #4).
"""

import asyncio
from datetime import datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import get_settings
from app.db import get_db, get_session_factory
from app.dependencies import require_role
from app.models.sop import SopDocument
from app.services import (
    sop_document_service,
    sop_ingestion,
    sop_library_service,
    sop_section_service,
    sop_summary_service,
)
from app.sop.units import Unit, units

# Background section builds started by uploads and "Convert again"; held so they are not
# garbage-collected mid-run, and cancelled at shutdown (app.main).
_BUILDS: set[asyncio.Task] = set()

router = APIRouter(
    prefix="/admin/sop", tags=["admin-sop"], dependencies=[Depends(require_role("admin"))]
)


class SopDocumentOut(BaseModel):
    document_id: str
    name: str
    # The library the document belongs to (spec-sop-libraries).
    library_id: str = ""
    status: str
    size: int
    chunk_count: int
    # Sections (spec-sop-section-grounding): how the document was converted to Markdown
    # ("" = not yet: conversion runs in the background) and how many sections it split into.
    markdown_source: str = ""
    section_count: int = 0
    # The units it reads as (sections merged or opened to 500-4000 characters): what the tab shows.
    unit_count: int = 0
    # Why the conversion failed (all or nothing: a failed document has no sections), or why
    # converting again failed while the previous complete conversion was kept.
    markdown_error: str = ""
    # Queued for or in conversion right now (background).
    converting: bool = False
    # The key-points summary's state: "" none | draft | reviewed (used in scoring) | failed.
    summary_status: str = ""
    summary_error: str = ""
    # The summary itself (the SOP table shows it on one line), and where the document is cited:
    # a cited document is never deleted (owner, 2026-10-09).
    summary: str = ""
    cited_in: list[str] = []
    # Being drafted by the LLM right now (background).
    summarizing: bool = False


class SopSummaryOut(BaseModel):
    summary: str
    status: str
    error: str
    reviewed_at: datetime | None
    summarizing: bool


class SopSummaryIn(BaseModel):
    summary: str = Field(max_length=sop_summary_service.MAX_SUMMARY_CHARS)
    # True = approve: the summary is used in scoring. False = save as a draft (not used).
    approve: bool = False


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


class SopUnitOut(BaseModel):
    """A unit (sections merged or opened to 500-4000 characters): what the SOP tab lists, what
    search proposes and what a rubric item cites (spec-sop-conversion-and-sections §2)."""

    index: int
    label: str
    page_start: int
    page_end: int
    length: int
    # The citation that names it: section, through (a run), own (a section's own text only).
    section: str
    through: str
    own: bool
    piece: int  # 1-based piece of one long section's text; 0 = not a piece
    members: list[str]


class SopUnitTextOut(SopUnitOut):
    text: str


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


class SopLibraryOut(BaseModel):
    library_id: str
    name: str
    description: str
    document_count: int


class SopLibraryIn(BaseModel):
    name: str = Field(min_length=1, max_length=sop_library_service.MAX_NAME)
    description: str = ""


class SopLibraryPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=sop_library_service.MAX_NAME)
    description: str | None = None


def _library_out(library, document_count: int) -> SopLibraryOut:  # noqa: ANN001
    return SopLibraryOut(
        library_id=library.id,
        name=library.name,
        description=library.description,
        document_count=document_count,
    )


@router.get("/libraries", response_model=list[SopLibraryOut])
async def list_libraries(db: AsyncSession = Depends(get_db)) -> list[SopLibraryOut]:
    """Every SOP library with its document count, by name."""
    return [
        _library_out(r.library, r.document_count)
        for r in await sop_library_service.list_libraries(db)
    ]


def _library_error(exc: Exception) -> HTTPException:
    if isinstance(exc, sop_library_service.LibraryNotFound):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Library not found")
    if isinstance(
        exc,
        sop_library_service.LibraryNameTaken
        | sop_library_service.LibraryNotEmpty
        | sop_library_service.LibraryInUse,
    ):
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    # 422 literal: the constant was renamed across Starlette versions (as for 413 below).
    return HTTPException(status_code=422, detail=str(exc))


_LIBRARY_ERRORS = (
    sop_library_service.LibraryNotFound,
    sop_library_service.LibraryNameTaken,
    sop_library_service.LibraryNotEmpty,
    sop_library_service.LibraryNameInvalid,
    sop_library_service.LibraryInUse,
)


@router.post("/libraries", response_model=SopLibraryOut, status_code=status.HTTP_201_CREATED)
async def create_library(body: SopLibraryIn, db: AsyncSession = Depends(get_db)) -> SopLibraryOut:
    """A new, empty library. 409 when the name is taken."""
    try:
        library = await sop_library_service.create_library(db, body.name, body.description)
    except _LIBRARY_ERRORS as exc:
        raise _library_error(exc) from exc
    return _library_out(library, 0)


@router.patch("/libraries/{library_id}", response_model=SopLibraryOut)
async def update_library(
    library_id: str, body: SopLibraryPatch, db: AsyncSession = Depends(get_db)
) -> SopLibraryOut:
    """Rename a library or change its description."""
    try:
        library = await sop_library_service.update_library(
            db, library_id, name=body.name, description=body.description
        )
    except _LIBRARY_ERRORS as exc:
        raise _library_error(exc) from exc
    counts = {r.library.id: r.document_count for r in await sop_library_service.list_libraries(db)}
    return _library_out(library, counts.get(library.id, 0))


@router.delete("/libraries/{library_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_library(library_id: str, db: AsyncSession = Depends(get_db)) -> None:
    """Delete an empty library. 409 while it still holds documents or a bank is bound to it."""
    try:
        await sop_library_service.delete_library(db, library_id)
    except _LIBRARY_ERRORS as exc:
        raise _library_error(exc) from exc


@router.post("/documents", response_model=SopDocumentOut, status_code=status.HTTP_201_CREATED)
async def upload_document(
    file: UploadFile = File(...),
    library_id: str = Form(...),
    db: AsyncSession = Depends(get_db),
    session_factory: async_sessionmaker = Depends(get_session_factory),
) -> SopDocumentOut:
    """Upload one SOP file into a library and ingest it (spec-sop-libraries: the library is chosen
    first). A corrupt/unsupported file → status=failed, not 500. 404 when the library is unknown."""
    try:
        await sop_library_service.get_library(db, library_id)
    except sop_library_service.LibraryNotFound as exc:
        raise _library_error(exc) from exc
    content = await file.read()
    max_bytes = get_settings().material_max_size_mb * 1024 * 1024
    if len(content) > max_bytes:
        # 413 literal, not status.HTTP_413_* — the constant name differs across Starlette
        # versions (REQUEST_ENTITY vs CONTENT); the number is stable and warning-free.
        raise HTTPException(
            status_code=413,
            detail=f"File exceeds {get_settings().material_max_size_mb} MB limit",
        )
    try:
        result = await sop_ingestion.ingest_document(
            db,
            filename=file.filename or "upload",
            content=content,
            content_type=file.content_type or "",
            library_id=library_id,
        )
    except IntegrityError as exc:
        # The library was deleted between the check above and the insert.
        await db.rollback()
        raise _library_error(sop_library_service.LibraryNotFound(library_id)) from exc
    # Split into sections in the background (Document Intelligence takes seconds per document).
    _start_build(session_factory)
    return SopDocumentOut(
        document_id=result.document_id,
        name=result.name,
        library_id=library_id,
        status=result.status,
        size=len(content),
        chunk_count=result.chunk_count,
    )


@router.get("/documents", response_model=list[SopDocumentOut])
async def list_documents(db: AsyncSession = Depends(get_db)) -> list[SopDocumentOut]:
    """List ingested SOP documents with their chunk counts (admin knowledge-base view)."""
    rows = await sop_document_service.list_documents_with_chunk_counts(db)
    sections = await sop_section_service.section_counts(db)
    unit_counts = await sop_section_service.unit_counts(db)
    citations = await sop_document_service.document_citations(db)
    return [
        SopDocumentOut(
            document_id=d.id,
            name=d.name,
            library_id=d.library_id,
            status=d.status,
            size=d.size,
            chunk_count=chunk_count,
            markdown_source=d.markdown_source,
            section_count=sections.get(d.id, 0),
            unit_count=unit_counts.get(d.id, 0),
            markdown_error=d.markdown_error,
            converting=sop_section_service.converting(d.id),
            summary_status=d.summary_status,
            summary_error=d.summary_error,
            summarizing=sop_summary_service.drafting(d.id),
            summary=d.summary,
            cited_in=citations.get(d.id, []),
        )
        for d, chunk_count in rows
    ]


@router.delete("/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_document(document_id: str, db: AsyncSession = Depends(get_db)) -> None:
    """Delete an SOP that nothing cites (its sections, chunks and stored file go with it). 409,
    naming where, when a rubric, a published version or a report cites it: to replace a cited SOP,
    make a new bank or version without it (owner, 2026-10-09). 404 for an unknown document."""
    try:
        deleted = await sop_document_service.delete_document(db, document_id)
    except sop_document_service.DocumentInUse as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This SOP is cited and cannot be deleted: " + "; ".join(exc.where),
        ) from exc
    except sop_document_service.DocumentBusy as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This SOP is being converted or summarised: delete it when that has finished",
        ) from exc
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")


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


def _unit_out(unit: Unit) -> dict:
    section, through, own, piece = unit.citation()
    return {
        "index": unit.index,
        "label": unit.label,
        "page_start": unit.page_start,
        "page_end": unit.page_end,
        "length": unit.length,
        "section": section,
        "through": through,
        "own": own,
        "piece": piece,
        "members": [m.number for m in unit.members],
    }


@router.get("/documents/{document_id}/units", response_model=list[SopUnitOut])
async def list_units(document_id: str, db: AsyncSession = Depends(get_db)) -> list[SopUnitOut]:
    """The document's units in order (no text: :func:`unit_text` reads one)."""
    await _document(db, document_id)
    rows = await sop_section_service.list_sections(db, document_id)
    return [SopUnitOut(**_unit_out(u)) for u in units(rows)]


@router.get("/documents/{document_id}/units/{index}", response_model=SopUnitTextOut)
async def unit_text(
    document_id: str, index: int, db: AsyncSession = Depends(get_db)
) -> SopUnitTextOut:
    """One unit's passage as Markdown: every member section's heading and text, never cut."""
    await _document(db, document_id)
    found = units(await sop_section_service.list_sections(db, document_id))
    if not 0 <= index < len(found):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unit not found")
    return SopUnitTextOut(**_unit_out(found[index]), text=found[index].text)


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
        unit_count=(await sop_section_service.unit_counts(db)).get(document.id, 0),
        markdown_error=document.markdown_error,
        converting=True,
    )
    sop_section_service.mark_converting(document.id)
    _start(sop_section_service.rebuild(session_factory, document.id))
    return out


def _summary_out(document: SopDocument) -> SopSummaryOut:
    return SopSummaryOut(
        summary=document.summary,
        status=document.summary_status,
        error=document.summary_error,
        reviewed_at=document.summary_reviewed_at,
        summarizing=sop_summary_service.drafting(document.id),
    )


@router.get("/documents/{document_id}/summary", response_model=SopSummaryOut)
async def get_summary(document_id: str, db: AsyncSession = Depends(get_db)) -> SopSummaryOut:
    """The document's key-points summary and whether it is approved (only then used in scoring)."""
    return _summary_out(await _document(db, document_id))


@router.put("/documents/{document_id}/summary", response_model=SopSummaryOut)
async def save_summary(
    document_id: str, body: SopSummaryIn, db: AsyncSession = Depends(get_db)
) -> SopSummaryOut:
    """Save an admin's edit: approved (used in scoring) or a draft (not used)."""
    document = await _document(db, document_id)
    if sop_summary_service.drafting(document.id):
        raise HTTPException(
            status_code=409, detail="The summary is being drafted; save once the draft is done"
        )
    try:
        await sop_summary_service.save(db, document, body.summary, approve=body.approve)
    except sop_summary_service.SummaryNotSaved as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _summary_out(document)


@router.post(
    "/documents/{document_id}/summary/draft",
    response_model=SopSummaryOut,
    status_code=status.HTTP_202_ACCEPTED,
)
async def redraft_summary(
    document_id: str,
    db: AsyncSession = Depends(get_db),
    session_factory: async_sessionmaker = Depends(get_session_factory),
) -> SopSummaryOut:
    """Ask the LLM for a new draft, in the background. It replaces the current summary as a DRAFT:
    scoring stops using it until an admin approves again."""
    document = await _document(db, document_id)
    if not sop_summary_service.can_draft(document):
        raise HTTPException(status_code=409, detail="The document is not converted yet")
    if not sop_summary_service.drafting_available():
        raise HTTPException(status_code=409, detail="No AI model is configured to draft with")
    out = _summary_out(document)
    out.summarizing = True
    sop_summary_service.mark_drafting(document.id)
    _start(sop_summary_service.redraft(session_factory, document.id))
    return out
