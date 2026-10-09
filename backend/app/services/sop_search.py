"""Find the SOP sections relevant to a piece of text (spec-sop-section-grounding §4-§5).

Keyword scoring (BM25), no index service: 26 documents, all in memory for one call. What is
scored is each document's UNITS (``app.sop.units``: sections merged or opened to 500-4000
characters), the same passages the SOP tab shows and a citation names (owner, 2026-10-09: what
a person sees and what the AI uses are one set). A unit is scored on its label, twice, and its
whole text. It only proposes CANDIDATES; the model chooses among them and its choice is checked
(``sop_citation_service``).
"""

from __future__ import annotations

import math
import re
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.sop import SopDocument, SopSection
from app.sop.units import Unit, units

_BM25_K1 = 1.4
_BM25_B = 0.75
_WORD = re.compile(r"[a-z][a-z0-9\-]{2,}|[一-鿿]")
_STOP = frozenset(
    """the and for with that this from are was were been has have had not but all any can
    will shall must may should each per its their them they which who whom what when where how
    into onto out over under about above below than then there these those also only such
    other more most some very you your our ours his her him she one two three use used using
    via within without between including include includes etc a an of to in on at by or as is
    be it if no yes do does done""".split()
)


def tokens(text: str) -> list[str]:
    return [w for w in _WORD.findall(text.lower()) if w not in _STOP]


@dataclass(frozen=True)
class Candidate:
    document_id: str
    document_name: str
    number: str  # the unit's first section
    title: str  # the unit's label ("1–3 PURPOSE / SCOPE")
    order_index: int  # the unit's index in its document
    score: float
    through: str = ""  # the unit's last section, when it holds several
    own: bool = False  # the unit is one section's own text only


@dataclass
class _Indexed:
    document_id: str
    unit: Unit
    document_name: str
    counts: Counter
    length: int


class SectionIndex:
    """Every converted document's units, scored on demand."""

    def __init__(self, rows: Sequence[SopSection], names: dict[str, str]) -> None:
        by_doc: dict[str, list[SopSection]] = {}
        for r in rows:
            by_doc.setdefault(r.document_id, []).append(r)
        self._items: list[_Indexed] = []
        df: Counter = Counter()
        for doc_id, doc_rows in by_doc.items():
            for unit in units(sorted(doc_rows, key=lambda r: r.order_index)):
                words = tokens(f"{unit.label} {unit.label} {unit.text}")
                counts = Counter(words)
                self._items.append(
                    _Indexed(doc_id, unit, names.get(doc_id, ""), counts, len(words))
                )
                df.update(counts.keys())
        n = max(1, len(self._items))
        self._idf = {w: math.log(1 + (n - c + 0.5) / (c + 0.5)) for w, c in df.items()}
        self._avg = sum(i.length for i in self._items) / n if self._items else 1.0

    def search(
        self, text: str, *, limit: int = 8, document_ids: Iterable[str] | None = None
    ) -> list[Candidate]:
        """The best-scoring units for ``text``, at most ``limit``, optionally only within some
        documents. Units scoring nothing are never returned."""
        query = set(tokens(text))
        allowed = set(document_ids) if document_ids is not None else None
        scored: list[tuple[float, _Indexed]] = []
        for item in self._items:
            if allowed is not None and item.document_id not in allowed:
                continue
            score = 0.0
            for w in query:
                tf = item.counts.get(w, 0)
                if tf:
                    norm = tf + _BM25_K1 * (1 - _BM25_B + _BM25_B * item.length / self._avg)
                    score += self._idf.get(w, 0.0) * tf * (_BM25_K1 + 1) / norm
            if score > 0:
                scored.append((score, item))
        scored.sort(key=lambda pair: -pair[0])
        out = []
        for score, i in scored[:limit]:
            number, through, own = i.unit.citation()
            out.append(
                Candidate(
                    document_id=i.document_id,
                    document_name=i.document_name,
                    number=number,
                    title=i.unit.label,
                    order_index=i.unit.index,
                    score=round(score, 3),
                    through=through,
                    own=own,
                )
            )
        return out


async def load_index(db: AsyncSession, library_id: str | None = None) -> SectionIndex:
    """Every section, or only those of one SOP library's documents (spec-sop-libraries: a bank
    looks only in the library it is bound to)."""
    docs = select(SopDocument.id, SopDocument.name)
    if library_id is not None:
        docs = docs.where(SopDocument.library_id == library_id)
    names = {doc_id: name for doc_id, name in (await db.execute(docs)).all()}
    sections = select(SopSection)
    if library_id is not None:
        sections = sections.where(SopSection.document_id.in_(list(names)))
    rows = (await db.execute(sections)).scalars().all()
    return SectionIndex(rows, names)
