"""Binary-format text extractors (coverage-omitted — need the ``azure`` extra's parsers).

pdfplumber / python-docx / python-pptx are optional deps not installed in CI, so these are
imported lazily and this module is coverage-omitted (same precedent as the azure adapters).
The dispatcher in ``extraction.py`` (CI-covered) wraps every call in try/except, so a missing
parser degrades to ``""`` rather than crashing ingestion.

Each extractor follows the reference ``skill_text_extractor`` pattern verbatim:
lazy import, try/except, return ``""`` on any failure (never raises).
"""

import io
import logging

logger = logging.getLogger(__name__)


def extract_pdf(content: bytes) -> str:
    try:
        import pdfplumber

        pages: list[str] = []
        with pdfplumber.open(io.BytesIO(content)) as pdf:
            for page in pdf.pages:
                text = page.extract_text()
                if text:
                    pages.append(text)
        return "\n\n".join(pages)
    except Exception as exc:  # noqa: BLE001 — degrade to empty, never break ingestion
        logger.warning("PDF extraction failed: %s", exc)
        return ""


def extract_docx(content: bytes) -> str:
    try:
        from docx import Document

        doc = Document(io.BytesIO(content))
        parts: list[str] = []
        for para in doc.paragraphs:
            if para.text.strip():
                parts.append(para.text)
        for table in doc.tables:
            for row in table.rows:
                cells = [cell.text.strip() for cell in row.cells if cell.text.strip()]
                if cells:
                    parts.append(" | ".join(cells))
        return "\n".join(parts)
    except Exception as exc:  # noqa: BLE001
        logger.warning("DOCX extraction failed: %s", exc)
        return ""


def extract_pptx(content: bytes) -> str:
    try:
        from pptx import Presentation

        slides: list[str] = []
        prs = Presentation(io.BytesIO(content))
        for slide in prs.slides:
            shapes: list[str] = []
            for shape in slide.shapes:
                if hasattr(shape, "text") and shape.text.strip():
                    shapes.append(shape.text)
            if shapes:
                slides.append("\n".join(shapes))
        return "\n\n---\n\n".join(slides)
    except Exception as exc:  # noqa: BLE001
        logger.warning("PPTX extraction failed: %s", exc)
        return ""
