"""Split an SOP's Markdown into its sections (spec: docs/planning/spec-sop-section-grounding.md).

Pure text in, sections out — no Azure, fully CI-covered. The Markdown comes from Azure Document
Intelligence (PDF) or our own Word converter, so it has two kinds of section start:

- Markdown headings (``# Title`` .. ``###### Title``): what DI marks as a heading, and every heading
  of an unnumbered document (e.g. a handbook) or a Word file.
- Numbered clauses (``4.2`` / ``4.2.1``): SOPs number every clause, and DI emits most of them as
  BODY lines — either ``4.2 Title`` on one line or the number alone on a line with its text below.

A numbered section's level is its depth (``4`` → 1, ``4.2`` → 2); an unnumbered heading's level is
its ``#`` count. Noise is dropped: DI page-header / page-footer / page-number comments, and the
repeats of any line found at the top or bottom of many pages (the running "STANDARD OPERATING
PROCEDURE" title, "Company Confidential"); its first occurrence is kept.
``<!-- PageBreak -->`` advances the page counter, so every section knows its pages.

The **full text** of a section is its own text plus all its descendants', in document order — the
whole cited passage, never a fixed-size slice (owner: "要取完整的对应段落").
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field

_HEADING = re.compile(r"^(#+)\s+(.+?)\s*#*\s*$")
# "4.2 Title" / "4.2. Title" / "4. PURPOSE". Up to 6 levels, each part 1-2 digits, first part <= 99.
_NUMBERED_INLINE = re.compile(r"^(\d{1,2}(?:\.\d{1,2}){0,5})\.?\s+(\S.*)$")
# "10.REVIEW OF ..." with no space after the number: how Word's auto-numbered headings print when
# their tab collapses (measured on the server, 2026-10-09). Only an upper-case title, so "3.5mg"
# or "2.1x" in prose never matches; the outline order is checked too, as for every clause.
_NUMBERED_TIGHT = re.compile(r"^(\d{1,2}(?:\.\d{1,2}){0,5})\.([A-Z][A-Z&/,()'\- ]{2,}.*)$")
# The number alone on its line ("4.2" or "4.2."), its text on the next non-empty line.
_NUMBER_ALONE = re.compile(r"^(\d{1,2}(?:\.\d{1,2}){0,5})\.?$")
_PAGE_BREAK = re.compile(r"^<!--\s*PageBreak\s*-->$")
_COMMENT = re.compile(r"^<!--.*-->$")
# Lines that look numbered but are not clauses: versions, dates, page counters, decimals in prose.
_NOT_A_CLAUSE = re.compile(
    r"^\d+(\.\d+)*\s*(%|days?|hours?|weeks?|months?|years?|mg|ml|kg|of\b|-\s*\d)", re.IGNORECASE
)
# A line repeated on at least this many pages is a running header/footer, not content.
_REPEAT_THRESHOLD = 3
_TITLE_MAX = 160
# A title DI wrapped onto the next line(s): "7.3 / Appendix 3 - RACI ... for Study, Country and /
# Site Feasibility". Joined when the whole block is short and is not a sentence (a clause's text
# ends with . : or ;). Only the line break moves: no text is added or dropped.
_TITLE_LINES_MAX = 3
# A wrapped line is one the page width cut: a first line shorter than this ended by itself, and a
# short stray line after it (an OCR fragment "aEsta") is not its continuation.
_WRAPPED_LINE_MIN = 60
_SENTENCE_END = re.compile(r"[.:;。：；]$")
# Markdown escapes DI writes so a literal "8." at a line's start does not render as a list
# ("8\\. APPENDICES"). Undone before a line is read for a number: a number is a number however
# it was escaped.
_ESCAPE = re.compile(r"\\([\\`*_{}\[\]()#+\-.!|>~])")
# A document whose outline is unnumbered (PURPOSE, SCOPE, ... as plain headings) has at least this
# many unnumbered headings before its first number; a numbered SOP has a title heading or two.
_OUTLINE_MIN = 3
# A numbered heading (DI marked it from the page layout) counts this much more than a number at
# the start of a body line when choosing the outline.
_HEADING_WEIGHT = 3


@dataclass
class ParsedSection:
    number: str  # "4.2.3"; unnumbered headings get "§1", "§2", ... in document order
    title: str
    level: int
    page_start: int
    page_end: int
    text: str = ""  # this section's own text (heading line excluded), not its children's
    parent: int | None = None  # index into the returned list
    children: list[int] = field(default_factory=list)


def _clean_heading(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("*", "").replace("_", " ")).strip()


# Page-header / footer lines live in the first and last few lines of a page.
_PAGE_EDGE_LINES = 4


def _noise_lines(lines: list[str]) -> set[str]:
    """Running headers and footers: lines (normalized) that repeat at the TOP or BOTTOM of many
    pages. Only the page edges are counted: a line repeated in the body is content (a reference
    "SOP (VV-QDOC-00237 Trial Master File).", a table cell "No", the ``<tr>`` of every table) and
    must survive — counting the whole document dropped exactly those (measured 2026-10-08)."""
    pages: list[list[str]] = [[]]
    for ln in lines:
        stripped = ln.strip()
        if _PAGE_BREAK.match(stripped):
            pages.append([])
        elif stripped and not _COMMENT.match(stripped) and not stripped.startswith("<"):
            pages[-1].append(_clean_heading(_HEADING.sub(r"\2", stripped)))
    counts: Counter[str] = Counter()
    for page in pages:
        counts.update(set(page[:_PAGE_EDGE_LINES] + page[-_PAGE_EDGE_LINES:]))
    threshold = max(_REPEAT_THRESHOLD, len(pages) // 3)
    return {ln for ln, n in counts.items() if n >= threshold and len(ln) <= _TITLE_MAX}


def _parts(number: str) -> list[int]:
    return [int(p) for p in number.split(".")]


def _is_successor(prev: str | None, number: str) -> bool:
    """Whether ``number`` can come next in the outline after ``prev``.

    Moves forward in outline order: into a child (4.2 → 4.2.1), to a later sibling (4.2 → 4.3), or
    to a later sibling of an ancestor (4.2.3 → 4.3 → 5). Small gaps are allowed (a clause DI did
    not split out must not orphan every clause after it), large jumps are not: those are stray
    numbers in prose or tables ("3.5 mg", a cell "12") that would otherwise reorder the tree.
    """
    b = _parts(number)
    if prev is None:
        return b[0] <= 3 and all(x >= 1 for x in b[1:])
    a = _parts(prev)
    if len(b) > len(a) and b[: len(a)] == a:
        return all(1 <= x <= 3 for x in b[len(a) :])  # a child (or grandchild) near its start
    for k, (x, y) in enumerate(zip(a, b, strict=False)):
        if x != y:
            # The first differing part moves forward a little, and anything deeper restarts.
            return 0 < y - x <= 3 and all(1 <= z <= 3 for z in b[k + 1 :])
    return False


# How far a numbered heading's first differing part may move forward from the clause before it.
_HEADING_GAP = 9


def _heading_follows(prev: str, number: str) -> bool:
    """A heading's number may skip clauses DI never marked: forward in outline order, its first
    differing part at most ``_HEADING_GAP`` ahead (a child counts as one step), deeper parts free.
    Measured on a client SOP, 2026-10-10: 6.8 → "### 6.8.6", 5.4.3.1.9 → "### 5.4.6.5.5"."""
    a, b = _parts(prev), _parts(number)
    if len(b) > len(a) and b[: len(a)] == a:
        return 1 <= b[len(a)] <= _HEADING_GAP
    for x, y in zip(a, b, strict=False):
        if x != y:
            return 0 < y - x <= _HEADING_GAP
    return False


def _is_plain_line(line: str, noise: set[str]) -> bool:
    """A line that can continue a title: text, not a heading, a number, markup or noise."""
    return bool(
        line
        and not _HEADING.match(line)
        and not _NUMBER_ALONE.match(line)
        and not _NUMBERED_INLINE.match(line)
        and not _COMMENT.match(line)
        and not _PAGE_BREAK.match(line)
        and not line.startswith(("<", "|", "- ", "* ", "+ "))
        and line not in noise
    )


def _wrapped_title(raw: list[str], j: int, noise: set[str]) -> tuple[str, int]:
    """The title starting at line ``j`` and the index after it. A title DI wrapped onto the next
    line(s) is joined, when the block is short and is not a sentence (see ``_SENTENCE_END``)."""
    lines = [raw[j].strip()]
    k = j + 1
    while k < len(raw) and len(lines) < _TITLE_LINES_MAX and _is_plain_line(raw[k].strip(), noise):
        lines.append(raw[k].strip())
        k += 1
    block = " ".join(lines)
    ends_here = k >= len(raw) or not _is_plain_line(raw[k].strip(), noise)  # not a longer text
    if (
        len(lines) > 1
        and ends_here
        and len(lines[0]) >= _WRAPPED_LINE_MIN
        and len(block) <= _TITLE_MAX
        and not _SENTENCE_END.search(block)
    ):
        return block, k
    return lines[0], j + 1


@dataclass
class _Candidate:
    """A line that may open a numbered clause (one pass over the document finds them all)."""

    line: int  # index into the raw lines of the line holding the number
    number: str
    heading: bool  # DI marked it a Markdown heading
    parts: tuple[int, ...] = ()


def _unescape(text: str) -> str:
    return _ESCAPE.sub(r"\1", text)


def _read_line(raw: list[str], i: int, noise: set[str]) -> tuple[str, re.Match | None] | None:
    """A content line as a reader sees it: ``(text, heading match)``; None for blank lines, page
    breaks, comments and figure tags, which carry no content."""
    line = raw[i].strip()
    if not line or _PAGE_BREAK.match(line) or _COMMENT.match(line):
        return None
    if line in ("<figure>", "</figure>"):
        return None
    heading = _HEADING.match(line)
    return (_clean_heading(heading.group(2)) if heading else line), heading


def _number_of(text: str) -> tuple[str, str | None] | None:
    """``(number, title or None)`` when a line starts a clause: "4.2 Title", "10.REVIEW", or the
    number alone (its title on the next line). Escapes undone first."""
    text = _unescape(text)
    numbered = _NUMBERED_INLINE.match(text) or _NUMBERED_TIGHT.match(text)
    if numbered:
        return None if _NOT_A_CLAUSE.match(text) else (numbered.group(1), numbered.group(2))
    alone = _NUMBER_ALONE.match(text)
    return (alone.group(1), None) if alone else None


def _outline(candidates: list[_Candidate]) -> list[_Candidate]:
    """The document's outline: the run of candidates that best follows the outline order, chosen
    over the WHOLE document rather than line by line. A stray number (a list item, a table cell, a
    decimal in prose) cannot derail the clauses after it, and a number that does not fit the
    numbering is text. Each step must be a successor (``_is_successor``; a heading may skip
    further, ``_heading_follows``); headings weigh more, being DI's own layout reading."""
    n = len(candidates)
    best = [0] * n
    prev = [-1] * n
    for i, c in enumerate(candidates):
        weight = _HEADING_WEIGHT if c.heading else 1
        if _is_successor(None, c.number):
            best[i] = weight
        for j in range(i):
            if best[j] and best[j] + weight > best[i]:
                p = candidates[j]
                if _is_successor(p.number, c.number) or (
                    c.heading and _heading_follows(p.number, c.number)
                ):
                    best[i], prev[i] = best[j] + weight, j
    if not n or not max(best):
        return []
    i = max(range(n), key=lambda k: (best[k], k))
    chain = []
    while i >= 0:
        chain.append(candidates[i])
        i = prev[i]
    return chain[::-1]


