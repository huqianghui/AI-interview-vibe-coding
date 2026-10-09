"""An SOP's sections sized for reading and citing (spec-sop-conversion-and-sections §2).

The section tree stays as converted (every clause, any size); the units are what a person and the
AI see: the SOP tab's list, search, AI drafting, relocation and the citation picker. Owner rule:
at most ``MAX_CHARS`` and at least ``MIN_CHARS`` characters, counted over a unit's full passage.

1. The whole document is one unit if it fits.
2. A section too long for one unit is opened: its own text (the lines before its first
   subsection) becomes a part, and each subsection is judged the same way, down to the leaves.
3. Parts under ``MIN_CHARS`` merge with the next (or the previous) part under the same parent,
   while the merged unit still fits. Only a part that could not, because both its neighbours
   there are too big, joins its smaller neighbour across a parent (a unit "4.9–5 ...").
4. A leaf longer than ``MAX_CHARS`` (most often one big table) stays whole.

A unit cites its members: a whole section (its full text, every subsection included), or a
section's own part only (``own=True``), when its subsections went to other units.

Pure functions over the stored rows (any object with ``order_index``, ``parent_index``,
``number``, ``title``, ``level``, ``page_start``, ``page_end``, ``text``); no database, no Azure.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from app.sop.sections import heading_block

MAX_CHARS = 4000
MIN_CHARS = 500
_JOIN = "\n\n"
_TITLE_MAX = 200


class _Row(Protocol):
    order_index: int
    parent_index: int | None
    number: str
    title: str
    level: int
    page_start: int
    page_end: int
    text: str


@dataclass(frozen=True)
class Member:
    """One section in a unit: all of it, or only its own text (``own``)."""

    order_index: int
    number: str
    own: bool = False


@dataclass(frozen=True)
class Unit:
    index: int
    members: tuple[Member, ...]
    label: str  # "4.2 Title", or "1–3 PURPOSE / SCOPE / DEFINITIONS" for a merged unit
    page_start: int
    page_end: int
    text: str  # the passage as Markdown: every member's heading and text

    @property
    def length(self) -> int:
        return len(self.text)

    def citation(self) -> tuple[str, str, bool]:
        """``(section, through, own)``: how a rubric item cites this unit. Members are one run in
        document order, so the first and last name it (``through`` empty for one member)."""
        first, last = self.members[0], self.members[-1]
        if len(self.members) == 1:
            return first.number, "", first.own
        # ``own`` on a run: it ends with the last section's own text (its subsections are cited
        # by the next unit).
        return first.number, last.number, last.own


class _Tree:
    def __init__(self, rows: Sequence[_Row]) -> None:
        self.rows = {r.order_index: r for r in rows}
        self.children: dict[int | None, list[int]] = {}
        for r in sorted(rows, key=lambda r: r.order_index):
            parent = r.parent_index if r.parent_index in self.rows else None
            self.children.setdefault(parent, []).append(r.order_index)
        self._full: dict[int, str] = {}
        self._pages: dict[int, tuple[int, int]] = {}

    def own(self, i: int) -> str:
        r = self.rows[i]
        return heading_block(r.number, r.title, r.level, r.text)

    def full(self, i: int) -> str:
        if i not in self._full:
            parts = [self.own(i), *(self.full(c) for c in self.children.get(i, []))]
            self._full[i] = _JOIN.join(p for p in parts if p)
        return self._full[i]

    def end(self, i: int) -> int:
        """Where a section's passage ends in document order: its last descendant, or itself."""
        kids = self.children.get(i, [])
        return self.end(kids[-1]) if kids else i

    def run(self, members: list[Member]) -> str:
        """What a unit's citation reads: the run in document order from its first member through
        its last (all of the last one, or only its own text)."""
        if len(members) == 1:
            m = members[0]
            return self.own(m.order_index) if m.own else self.full(m.order_index)
        # A run ends with its last member: all of it, or only its own text.
        last = members[-1].order_index if members[-1].own else self.end(members[-1].order_index)
        order = sorted(self.rows)
        run = [i for i in order if members[0].order_index <= i <= last]
        return _JOIN.join(b for b in (self.own(i) for i in run) if b)

    def pages(self, i: int) -> tuple[int, int]:
        if i not in self._pages:
            r = self.rows[i]
            spans = [(r.page_start, r.page_end), *(self.pages(c) for c in self.children.get(i, []))]
            self._pages[i] = (min(s for s, _ in spans), max(e for _, e in spans))
        return self._pages[i]


@dataclass
class _Part:
    members: list[Member]
    texts: list[str]
    pages: tuple[int, int]

    @property
    def length(self) -> int:
        return sum(len(t) for t in self.texts) + len(_JOIN) * (len(self.texts) - 1)

    def absorb(self, other: _Part) -> None:
        self.members += other.members
        self.texts += other.texts
        self.pages = (min(self.pages[0], other.pages[0]), max(self.pages[1], other.pages[1]))


