"""Find the SOP sections relevant to a piece of text (spec-sop-section-grounding §4-§5).

Keyword scoring over our own ``sop_sections`` (BM25), no index service: 26 documents, a few
thousand sections, all in memory for one call. It only proposes CANDIDATES; the model chooses among
them and its choice is checked (``sop_citation_service``). Each section is scored on its title, its
parent's title and its own text, so a short clause under a telling heading still matches.
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
    number: str
    title: str
    order_index: int
    score: float


@dataclass
class _Indexed:
    section: SopSection
    document_name: str
    counts: Counter
    length: int


class SectionIndex:
    """Every converted document's sections, scored on demand."""

    def __init__(self, rows: Sequence[SopSection], names: dict[str, str]) -> None:
        by_key = {(r.document_id, r.order_index): r for r in rows}
        self._items: list[_Indexed] = []
        df: Counter = Counter()
        for r in rows:
            parent = (
                by_key.get((r.document_id, r.parent_index)) if r.parent_index is not None else None
            )
            words = tokens(f"{r.title} {r.title} {parent.title if parent else ''} {r.text}")
            counts = Counter(words)
            self._items.append(_Indexed(r, names.get(r.document_id, ""), counts, len(words)))
            df.update(counts.keys())
        n = max(1, len(self._items))
        self._idf = {w: math.log(1 + (n - c + 0.5) / (c + 0.5)) for w, c in df.items()}
        self._avg = sum(i.length for i in self._items) / n if self._items else 1.0

    def search(
        self, text: str, *, limit: int = 8, document_ids: Iterable[str] | None = None
    ) -> list[Candidate]:
        """The best-scoring sections for ``text``, at most ``limit``, optionally only within some
        documents. Sections scoring nothing are never returned."""
        query = set(tokens(text))
        allowed = set(document_ids) if document_ids is not None else None
        scored: list[tuple[float, _Indexed]] = []
        for item in self._items:
            if allowed is not None and item.section.document_id not in allowed:
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
        return [
            Candidate(
                document_id=i.section.document_id,
                document_name=i.document_name,
                number=i.section.number,
                title=i.section.title,
                order_index=i.section.order_index,
                score=round(score, 3),
            )
            for score, i in scored[:limit]
        ]


async def load_index(db: AsyncSession) -> SectionIndex:
    rows = (await db.execute(select(SopSection))).scalars().all()
    names = {
        doc_id: name
        for doc_id, name in (await db.execute(select(SopDocument.id, SopDocument.name))).all()
    }
    return SectionIndex(rows, names)
