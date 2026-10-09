"""Reading ingested SOP documents: the admin listing, and the one document a candidate may open.

Ingestion (writing them) lives in ``sop_ingestion``.
"""

import asyncio
import logging

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.interview import state_machine
from app.models.interview import InterviewSession
from app.models.sop import SopChunk, SopDocument
from app.services import storage

logger = logging.getLogger(__name__)


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
        return doc, await asyncio.to_thread(storage.load, doc.blob_path)
    except (FileNotFoundError, OSError):
        logger.warning(
            "SOP %s (%r) is cited but its bytes are missing: %s", doc.id, doc.name, doc.blob_path
        )
        return None


class DocumentInUse(Exception):
    """The document is cited somewhere (owner, 2026-10-09: a cited SOP is never deleted; make a
    new bank or version instead). ``where`` names each place, for the message."""

    def __init__(self, where: list[str]) -> None:
        super().__init__("; ".join(where))
        self.where = where


async def document_citations(db: AsyncSession, *, thorough: bool = False) -> dict[str, list[str]]:
    """For every document that is cited, where: a rubric (any, including replaced ones) or a
    published bank version; with ``thorough``, also a past interview's report or a relocation
    run's report. Uncited documents are absent.

    The document list (polled while anything converts) uses the quick form; the delete uses the
    thorough one, so a document cited only by an old report shows a Delete that answers 409."""
    from app.models.bank_version import BankVersion
    from app.models.checklist import Checklist, ChecklistItem
    from app.models.question import Question, QuestionBank
    from app.models.sop import CitationRun

    doc_ids = [d for (d,) in (await db.execute(select(SopDocument.id))).all()]
    found: dict[str, set[str]] = {}

    def note(text: str | None, place: str) -> None:
        if not text:
            return
        for doc_id in doc_ids:
            if doc_id in text:
                found.setdefault(doc_id, set()).add(place)

    rubric_rows = (
        await db.execute(
            select(QuestionBank.name, ChecklistItem.source_document_id, ChecklistItem.source_refs)
            .join(Checklist, Checklist.id == ChecklistItem.checklist_id)
            .join(Question, Question.id == Checklist.question_id)
            .join(QuestionBank, QuestionBank.id == Question.bank_id)
        )
    ).all()
    for bank, primary, refs in rubric_rows:
        note(f"{primary or ''} {refs or ''}", f"rubric of {bank}")
    version_rows = (
        await db.execute(
            select(QuestionBank.name, BankVersion.version_no, BankVersion.content_json).join(
                QuestionBank, QuestionBank.id == BankVersion.bank_id
            )
        )
    ).all()
    for bank, number, content in version_rows:
        note(content, f"{bank} v{number}")
    if thorough:
        reports = (
            await db.execute(
                select(InterviewSession.report_json).where(
                    InterviewSession.report_json.is_not(None)
                )
            )
        ).scalars()
        for report in reports:
            note(report, "interview reports")
        for run_report in (await db.execute(select(CitationRun.report_json))).scalars():
            note(run_report, "citation relocation reports")
    return {doc_id: sorted(places) for doc_id, places in found.items()}


class DocumentBusy(Exception):
    """The document is being converted or its summary drafted: deleting it now would leave the
    background work writing sections for a document that is gone."""


async def delete_document(db: AsyncSession, document_id: str) -> bool:
    """Delete an SOP that nothing cites: its chunks, sections and stored file go with it. False
    when there is no such document; :class:`DocumentInUse` when it is cited."""
    from sqlalchemy.exc import IntegrityError

    from app.models.sop import SopSection
    from app.services import sop_section_service, sop_summary_service

    if sop_section_service.converting(document_id) or sop_summary_service.drafting(document_id):
        raise DocumentBusy(document_id)
    # The row is locked for the check and the delete (PostgreSQL; a no-op on SQLite), so a rubric
    # saved meanwhile that cites it either waits or is refused by the foreign key below.
    document = (
        await db.execute(select(SopDocument).where(SopDocument.id == document_id).with_for_update())
    ).scalar_one_or_none()
    if document is None:
        return False
    where = (await document_citations(db, thorough=True)).get(document_id)
    if where:
        raise DocumentInUse(where)
    blob_path = document.blob_path
    await db.execute(delete(SopChunk).where(SopChunk.document_id == document_id))
    await db.execute(delete(SopSection).where(SopSection.document_id == document_id))
    await db.delete(document)
    try:
        await db.commit()
    except IntegrityError as exc:
        # Cited between the check and the commit: a rubric's foreign key refused the delete.
        await db.rollback()
        raise DocumentInUse(["a rubric saved while it was being deleted"]) from exc
    storage.remove(blob_path)  # after the commit: a failed delete leaves the row, not a hole
    return True
