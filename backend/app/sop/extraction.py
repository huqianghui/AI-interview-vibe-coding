"""SOP text extraction + chunking (SPEC F1 ingestion).

``extract_text`` dispatches by file extension to a per-format extractor and returns ``""`` on
any failure (never raises) — ported from the reference ``skill_text_extractor``. The binary
parsers (pdf/docx/pptx) live in the coverage-omitted ``binary_extractors`` module; plain text
(txt/md) is handled here so the dispatcher + gate + chunking stay fully CI-covered.

``chunk_text`` splits extracted text into fixed-size chunks with a small overlap, on paragraph
boundaries where possible, so a citation can point back to a bounded region of the SOP.
"""

import logging

from app.sop.binary_extractors import (
    extract_docx,
    extract_pdf,
    extract_pptx,
    segments_docx,
    segments_pdf,
    segments_pptx,
)

logger = logging.getLogger(__name__)

# Reference chunk size that the Portal/retrieval pipeline was tuned against.
DEFAULT_CHUNK_SIZE = 512
DEFAULT_CHUNK_OVERLAP = 64


def _extract_plain_text(content: bytes) -> str:
    # decode with replace never raises — no try/except needed.
    return content.decode("utf-8", errors="replace")


def _segments_plain_text(content: bytes) -> list[tuple[str, str]]:
    """Plain text/markdown has no page structure — one whole-document segment labelled ``body``."""
    text = content.decode("utf-8", errors="replace")
    return [("body", text)] if text.strip() else []


# Dispatch by file extension (not MIME) — mirrors the reference extractor map.
_EXTRACTORS = {
    ".pdf": extract_pdf,
    ".docx": extract_docx,
    ".pptx": extract_pptx,
    ".txt": _extract_plain_text,
    ".md": _extract_plain_text,
}

# Segment-aware dispatch: same formats, but each returns [(label, text), ...] preserving the
# page/slide boundary so ingestion can persist a per-chunk location label (F1 traceability).
_SEGMENTERS = {
    ".pdf": segments_pdf,
    ".docx": segments_docx,
    ".pptx": segments_pptx,
    ".txt": _segments_plain_text,
    ".md": _segments_plain_text,
}


def _extension(filename: str) -> str:
    dot = filename.rfind(".")
    return filename[dot:].lower() if dot != -1 else ""


def extract_text(content: bytes, filename: str) -> str:
    """Extract text from an uploaded SOP file. Returns ``""`` on unknown type or any failure."""
    extractor = _EXTRACTORS.get(_extension(filename))
    if extractor is None:
        logger.warning("No extractor for file %r; returning empty text", filename)
        return ""
    try:
        return extractor(content)
    except Exception as exc:  # noqa: BLE001 — belt-and-suspenders on top of each extractor
        logger.warning("Extraction failed for %r: %s", filename, exc)
        return ""


def extract_segments(content: bytes, filename: str) -> list[tuple[str, str]]:
    """Extract ``[(label, text), ...]`` preserving page/slide boundaries for citation labels.

    Returns ``[]`` on unknown type or any failure — the ingestion pipeline treats an empty
    segment list the same as empty text (document persisted, no chunks, status ``failed``).
    """
    segmenter = _SEGMENTERS.get(_extension(filename))
    if segmenter is None:
        logger.warning("No segmenter for file %r; returning no segments", filename)
        return []
    try:
        return segmenter(content)
    except Exception as exc:  # noqa: BLE001 — belt-and-suspenders on top of each segmenter
        logger.warning("Segment extraction failed for %r: %s", filename, exc)
        return []


def chunk_text(
    text: str,
    *,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    overlap: int = DEFAULT_CHUNK_OVERLAP,
) -> list[str]:
    """Split ``text`` into overlapping chunks no longer than ``chunk_size`` characters.

    Prefers to break at a paragraph/newline boundary inside the last ``overlap`` window so
    chunks don't slice mid-sentence; falls back to a hard cut when no boundary is near.
    Whitespace-only input yields no chunks.
    """
    if chunk_size <= 0:
        raise ValueError("chunk_size must be positive")
    if overlap < 0 or overlap >= chunk_size:
        raise ValueError("overlap must be in [0, chunk_size)")

    normalized = text.strip()
    if not normalized:
        return []

    chunks: list[str] = []
    start = 0
    n = len(normalized)
    while start < n:
        end = min(start + chunk_size, n)
        if end < n:
            # Try to end on a newline within the trailing overlap window for cleaner breaks.
            window_start = max(start + chunk_size - overlap, start + 1)
            boundary = normalized.rfind("\n", window_start, end)
            if boundary != -1:
                end = boundary
        chunk = normalized[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= n:
            break
        # Advance with overlap, but always make forward progress (guards against a large
        # overlap relative to a short boundary-shortened chunk looping backward).
        start = max(end - overlap, start + 1)
    return chunks
