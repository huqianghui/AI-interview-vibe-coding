"""Reading ingested SOP documents: the admin listing, and the one document a candidate may open.

Ingestion (writing them) lives in ``sop_ingestion``.
"""

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.interview import state_machine
from app.models.interview import InterviewSession
from app.models.sop import SopChunk, SopDocument
from app.services.storage import get_storage


async def list_documents_with_chunk_counts(db: AsyncSession) -> list[tuple[SopDocument, int]]:
    """Every ingested document, oldest first, with how many chunks it was split into."""
    docs = (await db.execute(select(SopDocument).order_by(SopDocument.created_at))).scalars().all()
    count_rows = (
        await db.execute(
            select(SopChunk.document_id, func.count(SopChunk.id)).group_by(SopChunk.document_id)
        )
    ).all()
    counts: dict[str, int] = {doc_id: int(n) for doc_id, n in count_rows}
    return [(d, counts.get(d.id, 0)) for d in docs]


async def load_cited_document(
    db: AsyncSession, session: InterviewSession, document_id: str
) -> tuple[SopDocument, bytes] | None:
    """The document and its bytes, but only when THIS interview's report cites it.

    The citation scope is the IDOR guard (SPEC P4/P12): ``document_id`` must be cited by a
    default-checklist item of a question this interview answered (``cited_document_ids``). None
    for an uncited id, an unknown one, a row with no stored file, or bytes that are gone (e.g. a
    pruned storage root), so the caller can answer all of them with one 404.
    """
    if document_id not in await state_machine.cited_document_ids(db, session):
        return None
    doc = (
        await db.execute(select(SopDocument).where(SopDocument.id == document_id))
    ).scalar_one_or_none()
    if doc is None or not doc.blob_path:
        return None
    try:
        return doc, get_storage().load(doc.blob_path)
    except (FileNotFoundError, OSError):
        return None
