"""Read the citation labels existing rubrics carry (spec-sop-section-grounding §4).

The imported rf-CSM rubrics cite their SOPs by LABEL, not by text: "Clinical Site Management and
Monitoring SOP sections 4.2, 5.3, 5.6.2.3; Monitoring Plan section 12", "Clinical Study Manager JD",
"Issue Management and Escalation SOP sections 5.1-5.8". This turns a label into
``(document, [section numbers])`` pairs against our own documents and sections. Pure functions:
no database, no model.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field

# "section 4.2", "sections 4.2, 5.3 and 5.6.2.3", "sections 5.1-5.8", "§ 12"
_SECTIONS = re.compile(r"(?:\bsections?\b|§)\s*((?:\d+(?:\.\d+)*\s*(?:[,–\-]|and|&)?\s*)+)", re.I)
_NUMBER = re.compile(r"\d+(?:\.\d+)*")
_RANGE = re.compile(r"(\d+(?:\.\d+)*)\s*[–\-]\s*(\d+(?:\.\d+)*)")
# Document ids and words that say what kind of document, not which one.
_NOISE = re.compile(r"\bVV-[A-Z]+-\d+\b|\(\d+\)|\bv\d+(?:\.\d+)*\b|\d{1,2}[A-Za-z]{3}\d{4}", re.I)
_KIND_WORDS = frozenset(
    "sop sops wi jd final document doc docx pdf procedure work instruction the and of a an for in "
    "to on".split()
)
# A label names a document when it covers at least this share of the document's own name words.
MATCH_MIN = 0.6


def _words(text: str) -> set[str]:
    text = _NOISE.sub(" ", text.lower().replace("_", " "))
    text = re.sub(r"\.(pdf|docx?|txt|md)$", "", text.strip())
    return {w for w in re.findall(r"[a-z0-9]+", text) if w not in _KIND_WORDS}


@dataclass(frozen=True)
class DocumentName:
    document_id: str
    name: str


@dataclass
class LabelPart:
    document_id: str | None
    # True when the label names every word of the document's name: only then are its listed
    # sections taken as given. A partial match only narrows the search, which the model checks.
    exact: bool = False
    numbers: list[str] = field(default_factory=list)
    # (start, end) of each range written as "5.1-5.8".
    ranges: list[tuple[str, str]] = field(default_factory=list)


def match_document(text: str, documents: Sequence[DocumentName]) -> tuple[str | None, float]:
    """The document a label part names, and how fully: the one whose name words it covers best.
    Equal cover goes to the LONGER name, the one that explains more of the label ("Senior Clinical
    Study Manager JD" is the senior role's document; "Clinical Study Manager JD" covers the senior
    name only 3/4 and so already prefers the other)."""
    label = _words(text)
    best: tuple[float, int, str] | None = None
    for doc in documents:
        words = _words(doc.name)
        if not words:
            continue
        cover = len(label & words) / len(words)
        key = (cover, len(words), doc.document_id)
        if cover >= MATCH_MIN and (best is None or key > best):
            best = key
    return (best[2], best[0]) if best else (None, 0.0)


def parse_label(label: str, documents: Sequence[DocumentName]) -> list[LabelPart]:
    """Each ';'-separated part of a label as the document it names and the sections it lists."""
    parts: list[LabelPart] = []
    for raw in re.split(r";", label or ""):
        raw = raw.strip()
        if not raw:
            continue
        numbers: list[str] = []
        ranges: list[tuple[str, str]] = []
        for match in _SECTIONS.finditer(raw):
            listed = match.group(1)
            for start, end in _RANGE.findall(listed):
                ranges.append((start, end))
            singles = _RANGE.sub(" ", listed)
            numbers.extend(_NUMBER.findall(singles))
        document_id, cover = match_document(_SECTIONS.sub(" ", raw), documents)
        parts.append(LabelPart(document_id, cover == 1.0, numbers, ranges))
    return parts


def _key(number: str) -> tuple[int, ...]:
    return tuple(int(p) for p in number.split("."))


def expand_range(start: str, end: str, numbers: Sequence[str]) -> list[str]:
    """The document's section numbers from ``start`` to ``end`` at the same depth ("5.1-5.8" →
    5.1, 5.2, ... 5.8 as they exist), in document order."""
    depth = start.count(".")
    lo, hi = _key(start), _key(end)
    numbered = [
        n for n in numbers if _NUMBER.fullmatch(n)
    ]  # "§3" headings have no place in a range
    return [n for n in numbered if n.count(".") == depth and lo <= _key(n) <= hi]
