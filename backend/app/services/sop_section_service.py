"""SOP sections: convert a document to Markdown, split it, store it, read cited passages back.

Spec: docs/planning/spec-sop-section-grounding.md. Conversion calls Azure Document Intelligence
(~15 s per 20-page PDF), so it never runs inside a request or before startup: the client importer
ingests ~24 documents BEFORE uvicorn starts (entrypoint.sh), and converting them there would blow
the container's startup probe. :func:`build_missing` runs as a background task after startup and
after each upload, converting every document that has not been converted yet.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.sop import SopDocument, SopSection
from app.services import sop_summary_service, storage
from app.services.sop_markdown import CONVERTER_VERSIONS, MarkdownResult, to_markdown
from app.sop.sections import heading_block, parse_sections

logger = logging.getLogger(__name__)

# One build at a time per process: two overlapping runs (boot, an upload, an admin's "Convert
# again") would convert the same document twice and race on its section rows. Every build goes
# through :func:`build_missing` or :func:`rebuild`, both of which hold this lock.
_BUILD_LOCK = asyncio.Lock()
# Documents queued for or in conversion right now, so the admin list can say so.
_CONVERTING: set[str] = set()
# Sources a document still needs converting from: never tried, or tried and failed (a throttled or
# timed-out call at boot must not stay failed until someone notices).
_NEEDS_CONVERTING = ("", "failed")


def _needs_converting_clause():  # noqa: ANN202 — a SQLAlchemy clause
    """Never converted, failed, or converted by an older version of its converter."""
    outdated = [
        and_(
            SopDocument.markdown_source == source,
            SopDocument.markdown_converter_version < version,
        )
        for source, version in CONVERTER_VERSIONS.items()
    ]
    return or_(SopDocument.markdown_source.in_(_NEEDS_CONVERTING), *outdated)


def needs_converting(document: SopDocument) -> bool:
    if document.markdown_source in _NEEDS_CONVERTING:
        return True
    current = CONVERTER_VERSIONS.get(document.markdown_source, 0)
    return document.markdown_converter_version < current


def converting(document_id: str) -> bool:
    return document_id in _CONVERTING


def mark_converting(document_id: str) -> None:
    """Show a document as converting as soon as a rebuild is asked for, before its task runs."""
    _CONVERTING.add(document_id)


@dataclass(frozen=True)
class BuildResult:
    document_id: str
    source: str
    section_count: int
    error: str = ""


async def _replace_sections(db: AsyncSession, document: SopDocument, parsed: list) -> None:
    await db.execute(delete(SopSection).where(SopSection.document_id == document.id))
    for index, section in enumerate(parsed):
        db.add(
            SopSection(
                document_id=document.id,
                order_index=index,
                number=section.number,
                title=section.title,
                level=section.level,
                parent_index=section.parent,
                page_start=section.page_start,
                page_end=section.page_end,
                text=section.text,
            )
        )


async def resplit(db: AsyncSession, document: SopDocument) -> int:
    """Split a converted document's stored Markdown again and replace its sections, without
    converting it again: what a change to the splitter alone needs (no Document Intelligence
    call). A document with no stored Markdown is left as it is. Commits; returns the count."""
    if not document.markdown or document.markdown_source in _NEEDS_CONVERTING:
        return 0
    parsed = parse_sections(document.markdown)
    await _replace_sections(db, document, parsed)
    await db.commit()
    return len(parsed)


async def build(
    db: AsyncSession, document: SopDocument, content: bytes | None = None
) -> BuildResult:
    """(Re)convert one document and replace its sections. Commits."""
    if content is None:
        try:
            content = await asyncio.to_thread(storage.load, document.blob_path)
        except (FileNotFoundError, OSError):
            logger.warning("SOP %s (%r) has no stored bytes to convert", document.id, document.name)
            content = b""
    if content:
        converted = await to_markdown(content, document.name)
    else:
        converted = MarkdownResult("", "failed", "no stored file to convert")
    if converted.source == "failed" and document.markdown_source not in _NEEDS_CONVERTING:
        # Converting again failed, but the document already has a complete conversion: keep it
        # (and its version, so the next build tries again if that version is outdated). One
        # transient error, or a missing file, must not leave a document that was fine with none.
        document.markdown_error = (
            "converting again failed, the previous conversion is kept: " + converted.error
        )[:1000]
        await db.commit()
        logger.warning("SOP %r: %s", document.name, document.markdown_error)
        kept = (
            await db.execute(
                select(func.count(SopSection.id)).where(SopSection.document_id == document.id)
            )
        ).scalar_one()
        return BuildResult(
            document_id=document.id,
            source=document.markdown_source,
            section_count=int(kept),
            error=document.markdown_error,
        )
    # All or nothing: a failed conversion leaves NO sections (never a partial set) and says why.
    parsed = parse_sections(converted.markdown) if converted.source != "failed" else []
    await _replace_sections(db, document, parsed)
    document.markdown = converted.markdown
    document.markdown_source = converted.source
    document.markdown_error = converted.error
    document.markdown_converter_version = CONVERTER_VERSIONS.get(converted.source, 0)
    # An approved summary stays approved: it summarises the document, and an SOP file is never
    # changed in place (a new version is a new upload), so a re-conversion does not change what
    # the document says.
    await db.commit()
    if converted.error:
        logger.warning("SOP %r not converted: %s", document.name, converted.error)
    else:
        logger.info("SOP %r → %s, %d sections", document.name, converted.source, len(parsed))
    return BuildResult(
        document_id=document.id,
        source=converted.source,
        section_count=len(parsed),
        error=converted.error,
    )


async def _build_one(session_factory, doc_id: str, *, only_if_needed: bool) -> bool:  # noqa: ANN001
    _CONVERTING.add(doc_id)
    try:
        async with session_factory() as db:
            document = await db.get(SopDocument, doc_id)
            if document is None:
                return False
            if only_if_needed and not needs_converting(document):
                return False
            await build(db, document)
            return True
    except Exception:  # noqa: BLE001 — background work: log, keep going
        logger.exception("Converting SOP %s to sections failed", doc_id)
        return False
    finally:
        _CONVERTING.discard(doc_id)


async def build_missing(session_factory) -> int:  # noqa: ANN001 — async_sessionmaker
    """Convert every document not converted yet, whose last conversion failed, or that an older
    converter version produced; then draft the missing summaries. Each document in its own
    session, failures logged and skipped, so one bad file cannot stop the rest; never raises (it
    runs as a fire-and-forget task). Returns how many were converted."""
    queued: list[str] = []
    try:
        async with _BUILD_LOCK:
            async with session_factory() as db:
                ids = (
                    (await db.execute(select(SopDocument.id).where(_needs_converting_clause())))
                    .scalars()
                    .all()
                )
            # Shown as "drafting" from now: their summary follows their conversion.
            queued = sop_summary_service.queue_drafting(ids)
            done = 0
            for doc_id in ids:
                done += await _build_one(session_factory, doc_id, only_if_needed=True)
        # Then, OUTSIDE the build lock (drafting touches only the summary columns, and takes
        # ~25 s per document), draft every converted document's missing summary (spec §2).
        await sop_summary_service.summarize_missing(session_factory)
        return done
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 — e.g. the database is down at boot; the next run retries
        logger.exception("Converting SOP documents to sections failed")
        return 0
    finally:
        sop_summary_service.unqueue_drafting(queued)


async def rebuild(session_factory, document_id: str) -> None:  # noqa: ANN001
    """An admin's "Convert again": convert one document whatever its state, in the background,
    after any build already running. Never raises."""
    _CONVERTING.add(document_id)
    try:
        async with _BUILD_LOCK:
            await _build_one(session_factory, document_id, only_if_needed=False)
    finally:
        _CONVERTING.discard(document_id)
    # A document converted for the first time this way gets its summary drafted too.
    await sop_summary_service.summarize_missing(session_factory)


async def list_sections(db: AsyncSession, document_id: str) -> Sequence[SopSection]:
    return (
        (
            await db.execute(
                select(SopSection)
                .where(SopSection.document_id == document_id)
                .order_by(SopSection.order_index)
            )
        )
        .scalars()
        .all()
    )


async def section_counts(db: AsyncSession) -> dict[str, int]:
    rows = (
        await db.execute(
            select(SopSection.document_id, func.count(SopSection.id)).group_by(
                SopSection.document_id
            )
        )
    ).all()
    return {doc_id: int(n) for doc_id, n in rows}


# document_id → ((section count, newest section time), unit count): the documents list is polled
# while a conversion runs, and units need every section's text. A document is counted again only
# when its sections change (a build or a re-split replaces every row, so both values move).
_UNIT_COUNTS: dict[str, tuple[tuple[int, object], int]] = {}


async def unit_counts(db: AsyncSession) -> dict[str, int]:
    """How many units (app.sop.units) each document reads as: what the SOP tab lists."""
    from app.sop.units import units

    marks = {
        doc_id: (int(n), newest)
        for doc_id, n, newest in (
            await db.execute(
                select(
                    SopSection.document_id,
                    func.count(SopSection.id),
                    func.max(SopSection.created_at),
                ).group_by(SopSection.document_id)
            )
        ).all()
    }
    stale = [d for d, mark in marks.items() if _UNIT_COUNTS.get(d, (None, 0))[0] != mark]
    if stale:
        rows = (
            (
                await db.execute(
                    select(SopSection)
                    .where(SopSection.document_id.in_(stale))
                    .order_by(SopSection.order_index)
                )
            )
            .scalars()
            .all()
        )
        by_doc: dict[str, list[SopSection]] = {d: [] for d in stale}
        for row in rows:
            by_doc[row.document_id].append(row)
        for doc_id, doc_rows in by_doc.items():
            _UNIT_COUNTS[doc_id] = (marks[doc_id], len(units(doc_rows)))
    return {doc_id: _UNIT_COUNTS[doc_id][1] for doc_id in marks}


def full_text(sections: Sequence[SopSection], order_index: int) -> str:
    """A section's whole passage: heading, own text, then every descendant in document order."""
    children: dict[int, list[SopSection]] = {}
    for s in sections:
        if s.parent_index is not None:
            children.setdefault(s.parent_index, []).append(s)
    by_index = {s.order_index: s for s in sections}
    out: list[str] = []

    def walk(section: SopSection) -> None:
        out.append(_block(section))
        for child in sorted(children.get(section.order_index, []), key=lambda c: c.order_index):
            walk(child)

    root = by_index.get(order_index)
    if root is not None:
        walk(root)
    return "\n\n".join(part for part in out if part)