def parse_sections(markdown: str) -> list[ParsedSection]:
    """The document's sections in order, with parent/children links and page ranges.

    Two passes. The first finds every line that may open a numbered clause and chooses the
    document's outline among them (:func:`_outline`). The second builds the tree, where a clause's
    parent is decided by its NUMBER: 7.1's parent is 7, wherever 7.1 appears. Reading the tree off
    the order of lines instead let one missed chapter heading (a dropped number ". APPENDICES", an
    escaped one "8\\. APPENDICES", a wrong heading level) silently hang its subsections under the
    chapter before; measured 2026-10-12, 38 sections in 7 of 26 client SOPs. A clause whose parent
    number never appeared gets one: the unnumbered heading just before it, if there is one (it is
    the chapter heading whose number was lost), else an empty section with only the number.

    A document whose own outline is unnumbered (its chapters are plain headings) has no clauses:
    numbers in it ("2.1 Health authority" in an appendix listing another document's structure) are
    its content.
    """
    raw = markdown.replace("\r\n", "\n").split("\n")
    noise = _noise_lines(raw)

    # ── Pass 1: candidates, the outline among them, and the parents it lacks ──────────────────
    candidates: list[_Candidate] = []
    unnumbered_lines: list[int] = []  # unnumbered headings, by line
    heading_lines: list[int] = []  # every heading, numbered or not
    for i in range(len(raw)):
        read = _read_line(raw, i, noise)
        if read is None or read[0] in noise:
            continue
        text, heading = read
        if heading:
            heading_lines.append(i)
        found = _number_of(text)
        if found:
            candidates.append(_Candidate(i, found[0], heading is not None, _parts(found[0])))
        elif heading:
            unnumbered_lines.append(i)
    outline = _outline(candidates)
    if outline:
        before = sum(1 for line in unnumbered_lines if line < outline[0].line)
        if before >= _OUTLINE_MIN:
            outline = []  # the chapters are plain headings: numbers are content
    clause_at = {c.line: c.number for c in outline}
    # A missing parent: the last heading since the previous clause that is not a clause of the
    # outline becomes it: its number was lost (". APPENDICES"), escaped beyond reading, or misread
    # ("# 1. RESPONSIBILITIES" between 3 and 4.1). None there: an empty section with only the
    # number opens before the child, and the text stays where it was.
    spare = [line for line in heading_lines if line not in clause_at]
    heading_as: dict[int, str] = {}
    synthetic_at: dict[int, list[str]] = {}
    present: set[str] = set()
    previous_line = -1
    for c in outline:
        missing = [
            ".".join(str(x) for x in c.parts[:k])
            for k in range(1, len(c.parts))
            if ".".join(str(x) for x in c.parts[:k]) not in present
        ]
        lost = [line for line in spare if previous_line < line < c.line and line not in heading_as]
        for number in missing:
            if lost and number == missing[0]:
                heading_as[lost[-1]] = number
            else:
                synthetic_at.setdefault(c.line, []).append(number)
            present.add(number)
        present.add(c.number)
        previous_line = c.line

    # ── Pass 2: the tree ─────────────────────────────────────────────────────────────────────
    sections: list[ParsedSection] = []
    stack: list[int] = []  # indices of the open sections, outermost first
    body: list[str] = []  # text before the first section (a preamble)
    page = 1
    unnumbered = 0
    kept_once: set[str] = set()
    by_number: dict[str, int] = {}  # each clause number's section, the latest one

    def attach(index: int, parent: int | None) -> None:
        sections[index].parent = parent
        if parent is not None:
            sections[parent].children.append(index)

    def open_clause(number: str, title: str) -> None:
        """A clause under the section its number names (7.1 under 7), or at the top level."""
        parent = by_number.get(number.rsplit(".", 1)[0]) if "." in number else None
        # A clause written on one line with its sentence ("1. This template should be used as a
        # guide to ..."): the title is its start, the rest its text. Nothing is cut off.
        rest = ""
        if len(title) > _TITLE_MAX:
            cut = title.rfind(" ", 0, _TITLE_MAX)
            cut = cut if cut > 0 else _TITLE_MAX
            title, rest = title[:cut], title[cut:].strip()
        sections.append(
            ParsedSection(
                number=number,
                title=title,
                level=len(_parts(number)),
                page_start=page,
                page_end=page,
                text=rest,
            )
        )
        index = len(sections) - 1
        attach(index, parent)
        by_number[number] = index
        stack[:] = []
        node: int | None = index
        while node is not None:  # the open sections are the clause and its ancestors
            stack.insert(0, node)
            node = sections[node].parent

    def open_heading(title: str, level: int) -> None:
        while stack and sections[stack[-1]].level >= level:
            stack.pop()
        sections.append(
            ParsedSection(
                number=f"§{unnumbered}",
                title=title[:_TITLE_MAX],
                level=level,
                page_start=page,
                page_end=page,
            )
        )
        index = len(sections) - 1
        attach(index, stack[-1] if stack else None)
        stack.append(index)

    def add_text(line: str) -> None:
        if sections:
            current = sections[stack[-1]]
            current.text = f"{current.text}\n{line}" if current.text else line
            current.page_end = page
        else:
            body.append(line)

    def add_break() -> None:
        """A blank line: a paragraph ends (Markdown needs it to tell paragraphs, lists and tables
        apart). Never at a section's start, never twice."""
        if sections:
            current = sections[stack[-1]]
            if current.text and not current.text.endswith("\n"):
                current.text += "\n"
        elif body and body[-1] != "":
            body.append("")

    i = 0
    while i < len(raw):
        line = raw[i].strip()
        at = i
        i += 1
        if not line:
            add_break()
            continue
        if _PAGE_BREAK.match(line):
            page += 1
            continue
        if _COMMENT.match(line) or line in ("<figure>", "</figure>"):
            continue
        heading = _HEADING.match(line)
        text = _clean_heading(heading.group(2)) if heading else line
        if text in noise:
            # Keep a running header's FIRST occurrence (the document number, version and
            # effective date are worth one copy: a citation can say which version it is), drop
            # every repeat.
            if text not in kept_once:
                kept_once.add(text)
                add_text(text)
            continue
        for number in synthetic_at.get(at, []):
            open_clause(number, "")
        if at in heading_as:
            # The chapter heading whose number was lost or misread: ". APPENDICES" is
            # 7 APPENDICES, "1. RESPONSIBILITIES" after 3 is 4 RESPONSIBILITIES.
            found = _number_of(text)
            title = found[1] if found and found[1] else re.sub(r"^[^\w(]+", "", _unescape(text))
            open_clause(heading_as[at], title or "")
            continue
        if at in clause_at:
            number, title = _number_of(text) or (clause_at[at], "")
            if title is None:
                # The number alone: its title is the next content line (wrapped lines joined).
                j = i
                while j < len(raw) and (
                    not raw[j].strip() or _COMMENT.match(raw[j].strip()) or raw[j].strip() in noise
                ):
                    j += 1
                if j < len(raw) and _HEADING.match(raw[j].strip()):
                    title, i = _clean_heading(_HEADING.sub(r"\2", raw[j].strip())), j + 1
                elif j < len(raw):
                    title, i = _wrapped_title(raw, j, noise)
                    title = _clean_heading(_unescape(title))
                else:
                    title = ""
            open_clause(number, title)
            continue
        if heading:
            unnumbered += 1
            # An unnumbered heading inside a numbered outline nests under the open clause, so a
            # sub-heading of 5.3 stays part of 5.3's full text.
            level = min(len(heading.group(1)), 6)  # DI writes "#######" for a 7th level
            if stack and sections[stack[-1]].number[0] != "§":
                level = max(level, sections[stack[-1]].level + 1)
            open_heading(text, level)
            continue
        add_text(line)

    for s in sections:
        s.text = s.text.strip("\n")
    while body and body[-1] == "":
        body.pop()
    if body:
        # Text before the first heading (or a document with no heading at all) is kept as its own
        # leading section, "§0": a job description or a plan whose only "headings" are a signature
        # block at the end would otherwise lose nearly all of its content.
        preamble = ParsedSection(
            number="§0",
            title="",
            level=1,
            page_start=1,
            page_end=sections[0].page_start if sections else page,
            text="\n".join(body),
        )
        sections.insert(0, preamble)
        for s in sections[1:]:
            s.parent = s.parent + 1 if s.parent is not None else None
            s.children = [c + 1 for c in s.children]
    return sections


