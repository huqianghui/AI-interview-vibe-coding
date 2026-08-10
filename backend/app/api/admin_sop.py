"""Admin SOP knowledge-base endpoints (SPEC F1). All routes require the admin bearer token.

SOP upload, listing, and a citation-retrieval probe are admin-only (``require_admin``): the raw
SOP corpus and its blob pointers are interviewer/business internals (SPEC P3/P4). Candidates only
ever see server-mediated citation *text* surfaced during scoring/report, never these routes.

Upload runs the ingestion pipeline inline (extract → chunk → persist with page/section labels).
A corrupt or unsupported file is recorded as ``status="failed"`` and returned in the response, it
never 500s the request (F1 AC #4). Retrieval runs through the configured adapter (mock in dev/CI,
Azure with creds) and returns only fully-attributed ``{title, url, page}`` citations (AC #2/#3).
"""

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_db
from app.dependencies import require_role
from app.models.sop import SopChunk, SopDocument
from app.services import sop_ingestion
from app.services.agents.registry import get_retrieval_adapter

router = APIRouter(
    prefix="/admin/sop", tags=["admin-sop"], dependencies=[Depends(require_role("admin"))]
)


class SopDocumentOut(BaseModel):
    document_id: str
    name: str
    status: str
    size: int
    chunk_count: int


class CitationOut(BaseModel):
    title: str
    url: str
    page: str | int


class RetrieveIn(BaseModel):
    query: str
    max_citations: int = 3


class RetrieveOut(BaseModel):
    query: str
    citations: list[CitationOut]


@router.post("/documents", response_model=SopDocumentOut, status_code=status.HTTP_201_CREATED)
async def upload_document(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
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
    docs = (await db.execute(select(SopDocument).order_by(SopDocument.created_at))).scalars().all()
    count_rows = (
        await db.execute(
            select(SopChunk.document_id, func.count(SopChunk.id)).group_by(SopChunk.document_id)
        )
    ).all()
    counts: dict[str, int] = {doc_id: int(n) for doc_id, n in count_rows}
    return [
        SopDocumentOut(
            document_id=d.id,
            name=d.name,
            status=d.status,
            size=d.size,
            chunk_count=counts.get(d.id, 0),
        )
        for d in docs
    ]


@router.post("/retrieve", response_model=RetrieveOut)
async def retrieve(body: RetrieveIn) -> RetrieveOut:
    """Probe SOP citation retrieval (AC #2/#3): returns only fully-attributed {title,url,page}.

    Runs through the configured retrieval adapter (mock in dev/CI). The strict field gate lives in
    the adapter/``shape_citations`` — a citation missing any required field is dropped here, never
    surfaced. An empty list is the honest no-match signal, not an error.
    """
    adapter = get_retrieval_adapter()
    citations = await adapter.retrieve_citations(body.query, max_citations=body.max_citations)
    return RetrieveOut(
        query=body.query,
        citations=[CitationOut(**c) for c in citations],
    )
