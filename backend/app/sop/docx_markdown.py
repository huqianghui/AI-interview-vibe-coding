"""Word (.docx) → Markdown, keeping the headings and clause numbers the section splitter needs.

Azure Document Intelligence reads a .docx's headings only from Word heading STYLES, and the client
documents have none (measured 2026-10-08). Their structure is carried two other ways, both handled
here:

- **Word auto-numbering.** Monitoring Plan's headings use a custom style ("Level 1") bound to a
  numbering definition, so "12" is shown in Word but is not in the paragraph text — and the bank's
  Source Hints cite it ("Monitoring Plan section 12"). The numbers are computed the way Word does
  (per-level counters, ``start`` values, ``lvlText`` templates such as ``%1.%2``) and written in
  front of the heading, so the section splitter sees "12 ISSUE IDENTIFICATION ...".
- **Typed headings.** Otherwise a short ALL-CAPS paragraph is a level-1 heading and a short
  all-bold one a level-2 heading.

A real heading style (Heading N / Title) always wins. Tables become Markdown tables in document
order, other list items ``-`` items. A cell merged across columns is written once (Word repeats it
at every grid position it spans, which tripled a job description's text, measured 2026-10-08).
A FORM table — most rows one merged cell, "General Description: ..." — is not a table at all:
each row becomes text, and a row that opens with a short "Label:" becomes a heading over it.
"""

from __future__ import annotations

import io
import re

_HEADING_MAX_CHARS = 120
_STYLE_LEVEL = re.compile(r"^(?:Heading|标题|Level)\s*(\d)$", re.IGNORECASE)


def _w(tag: str) -> str:
    from docx.oxml.ns import qn

    return qn(f"w:{tag}")


def _attr(element, name: str) -> str | None:  # noqa: ANN001 — lxml element
    return None if element is None else element.get(_w(name))


class _Numbering:
    """Word's list numbering for one document: which paragraphs are numbered, and their labels."""

    def __init__(self, document) -> None:  # noqa: ANN001 — python-docx Document
        self._levels: dict[
            str, dict[int, tuple[str, str, int]]
        ] = {}  # numId → ilvl → (fmt, text, start)
        self._counters: dict[str, list[int]] = {}
        try:
            root = document.part.numbering_part.element
        except (KeyError, NotImplementedError, AttributeError):
            return
        abstract = {}
        for node in root.findall(_w("abstractNum")):
            levels = {}
            for lvl in node.findall(_w("lvl")):
                fmt = _attr(lvl.find(_w("numFmt")), "val") or "decimal"
                text = _attr(lvl.find(_w("lvlText")), "val") or ""
                start = int(_attr(lvl.find(_w("start")), "val") or 1)
                levels[int(_attr(lvl, "ilvl") or 0)] = (fmt, text, start)
            abstract[_attr(node, "abstractNumId")] = levels
        for num in root.findall(_w("num")):
            self._levels[_attr(num, "numId")] = abstract.get(
                _attr(num.find(_w("abstractNumId")), "val"), {}
            )

    def of(self, paragraph) -> tuple[str, int] | None:  # noqa: ANN001
        """``(numId, ilvl)`` from the paragraph or, failing that, its style chain."""
        sources = [paragraph._p.pPr]
        style = paragraph.style
        while style is not None:
            sources.append(style.element.find(_w("pPr")))
            style = style.base_style
        for p_pr in sources:
            num_pr = None if p_pr is None else p_pr.find(_w("numPr"))
            num_id = _attr(None if num_pr is None else num_pr.find(_w("numId")), "val")
            if num_id and num_id != "0":
                return num_id, int(_attr(num_pr.find(_w("ilvl")), "val") or 0)
        return None

    def label(self, num_id: str, ilvl: int) -> str | None:
        """Advance the counters and return the label ("12", "4.2"); None for bullets."""
        levels = self._levels.get(num_id, {})
        fmt, text, _start = levels.get(ilvl, ("bullet", "", 1))
        counters = self._counters.setdefault(num_id, [0] * 9)
        if counters[ilvl] == 0:
            counters[ilvl] = levels.get(ilvl, ("", "", 1))[2] - 1
        counters[ilvl] += 1
        for deeper in range(ilvl + 1, 9):
            counters[deeper] = 0
        if fmt != "decimal" or not text:
            return None

        def value(match: re.Match) -> str:
            k = int(match.group(1)) - 1
            n = counters[k] or levels.get(k, ("", "", 1))[2]
            return str(n)

        return re.sub(r"%(\d)", value, text).rstrip(".")


