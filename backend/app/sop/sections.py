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


# How many recently accepted clauses a heading may continue from (one stray clause in between
# must not block it), and how far its first differing part may move forward.
_HEADING_LOOKBACK = 5
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


def parse_sections(markdown: str) -> list[ParsedSection]:
    """The document's sections in order, with parent/children links and page ranges."""
    raw = markdown.replace("\r\n", "\n").split("\n")
    noise = _noise_lines(raw)
    sections: list[ParsedSection] = []
    stack: list[int] = []  # indices of the open sections, outermost first
    body: list[str] = []  # text before the first section (a preamble)
    page = 1
    last_number: str | None = None
    # The clauses accepted so far, newest last. DI marks a heading only from the page's layout,
    # so a numbered heading is trusted further than a number at the start of a body line: it may
    # continue from any of the last few clauses (``_heading_follows``), so one stray clause ("8.1
    # The SCV Lead documents ...", a sentence) cannot make every later heading look out of order.
    accepted: list[str] = []
    unnumbered = 0
    kept_once: set[str] = set()

    def open_section(number: str, title: str, level: int) -> None:
        while stack and sections[stack[-1]].level >= level:
            stack.pop()
        parent = stack[-1] if stack else None
        sections.append(
            ParsedSection(
                number=number,
                title=title[:_TITLE_MAX],
                level=level,
                page_start=page,
                page_end=page,
                parent=parent,
            )
        )
        index = len(sections) - 1
        if parent is not None:
            sections[parent].children.append(index)
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

        numbered = _NUMBERED_INLINE.match(text) or _NUMBERED_TIGHT.match(text)
        alone = None if numbered else _NUMBER_ALONE.match(text)
        if alone:
            # "4.2" alone: the clause's text is the next non-empty, non-noise line.
            j = i
            while j < len(raw) and (
                not raw[j].strip() or _COMMENT.match(raw[j].strip()) or raw[j].strip() in noise
            ):
                j += 1
            if j < len(raw) and _is_successor(last_number, alone.group(1)):
                title = _clean_heading(_HEADING.sub(r"\2", raw[j].strip()))
                clause = alone.group(1)
                last_number = clause
                accepted.append(clause)
                open_section(clause, title, len(_parts(clause)))
                i = j + 1
                continue
        if (
            numbered
            and not _NOT_A_CLAUSE.match(text)
            and (
                _is_successor(last_number, numbered.group(1))
                or (
                    heading is not None
                    and any(
                        _heading_follows(p, numbered.group(1))
                        for p in accepted[-_HEADING_LOOKBACK:]
                    )
                )
            )
        ):
            clause = numbered.group(1)
            last_number = clause
            accepted.append(clause)
            open_section(clause, numbered.group(2), len(_parts(clause)))
            continue
        if heading and not numbered:
            unnumbered += 1
            # An unnumbered heading inside a numbered outline nests under the open clause, so a
            # sub-heading of 5.3 stays part of 5.3's full text.
            level = min(len(heading.group(1)), 6)  # DI writes "#######" for a 7th level
            if stack and sections[stack[-1]].number[0] != "§":
                level = max(level, sections[stack[-1]].level + 1)
            open_section(f"§{unnumbered}", text, level)
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
