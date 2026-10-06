"""Admin SOP knowledge-base endpoints (SPEC F1). All routes require the admin bearer token.

SOP upload and listing are admin-only (``require_role("admin")``): the raw SOP corpus and its blob
pointers are interviewer/business internals (SPEC P3/P4). Candidates only ever see server-mediated
citation *text* surfaced during scoring/report, never these routes.

Upload runs the ingestion pipeline inline (extract → chunk → persist with page/section labels).
A corrupt or unsupported file is recorded as ``status="failed"`` and returned in the response, it
never 500s the request (F1 AC #4).
"""

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_db
from app.dependencies import require_role
from app.services import sop_document_service, sop_ingestion

router = APIRouter(
    prefix="/admin/sop", tags=["admin-sop"], dependencies=[Depends(require_role("admin"))]
)


class SopDocumentOut(BaseModel):
    document_id: str
    name: str
    status: str
    size: int
    chunk_count: int


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
    rows = await sop_document_service.list_documents_with_chunk_counts(db)
    return [
        SopDocumentOut(
            document_id=d.id,
            name=d.name,
            status=d.status,
            size=d.size,
            chunk_count=chunk_count,
        )
        for d, chunk_count in rows
    ]