def _block(section: SopSection) -> str:
    """One section's own part of a full passage: its heading as a Markdown heading, then its text.
    The heading's level is the section's own (a clause "4" is ##, "4.2" ###, at most ######), so
    a subsection reads the same in any passage that holds it."""
    return heading_block(section.number, section.title, section.level, section.text)


def heading_block_of(section: SopSection) -> str:
    """A section's own part of a passage (its heading and its own text, no subsection)."""
    return _block(section)


def last_descendant(sections: Sequence[SopSection], order_index: int) -> int:
    """The order_index where a section's passage ends: its last descendant, or itself."""
    return max([order_index, *(d.order_index for d in _descendants(sections, order_index))])


def _descendants(sections: Sequence[SopSection], order_index: int) -> list[SopSection]:
    children: dict[int, list[SopSection]] = {}
    for s in sections:
        if s.parent_index is not None:
            children.setdefault(s.parent_index, []).append(s)
    out: list[SopSection] = []
    pending = list(children.get(order_index, []))
    while pending:
        node = pending.pop()
        out.append(node)
        pending.extend(children.get(node.order_index, []))
    return out


def page_end(sections: Sequence[SopSection], order_index: int) -> int:
    """The last page the section's full passage reaches (its own or any subsection's)."""
    own = next((s.page_end for s in sections if s.order_index == order_index), 1)
    return max([own, *(d.page_end for d in _descendants(sections, order_index))])


def full_lengths(sections: Sequence[SopSection]) -> dict[int, int]:
    """``len(full_text(sections, i))`` for every section, in one bottom-up pass (the section list
    asks for all of them; calling :func:`full_text` per row is quadratic)."""
    children: dict[int, list[SopSection]] = {}
    for s in sections:
        if s.parent_index is not None:
            children.setdefault(s.parent_index, []).append(s)
    texts: dict[int, str] = {}
    for section in sorted(sections, key=lambda s: s.order_index, reverse=True):
        block = _block(section)
        kids = sorted(children.get(section.order_index, []), key=lambda c: c.order_index)
        texts[section.order_index] = "\n\n".join(
            part for part in [block, *(texts[c.order_index] for c in kids)] if part
        )
    return {index: len(text) for index, text in texts.items()}