def _typed_heading_level(paragraph, text: str) -> int | None:  # noqa: ANN001
    if len(text) > _HEADING_MAX_CHARS or text.endswith((".", ";", ",", ":")):
        return None
    letters = [c for c in text if c.isalpha()]
    if len(letters) >= 3 and all(c.isupper() for c in letters):
        return 1
    runs = [r for r in paragraph.runs if r.text.strip()]
    if runs and all(r.bold for r in runs):
        return 2
    return None


# A form row's label: "General Description:", "Essential Functions of the job:".
_FORM_LABEL = re.compile(r"^([^:\n]{2,60}):\s*(.*)$", re.DOTALL)
# A table is a form when at least this share of its rows is one merged cell.
_FORM_ROW_SHARE = 0.6


def _row_cells(row) -> list:  # noqa: ANN001 — python-docx _Row
    """The row's cells, each merged cell once (python-docx returns it at every grid column)."""
    seen: set[int] = set()
    cells = []
    for cell in row.cells:
        if id(cell._tc) not in seen:
            seen.add(id(cell._tc))
            cells.append(cell)
    return cells


def _cell_lines(cell) -> list[str]:  # noqa: ANN001
    lines = (re.sub(r"\s+", " ", p.text).strip() for p in cell.paragraphs)
    return [line for line in lines if line]


def _form_markdown(rows: list[list]) -> str:
    blocks: list[str] = []
    for cells in rows:
        for cell in cells:
            lines = _cell_lines(cell)
            if not lines:
                continue
            label = _FORM_LABEL.match(lines[0])
            if label:
                blocks.append(f"## {label.group(1).strip()}")
                lines = [label.group(2).strip(), *lines[1:]]
            blocks.extend(line for line in lines if line)
    return "\n\n".join(blocks)


def _table_markdown(table) -> str:  # noqa: ANN001 — python-docx Table
    rows = [_row_cells(row) for row in table.rows]
    if not rows:
        return ""
    if sum(len(cells) == 1 for cells in rows) >= _FORM_ROW_SHARE * len(rows):
        return _form_markdown(rows)
    lines = []
    for row in table.rows:
        seen: set[int] = set()
        cells = []
        for cell in row.cells:
            # A merged cell's text once; its other grid positions stay empty so columns align.
            first = id(cell._tc) not in seen
            seen.add(id(cell._tc))
            text = re.sub(r"\s+", " ", cell.text).strip() if first else ""
            cells.append(text.replace("|", "\\|"))
        lines.append("| " + " | ".join(cells) + " |")
    width = lines[0].count(" | ") + 1
    return "\n".join([lines[0], "|" + " --- |" * width, *lines[1:]])


def docx_to_markdown(content: bytes) -> str:
    """The document as Markdown, paragraphs and tables in their original order."""
    import docx
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    document = docx.Document(io.BytesIO(content))
    numbering = _Numbering(document)
    blocks: list[str] = []
    for child in document.element.body.iterchildren():
        tag = child.tag.rsplit("}", 1)[-1]
        if tag == "tbl":
            table = _table_markdown(Table(child, document))
            if table:
                blocks.append(table)
            continue
        if tag != "p":
            continue
        paragraph = Paragraph(child, document)
        text = re.sub(r"\s+", " ", paragraph.text).strip()
        if not text:
            continue
        style = (paragraph.style.name if paragraph.style is not None else "") or ""
        numbered = numbering.of(paragraph)
        label = numbering.label(*numbered) if numbered else None
        style_level = _STYLE_LEVEL.match(style)
        if style.lower() == "title":
            level = 1
        elif style_level:
            level = min(int(style_level.group(1)), 6)
        elif label and len(text) <= _HEADING_MAX_CHARS and not text.endswith("."):
            level = min(numbered[1] + 1, 6)  # an auto-numbered short line is a clause heading
        else:
            level = None if numbered else _typed_heading_level(paragraph, text)
        if level is not None:
            blocks.append(f"{'#' * level} {label + ' ' if label else ''}{text}")
        elif numbered:
            blocks.append(f"{label} {text}" if label else f"- {text}")
        else:
            blocks.append(text)
    return "\n\n".join(blocks)
