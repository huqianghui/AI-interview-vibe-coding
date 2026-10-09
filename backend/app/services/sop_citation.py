"""Rubric citations as SOP sections (spec-sop-section-grounding §3, PR 3 of 3).

A rubric item cites one or more SOP sections: ``[{"document_id", "section"}, ...]`` in
``checklist_items.source_refs``, most important first. A reference is bound to the section NUMBER
("4.2"; "§3" for an unnumbered heading), never to a row id or position, because re-converting a
document rebuilds its section rows. What scoring reads for a reference is the section's FULL text:
its own text and every subsection, never cut (owner, 2026-10-08: "要取完整的对应段落").
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.sop import SopDocument, SopSection
from app.services import sop_section_service

# The most references one item keeps (an imported label lists up to 8: "sections 5.1-5.8"); a
# rubric item that "cites" a dozen sections cites nothing.
MAX_REFS_PER_ITEM = 8


@dataclass(frozen=True)
class SectionRef:
    """A cited passage: one section (with its subsections), or a run of sections in document
    order from ``section`` through ``through`` (a merged unit, app/sop/units.py), or a section's
    own text only (``own``: its subsections were cited apart)."""

    document_id: str
    section: str
    through: str = ""
    own: bool = False

    def as_dict(self) -> dict:
        out = {"document_id": self.document_id, "section": self.section}
        if self.through:
            out["through"] = self.through
        if self.own:
            out["part"] = "own"
        return out


@dataclass(frozen=True)
class CitedSection:
    document_id: str
    document_name: str
    number: str
    title: str
    page_start: int
    page_end: int
    text: str
    # The reference this passage was read for (a run, or a section's own text); None = the
    # section ``number`` as a whole.
    ref: SectionRef | None = None

    @property
    def reference(self) -> SectionRef:
        return self.ref or SectionRef(self.document_id, self.number)

    @property
    def span(self) -> str:
        """The section number, or the run it covers ("1–3")."""
        through = self.ref.through if self.ref else ""
        return f"{self.number}–{through}" if through else self.number

    @property
    def label(self) -> str:
        """How the passage is named to a reader: "4.2 Regional CSM", "1–3 PURPOSE", or the title
        alone for an unnumbered heading."""
        if self.span.startswith("§") and "–" not in self.span:
            return self.title or "(before the first heading)"
        return f"{self.span} {self.title}".strip()

    @property
    def pages(self) -> str:
        if self.page_start == self.page_end:
            return f"p. {self.page_start}"
        return f"pp. {self.page_start}-{self.page_end}"


def normalize_number(raw: object) -> str:
    """ "4.2." → "4.2", " §3 " → "§3"; anything else stripped."""
    return str(raw or "").strip().rstrip(".").strip()


def parse_refs(raw: object) -> list[SectionRef]:
    """References from the stored JSON (or an already-decoded list). Invalid entries are dropped,
    duplicates kept once, at most :data:`MAX_REFS_PER_ITEM`."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw or "[]")
        except json.JSONDecodeError:
            return []
    if not isinstance(raw, list):
        return []
    out: list[SectionRef] = []
    for entry in raw[: MAX_REFS_PER_ITEM * 4]:
        if not isinstance(entry, dict):
            continue
        document_id = str(entry.get("document_id") or "").strip()
        section = normalize_number(entry.get("section"))
        through = normalize_number(entry.get("through")) if entry.get("through") else ""
        own = entry.get("part") == "own" and not through
        ref = SectionRef(document_id, section, "" if through == section else through, own)
        if document_id and section and ref not in out:
            out.append(ref)
        if len(out) == MAX_REFS_PER_ITEM:
            break
    return out


def dump_refs(refs: Iterable[SectionRef]) -> str:
    return json.dumps([r.as_dict() for r in refs])


async def _sections_by_document(
    db: AsyncSession, document_ids: Iterable[str]
) -> dict[str, list[SopSection]]:
    ids = sorted(set(document_ids))
    if not ids:
        return {}
    rows = (
        (
            await db.execute(
                select(SopSection)
                .where(SopSection.document_id.in_(ids))
                .order_by(SopSection.document_id, SopSection.order_index)
            )
        )
        .scalars()
        .all()
    )
    out: dict[str, list[SopSection]] = {doc_id: [] for doc_id in ids}
    for row in rows:
        out[row.document_id].append(row)
    return out


