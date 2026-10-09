"""SOP file → Markdown (spec: docs/planning/spec-sop-section-grounding.md).

A conversion either produces the WHOLE document or fails: there is no partial result. Owner, on
review: "要么全部成功，要么失败 … 先有全部的 markdown 内容，再说处理的事".

- **PDF → Azure Document Intelligence** ``prebuilt-layout`` (Markdown output) on the AI Foundry
  resource the app already uses (``AZURE_FOUNDRY_ENDPOINT``), Entra-authenticated. Called with
  every page named explicitly (``pages=1-N``) and ``features=ocrHighResolution``, then checked:
    - the result must have exactly N pages;
    - every page must contain the words the PDF's own text layer has on it (see
      :func:`page_gaps`), at :data:`PAGE_COVERAGE_MIN`.
  Measured 2026-10-08 on the 22 client PDFs (485 pages): the default mode read only 34 of a dense
  table page's words (Study-Specific Training Matrix p.3) while still returning every page;
  ``ocrHighResolution`` read it whole, and with it every page of every PDF passes the check.
  Without an endpoint (dev / CI) the PDF's text layer is used and the source says so.
- **PowerPoint → Azure Document Intelligence** too (``.pptx``; owner, 2026-10-09: SOPs come as
  PDF, Word or PowerPoint, Excel is not supported). A deck has no reliable page numbers, so there
  is no per-page check: a result with no text is a failure (:func:`to_markdown`). Without an
  endpoint it cannot be converted at all.
- **Word → PDF (LibreOffice) → Azure Document Intelligence** (owner, 2026-10-09: one converter
  for every format). DI reads a .docx's text but not its structure: the client files number their
  headings with Word auto-numbering under a custom style, which DI neither computes nor treats as
  a heading (measured: 1 section per document, no clause number, 1 "page"). Printed to PDF, the
  numbers and the page layout are on the page, and DI reads them like any PDF (Monitoring Plan: 14
  numbered sections over 29 pages, as many as our own converter found, now with real pages). The
  completeness check compares DI's text with the .docx's own text, not with the PDF's text layer:
  LibreOffice's text layer doubles Chinese characters ("检检"), which DI does not.
  Without LibreOffice or DI (dev, CI) the document is converted by our own converter
  (``app.sop.docx_markdown``) and labelled ``docx``.
- **Text / Markdown** as is.

:func:`to_markdown` never raises: a failure returns an empty Markdown with the reason, and the
document is kept with no sections until it is converted again.
"""

from __future__ import annotations

import asyncio
import io
import logging
import re
from collections import Counter
from dataclasses import dataclass

import httpx

from app.config import get_settings
from app.services.azure_auth import COGNITIVE_SERVICES_SCOPE, get_bearer_token

logger = logging.getLogger(__name__)

DI_API_VERSION = "2024-11-30"
DI_POLL_SECONDS = 2.0
DI_TIMEOUT_SECONDS = 600.0
# Throttling: 3 of 26 documents submitted at once got 429 (measured 2026-10-08). A throttled call
# waits as told (Retry-After) and tries again.
DI_MAX_THROTTLED_RETRIES = 8
DI_DEFAULT_RETRY_AFTER_SECONDS = 10.0
_THROTTLED = {429, 503}
# Per-page completeness. Measured 2026-10-08: the known-incomplete page scored 89.3%, every page of
# every client PDF read with ocrHighResolution scored >= 98.5% (the shortfall being text-layer
# garbage such as "vv-qdonc-"), so 95% separates them with room on both sides.
PAGE_COVERAGE_MIN = 0.95
# A page with fewer required words than this carries too little text to judge (a cover, a blank).
PAGE_REQUIRED_MIN_WORDS = 10
# A page's words are looked for in its own Markdown page and the pages either side: Document
# Intelligence sometimes places a running header or a table row across the page break. Measured
# 2026-10-08: the page alone false-fails a complete PDF (94%), ±1 passes every complete page and
# scores the known-incomplete page lower than the whole document does (87% vs 89%).
PAGE_WINDOW = 1
_PAGE_BREAK = "<!-- PageBreak -->"