def outline_problems(sections: list[ParsedSection]) -> list[str]:
    """Clauses whose parent is not the section their number names ("7.1 under 6"): what reading
    the tree off line order used to produce. The parser builds none; kept as the check the SOP
    tab shows and the tests assert, so a regression is visible rather than silent."""
    problems = []
    for s in sections:
        if s.number[0] == "§":
            continue
        want = s.number.rsplit(".", 1)[0] if "." in s.number else None
        got = sections[s.parent].number if s.parent is not None else None
        if want is None:
            if got is not None and got[0] != "§":
                problems.append(f"{s.number} under {got}")
        elif got != want:
            problems.append(f"{s.number} under {got or 'the top level'}")
    return problems


def heading_block(number: str, title: str, level: int, text: str) -> str:
    """A section's own part of a full passage, as Markdown: its heading (``##`` for a level-1
    section, one more ``#`` per level, at most six) and its own text."""
    head = (title if number.startswith("§") else f"{number} {title}").strip()
    marked = f"{'#' * min(level + 1, 6)} {head}" if head else ""
    return "\n\n".join(part for part in (marked, text) if part)


def full_text(sections: list[ParsedSection], index: int) -> str:
    """A section's whole passage: its heading, its own text, then every descendant, in order."""
    out: list[str] = []

    def walk(i: int) -> None:
        s = sections[i]
        out.append(heading_block(s.number, s.title, s.level, s.text))
        for child in s.children:
            walk(child)

    walk(index)
    return "\n\n".join(part for part in out if part)