async def _document_names(db: AsyncSession, document_ids: Iterable[str]) -> dict[str, str]:
    ids = sorted(set(document_ids))
    if not ids:
        return {}
    rows = await db.execute(select(SopDocument.id, SopDocument.name).where(SopDocument.id.in_(ids)))
    return {doc_id: name for doc_id, name in rows.all()}


def _find(sections: list[SopSection], number: str) -> SopSection | None:
    """The first section with this number (a document numbers each clause once; a repeat is a
    split artefact, and the first is the clause the text introduces)."""
    return next((s for s in sections if s.number == number), None)


def _passage(sections: list[SopSection], ref: SectionRef) -> tuple[SopSection, str, int] | None:
    """The first row, the text and the last page a reference names, or None when it is gone."""
    row = _find(sections, ref.section)
    if row is None:
        return None
    if ref.own:
        return row, sop_section_service.heading_block_of(row), row.page_end
    if not ref.through:
        return (
            row,
            sop_section_service.full_text(sections, row.order_index),
            sop_section_service.page_end(sections, row.order_index),
        )
    last = next(
        (s for s in sections if s.number == ref.through and s.order_index >= row.order_index), None
    )
    if last is None:
        return None
    # Document order: a section's subsections follow it, so the run ends with the last
    # descendant of ``through``.
    end = sop_section_service.last_descendant(sections, last.order_index)
    run = [s for s in sections if row.order_index <= s.order_index <= end]
    text = "\n\n".join(b for b in (sop_section_service.heading_block_of(s) for s in run) if b)
    return row, text, max(s.page_end for s in run)


async def resolve(db: AsyncSession, refs: Iterable[SectionRef]) -> list[CitedSection]:
    """Each reference's passage with its FULL text, in reference order. A reference whose document
    or section no longer exists is skipped (see :func:`missing` to report those)."""
    refs = list(refs)
    by_doc = await _sections_by_document(db, (r.document_id for r in refs))
    names = await _document_names(db, by_doc)
    out: list[CitedSection] = []
    for ref in refs:
        found = _passage(by_doc.get(ref.document_id) or [], ref)
        if found is None:
            continue
        row, text, last_page = found
        out.append(
            CitedSection(
                document_id=ref.document_id,
                document_name=names.get(ref.document_id, ""),
                number=row.number,
                title=row.title,
                page_start=row.page_start,
                page_end=last_page,
                text=text,
                ref=ref,
            )
        )
    return out


async def _section_heads(
    db: AsyncSession, document_ids: Iterable[str]
) -> dict[tuple[str, str], tuple[str, int]]:
    """``(document_id, number) → (title, page_start)`` of the first section with that number, read
    without any section text (checking a citation must not load whole documents)."""
    ids = sorted(set(document_ids))
    if not ids:
        return {}
    rows = await db.execute(
        select(SopSection.document_id, SopSection.number, SopSection.title, SopSection.page_start)
        .where(SopSection.document_id.in_(ids))
        .order_by(SopSection.document_id, SopSection.order_index)
    )
    out: dict[tuple[str, str], tuple[str, int]] = {}
    for doc_id, number, title, page in rows.all():
        out.setdefault((doc_id, number), (title, page))
    return out


def _exists(heads: dict, ref: SectionRef) -> bool:
    return (ref.document_id, ref.section) in heads and (
        not ref.through or (ref.document_id, ref.through) in heads
    )


async def missing(db: AsyncSession, refs: Iterable[SectionRef]) -> list[SectionRef]:
    """The references that name no existing section (for a run: either end gone)."""
    refs = list(refs)
    heads = await _section_heads(db, (r.document_id for r in refs))
    return [r for r in refs if not _exists(heads, r)]


async def describe(db: AsyncSession, refs: Iterable[SectionRef]) -> list[dict]:
    """References as a reader sees them, without the section text: for the editor and the report.
    ``found`` is False when the document or section is gone."""
    refs = list(refs)
    heads = await _section_heads(db, (r.document_id for r in refs))
    names = await _document_names(db, (r.document_id for r in refs))
    out = []
    for ref in refs:
        head = heads.get((ref.document_id, ref.section))
        out.append(
            {
                **ref.as_dict(),
                "document_name": names.get(ref.document_id, ""),
                "title": head[0] if head else "",
                "page_start": head[1] if head else None,
                "found": _exists(heads, ref),
            }
        )
    return out