def _join(tree: _Tree, first: _Part, second: _Part) -> _Part | None:
    """``first`` and ``second`` as one part, or None: too long, or not citable as one reference
    that reads exactly its text (the invariant every unit keeps; see :meth:`_Tree.run`)."""
    if first.length + len(_JOIN) + second.length > MAX_CHARS:
        return None
    joined = _Part(list(first.members), list(first.texts), first.pages)
    joined.absorb(second)
    text = _JOIN.join(t for t in joined.texts if t)
    return joined if tree.run(joined.members) == text else None


def _merged(tree: _Tree, parts: list[_Part]) -> list[_Part]:
    """Small parts join their neighbour under the same parent, while the result fits."""
    out: list[_Part] = []
    for part in parts:
        if out and (out[-1].length < MIN_CHARS or part.length < MIN_CHARS):
            joined = _join(tree, out[-1], part)
            if joined is not None:
                out[-1] = joined
                continue
        out.append(part)
    return out


def _split(tree: _Tree, siblings: list[int]) -> list[_Part]:
    parts: list[_Part] = []
    for i in siblings:
        kids = tree.children.get(i, [])
        whole = tree.full(i)
        if len(whole) <= MAX_CHARS or not kids:
            r = tree.rows[i]
            parts.append(_Part([Member(i, r.number)], [whole], tree.pages(i)))
            continue
        # Too long: its own text and its subsections are judged at the next level, together.
        r = tree.rows[i]
        inner: list[_Part] = []
        if tree.own(i):
            own = _Part([Member(i, r.number, own=True)], [tree.own(i)], (r.page_start, r.page_end))
            inner.append(own)
        inner += _split(tree, kids)
        # A unit never crosses a parent: the opened section's parts merge among themselves only.
        parts += [_Sealed.of(p) for p in _merged_unsealed(tree, inner)]
    return _merged_unsealed(tree, parts)


class _Sealed(_Part):
    """A part from inside an opened section: it may not merge with that section's siblings."""

    @classmethod
    def of(cls, part: _Part) -> _Sealed:
        return cls(part.members, part.texts, part.pages)


def _merged_unsealed(tree: _Tree, parts: list[_Part]) -> list[_Part]:
    """Merge runs of ordinary parts; parts from an opened section stay as they are."""
    out: list[_Part] = []
    run: list[_Part] = []
    for part in parts:
        if isinstance(part, _Sealed):
            out += _merged(tree, run)
            run = []
            out.append(part)
        else:
            run.append(part)
    return out + _merged(tree, run)


def _absorb_small(tree: _Tree, parts: list[_Part]) -> list[_Part]:
    """Last resort for a part still under ``MIN_CHARS`` (both neighbours under its parent were too
    big, or it sits next to an opened section): it joins its smaller neighbour, wherever that
    comes from, if the result still fits and is still one citation. A unit then reads e.g.
    "4.9–5 ..."."""
    out = list(parts)
    i = 0
    while i < len(out):
        if out[i].length >= MIN_CHARS or len(out) == 1:
            i += 1
            continue
        options = []
        for j in (i - 1, i + 1):
            if 0 <= j < len(out):
                first, second = (out[j], out[i]) if j < i else (out[i], out[j])
                joined = _join(tree, first, second)
                if joined is not None:
                    options.append((out[j].length, min(i, j), joined))
        if not options:
            i += 1
            continue
        _, lo, joined = min(options, key=lambda o: o[0])
        out[lo : lo + 2] = [joined]
        i = lo
    return out


def _label(tree: _Tree, members: tuple[Member, ...]) -> str:
    def head(m: Member) -> str:
        r = tree.rows[m.order_index]
        return r.title if r.number.startswith("§") else f"{r.number} {r.title}".strip()

    if len(members) == 1:
        return head(members[0])[:_TITLE_MAX]
    numbered = [m.number for m in members if not m.number.startswith("§")]
    if len(numbered) > 1:
        span = f"{numbered[0]}–{numbered[-1]} "
    else:
        span = f"{numbered[0]} " if numbered else ""
    titles = " / ".join(t for t in (tree.rows[m.order_index].title for m in members) if t)
    return f"{span}{titles}".strip()[:_TITLE_MAX]


def units(rows: Sequence[_Row]) -> list[Unit]:
    """The document's units, in document order."""
    if not rows:
        return []
    tree = _Tree(rows)
    roots = tree.children.get(None, [])
    total = _JOIN.join(tree.full(i) for i in roots)
    if len(total) <= MAX_CHARS:
        pages = [tree.pages(i) for i in roots]
        parts = [
            _Part(
                [Member(i, tree.rows[i].number) for i in roots],
                [tree.full(i) for i in roots],
                (min(s for s, _ in pages), max(e for _, e in pages)),
            )
        ]
    else:
        parts = _absorb_small(tree, _split(tree, roots))
    out = []
    for n, part in enumerate(parts):
        members = tuple(part.members)
        out.append(
            Unit(
                index=n,
                members=members,
                label=_label(tree, members),
                page_start=part.pages[0],
                page_end=part.pages[1],
                text=_JOIN.join(t for t in part.texts if t),
            )
        )
    return out