def _blocks(text: str) -> list[str]:
    """A passage's blocks: paragraphs (split at blank lines), with an HTML table kept as one
    block even if blank lines fall inside it (a Markdown table has none)."""
    out: list[str] = []
    table: list[str] | None = None
    for para in re.split(r"\n\s*\n", text):
        if table is not None:
            table.append(para)
            if "</table>" in para:
                out.append("\n\n".join(table))
                table = None
            continue
        if "<table" in para and "</table>" not in para.split("<table", 1)[1]:
            table = [para]
            continue
        if para.strip():
            out.append(para)
    if table is not None:
        out.append("\n\n".join(table))
    return out


def pieces(text: str, max_chars: int, min_chars: int = 0) -> list[str]:
    """A passage too long for one unit, cut into balanced pieces at block boundaries (owner,
    2026-10-10: a long section is split even without sub-headings, but a big table never is).
    A text that fits is one piece. A table is never cut: one larger than ``max_chars`` is a piece
    of its own. The cut is a pure function of the text, so a citation of "piece k" reads the same
    piece every time."""
    if len(text) <= max_chars:
        return [text]
    blocks = _blocks(text)
    count = -(-len(text) // max_chars)  # ceil: as few pieces as fit, all about the same size
    target = len(text) / count
    out: list[str] = []
    current: list[str] = []
    size = 0
    for block in blocks:
        grown = size + (2 if current else 0) + len(block)
        if current and (grown > max_chars or size >= target):
            out.append("\n\n".join(current))
            current, size = [], 0
            grown = len(block)
        current.append(block)
        size = grown
    if current:
        out.append("\n\n".join(current))
    # A fragment under ``min_chars`` (the line before or after a big table) joins its smaller
    # neighbour, even past ``max_chars``: next to a table that is already over it.
    i = 0
    while len(out) > 1 and i < len(out):
        if len(out[i]) >= min_chars:
            i += 1
            continue
        j = min((k for k in (i - 1, i + 1) if 0 <= k < len(out)), key=lambda k: len(out[k]))
        lo, hi = min(i, j), max(i, j)
        out[lo : hi + 1] = [out[lo] + "\n\n" + out[hi]]
        i = lo
    return out