_PDF = "application/pdf"
# Office formats Document Intelligence converts (prebuilt-layout); Word is converted by our own.
_OFFICE = {
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

# The current converter for each source. Raise one when its output changes, and every document
# converted by the older version is converted again by the next background build.
# docx 2 (v0.55.0.0): merged cells once, form tables as labelled sections.
# docx 3 (v0.62.0.0): Word goes through PDF (LibreOffice) → DI, so every Word document converted by
# our own converter is converted again (and becomes "document_intelligence").
# docx 4 (v0.62.4.0): the PDF route is on in the image, with the table of contents removed first;
# every Word document converted by our own converter goes through it.
CONVERTER_VERSIONS = {"document_intelligence": 1, "pdf_text": 1, "docx": 4, "text": 1}


@dataclass(frozen=True)
class MarkdownResult:
    markdown: str
    # document_intelligence | pdf_text | docx | text | failed
    source: str
    error: str = ""


class IncompleteConversion(RuntimeError):
    """Document Intelligence returned a result that is not the whole document."""


def _extension(filename: str) -> str:
    dot = filename.rfind(".")
    return filename[dot:].lower() if dot != -1 else ""


_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
_CJK_RUN = re.compile(r"[\u4e00-\u9fff]{2,}")


def _tokens(text: str) -> list[str]:
    """Latin words of 4+ letters, document ids, and every two-character pair of a Chinese run
    (Chinese has no spaces, so pairs are the unit both readers agree on)."""
    words = [w.lower() for w in re.findall(r"[A-Za-z][A-Za-z\-]{3,}|VV-[A-Z]+-\d+", text)]
    for run in _CJK_RUN.findall(text):
        words.extend(run[i : i + 2] for i in range(len(run) - 1))
    return words


def text_gaps(source_text: str, markdown: str) -> tuple[float, list[str]]:
    """How much of a document's own text (a .docx) the Markdown covers: ``(coverage, missing)``.
    The same "required" words as :func:`page_gaps` (recurring words and document ids), for the
    whole document at once: the source has no pages to compare page by page."""
    counts = Counter(_tokens(source_text))
    required = {w for w, n in counts.items() if n >= 2 or w.startswith("vv-")}
    if not required:
        return 1.0, []
    flat = markdown.lower()
    squashed = re.sub(r"[\s\-]", "", flat)
    missing = sorted(
        w
        for w in required
        if w not in flat and w[::-1] not in flat and w.replace("-", "") not in squashed
    )
    return 1 - len(missing) / len(required), missing


def page_gaps(page_texts: list[str], markdown: str) -> list[tuple[int, float, list[str]]]:
    """Pages of the PDF text layer that the Markdown does not cover: ``(page, coverage, missing)``.

    "Required" words are those the text layer has at least twice in the document, plus document
    ids (``VV-…-123``). The text layer garbles rotated and interleaved text into one-off tokens
    ("reganaM", "zsyastteimo"); a real omission — a table Document Intelligence did not read —
    loses words and ids that recur. A word counts as covered when the Markdown has it as is,
    reversed (rotated text), or with spaces and hyphens removed (the text layer merges words).
    Each page is checked against its own Markdown page and its neighbours (:data:`PAGE_WINDOW`),
    so a word read elsewhere in the document does not cover a page that lost it. The caller has
    already checked the page counts match.
    """
    counts = Counter(w for text in page_texts for w in _tokens(text))
    md_pages = markdown.split(_PAGE_BREAK)
    gaps = []
    for page, text in enumerate(page_texts, start=1):
        required = {w for w in _tokens(text) if counts[w] >= 2 or w.startswith("vv-")}
        if len(required) < PAGE_REQUIRED_MIN_WORDS:
            continue
        lo, hi = max(0, page - 1 - PAGE_WINDOW), page + PAGE_WINDOW
        flat = "".join(md_pages[lo:hi]).lower()
        squashed = re.sub(r"[\s\-]", "", flat)
        missing = sorted(
            w
            for w in required
            if w not in flat and w[::-1] not in flat and w.replace("-", "") not in squashed
        )
        coverage = 1 - len(missing) / len(required)
        if coverage < PAGE_COVERAGE_MIN:
            gaps.append((page, coverage, missing[:10]))
    return gaps


def _pdf_page_texts(content: bytes) -> list[str]:
    import pdfplumber

    with pdfplumber.open(io.BytesIO(content)) as pdf:
        return [page.extract_text() or "" for page in pdf.pages]


async def _send(client: httpx.AsyncClient, method: str, url: str, **kwargs) -> httpx.Response:
    """One DI request, retrying while it is throttled."""
    for attempt in range(DI_MAX_THROTTLED_RETRIES + 1):
        resp = await client.request(method, url, **kwargs)
        if resp.status_code not in _THROTTLED or attempt == DI_MAX_THROTTLED_RETRIES:
            resp.raise_for_status()
            return resp
        try:
            wait = float(resp.headers.get("retry-after", DI_DEFAULT_RETRY_AFTER_SECONDS))
        except ValueError:
            wait = DI_DEFAULT_RETRY_AFTER_SECONDS
        logger.info("Document Intelligence throttled (%s); retry in %.0f s", resp.status_code, wait)
        await asyncio.sleep(min(wait, 60.0))
    raise RuntimeError("unreachable")  # pragma: no cover


async def _analyze(
    content: bytes, endpoint: str, page_count: int | None, content_type: str = _PDF
) -> dict:
    """The DI ``analyzeResult``: for a PDF every page named explicitly (``page_count``) and read
    with high-resolution OCR; for an Office file (``page_count`` None) the whole file."""
    token = await get_bearer_token(COGNITIVE_SERVICES_SCOPE)
    if not token:
        raise RuntimeError("No Entra token for Azure Document Intelligence")
    url = (
        f"{endpoint.rstrip('/')}/documentintelligence/documentModels/prebuilt-layout:analyze"
        f"?api-version={DI_API_VERSION}&outputContentFormat=markdown"
    )
    if page_count is not None:
        url += f"&features=ocrHighResolution&pages=1-{page_count}"
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await _send(
            client, "POST", url, content=content, headers={**headers, "Content-Type": content_type}
        )
        operation = resp.headers["operation-location"]
        deadline = asyncio.get_running_loop().time() + DI_TIMEOUT_SECONDS
        while True:
            await asyncio.sleep(DI_POLL_SECONDS)
            body = (await _send(client, "GET", operation, headers=headers)).json()
            status = body.get("status")
            if status == "succeeded":
                return body["analyzeResult"]
            if status == "failed":
                raise RuntimeError(f"Document Intelligence failed: {body.get('error')}")
            if asyncio.get_running_loop().time() > deadline:
                raise TimeoutError("Document Intelligence did not finish in time")


async def _pdf_via_document_intelligence(content: bytes, endpoint: str) -> str:
    page_texts = await asyncio.to_thread(_pdf_page_texts, content)
    result = await _analyze(content, endpoint, len(page_texts))
    got = len(result.get("pages", []))
    if got != len(page_texts):
        raise IncompleteConversion(f"{got} of {len(page_texts)} pages converted")
    markdown = result["content"]
    gaps = page_gaps(page_texts, markdown)
    if gaps:
        detail = "; ".join(f"page {p}: {c:.0%} (missing {', '.join(m[:5])})" for p, c, m in gaps)
        raise IncompleteConversion(f"pages not fully read: {detail}")
    return markdown


LIBREOFFICE_TIMEOUT_SECONDS = 180


def libreoffice() -> str | None:
    """The LibreOffice command (installed in the backend image), or None (dev, CI)."""
    import shutil

    return shutil.which("soffice") or shutil.which("libreoffice")


_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
# Word's built-in names for table-of-contents styles ("toc 1".."toc 9", "TOC Heading"). A style's
# id is localised (Chinese Word uses "10", "20"), its name never is.
_TOC_STYLE = re.compile(r"^toc( \d| heading)$", re.IGNORECASE)


def strip_table_of_contents(content: bytes) -> bytes:
    """The .docx without its table of contents, before it is printed to PDF.

    A printed table of contents is a list of every heading with its page number; Document
    Intelligence reads it as headings, so clause numbers came out as page numbers (a client SOP
    lost 6 of 14 clauses on the server, 2026-10-09). Word keeps it in a content control marked
    "Table of Contents", or (older files) as paragraphs in the "toc N" styles; both are removed.
    The contents are only a copy of the headings, so nothing of the document is lost."""
    import docx

    document = docx.Document(io.BytesIO(content))
    body = document.element.body
    removed = 0
    for sdt in list(body.iter(f"{_W}sdt")):
        gallery = sdt.find(f"{_W}sdtPr/{_W}docPartObj/{_W}docPartGallery")
        if gallery is not None and gallery.get(f"{_W}val") == "Table of Contents":
            sdt.getparent().remove(sdt)
            removed += 1
    toc_styles = {s.style_id for s in document.styles if s.name and _TOC_STYLE.match(s.name)}
    for paragraph in list(body.iter(f"{_W}p")):
        style = paragraph.find(f"{_W}pPr/{_W}pStyle")
        if style is not None and style.get(f"{_W}val") in toc_styles:
            paragraph.getparent().remove(paragraph)
            removed += 1
    if not removed:
        return content
    out = io.BytesIO()
    document.save(out)
    return out.getvalue()


def _docx_to_pdf(content: bytes, soffice: str) -> bytes:
    """Print a .docx to PDF with LibreOffice, headless, in a private temporary directory (its
    own profile too, so two conversions never share one)."""
    import os
    import signal
    import subprocess
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "document.docx"
        source.write_bytes(content)
        # Its own process group: soffice is a launcher script that starts soffice.bin, and a
        # timeout must kill both, not leave soffice.bin running in the container.
        process = subprocess.Popen(
            [
                soffice,
                "--headless",
                "--norestore",
                f"-env:UserInstallation=file://{tmp}/profile",
                "--convert-to",
                "pdf",
                "--outdir",
                tmp,
                str(source),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        try:
            _, stderr = process.communicate(timeout=LIBREOFFICE_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
            raise RuntimeError(f"LibreOffice took over {LIBREOFFICE_TIMEOUT_SECONDS} s") from None
        if process.returncode != 0:
            raise RuntimeError(f"LibreOffice failed: {stderr.decode(errors='replace')[-300:]}")
        pdf = Path(tmp) / "document.pdf"
        if not pdf.exists():
            raise RuntimeError("LibreOffice produced no PDF")
        return pdf.read_bytes()


def _docx_text(content: bytes) -> str:
    """The .docx's own text: every paragraph and table cell, for the completeness check."""
    import docx

    document = docx.Document(io.BytesIO(content))
    parts = [p.text for p in document.paragraphs]
    for table in document.tables:
        for row in table.rows:
            parts.extend(cell.text for cell in row.cells)
    return "\n".join(parts)


async def _docx_via_document_intelligence(content: bytes, endpoint: str, soffice: str) -> str:
    printable = await asyncio.to_thread(strip_table_of_contents, content)
    pdf = await asyncio.to_thread(_docx_to_pdf, printable, soffice)
    page_count = len(await asyncio.to_thread(_pdf_page_texts, pdf))
    if page_count == 0:
        raise IncompleteConversion("LibreOffice printed the document to an empty PDF")
    result = await _analyze(pdf, endpoint, page_count)
    got = len(result.get("pages", []))
    if got != page_count:
        raise IncompleteConversion(f"{got} of {page_count} pages converted")
    markdown = result["content"]
    coverage, missing = text_gaps(await asyncio.to_thread(_docx_text, content), markdown)
    if coverage < PAGE_COVERAGE_MIN:
        raise IncompleteConversion(
            f"the document is not fully read: {coverage:.0%} (missing {', '.join(missing[:8])})"
        )
    return markdown


async def to_markdown(content: bytes, filename: str) -> MarkdownResult:
    """The whole document as Markdown, or a failure with its reason. Never partial, never raises.
    A conversion with no text at all (a scanned PDF without Document Intelligence, an empty file)
    is a failure too: nothing to cite is not a converted document."""
    result = await _convert(content, filename)
    if result.source != "failed" and not _COMMENT.sub("", result.markdown).strip():
        return MarkdownResult("", "failed", "the conversion produced no text")
    return result


async def _convert(content: bytes, filename: str) -> MarkdownResult:
    ext = _extension(filename)
    try:
        if ext == ".pdf":
            endpoint = get_settings().azure_foundry_endpoint
            if endpoint:
                # A hard bound on the whole call: throttled retries sleep outside the poll loop.
                async with asyncio.timeout(DI_TIMEOUT_SECONDS):
                    markdown = await _pdf_via_document_intelligence(content, endpoint)
                return MarkdownResult(markdown, "document_intelligence")
            # Dev / CI only: no Document Intelligence configured. Labelled, never silent.
            texts = await asyncio.to_thread(_pdf_page_texts, content)
            return MarkdownResult("\n\n<!-- PageBreak -->\n\n".join(texts), "pdf_text")
        if ext in _OFFICE:
            endpoint = get_settings().azure_foundry_endpoint
            if not endpoint:
                return MarkdownResult(
                    "", "failed", f"{ext} needs Azure Document Intelligence, which is not set up"
                )
            async with asyncio.timeout(DI_TIMEOUT_SECONDS):
                result = await _analyze(content, endpoint, None, _OFFICE[ext])
            return MarkdownResult(result.get("content", ""), "document_intelligence")
        if ext == ".docx":
            endpoint = get_settings().azure_foundry_endpoint
            soffice = libreoffice()
            if not get_settings().sop_word_via_pdf:
                # Dev / CI (the image turns the PDF route on: one pipeline for every format).
                from app.sop.docx_markdown import docx_to_markdown

                return MarkdownResult(await asyncio.to_thread(docx_to_markdown, content), "docx")
            if endpoint and soffice:
                async with asyncio.timeout(DI_TIMEOUT_SECONDS):
                    markdown = await _docx_via_document_intelligence(content, endpoint, soffice)
                return MarkdownResult(markdown, "document_intelligence")
            if get_settings().sop_require_libreoffice:
                # A published image never falls back (a "docx" result would never be redone).
                if not soffice:
                    raise RuntimeError("LibreOffice is not installed: Word cannot be converted")
                raise RuntimeError("Word needs Document Intelligence, which is not configured")
            # Dev / CI only (no LibreOffice or no DI): our own converter, labelled.
            from app.sop.docx_markdown import docx_to_markdown

            return MarkdownResult(await asyncio.to_thread(docx_to_markdown, content), "docx")
        if ext in (".txt", ".md"):
            return MarkdownResult(content.decode("utf-8", errors="replace"), "text")
        return MarkdownResult("", "failed", f"unsupported file type {ext or '(none)'}")
    except Exception as exc:  # noqa: BLE001 — recorded as a failed conversion, never a crash
        logger.exception("Could not convert %r to Markdown", filename)
        return MarkdownResult("", "failed", f"{type(exc).__name__}: {exc}"[:1000])
