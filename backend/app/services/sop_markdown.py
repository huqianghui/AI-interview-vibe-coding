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
- **Word → our own converter** (``app.sop.docx_markdown``).
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

_PDF = "application/pdf"


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


def _tokens(text: str) -> list[str]:
    return [w.lower() for w in re.findall(r"[A-Za-z][A-Za-z\-]{3,}|VV-[A-Z]+-\d+", text)]


def page_gaps(page_texts: list[str], markdown: str) -> list[tuple[int, float, list[str]]]:
    """Pages of the PDF text layer that the Markdown does not cover: ``(page, coverage, missing)``.

    "Required" words are those the text layer has at least twice in the document, plus document
    ids (``VV-…-123``). The text layer garbles rotated and interleaved text into one-off tokens
    ("reganaM", "zsyastteimo"); a real omission — a table Document Intelligence did not read —
    loses words and ids that recur. A word counts as covered when the Markdown has it as is,
    reversed (rotated text), or with spaces and hyphens removed (the text layer merges words).
    """
    counts = Counter(w for text in page_texts for w in _tokens(text))
    flat = markdown.lower()
    squashed = re.sub(r"[\s\-]", "", flat)
    gaps = []
    for page, text in enumerate(page_texts, start=1):
        required = {w for w in _tokens(text) if counts[w] >= 2 or w.startswith("vv-")}
        if len(required) < PAGE_REQUIRED_MIN_WORDS:
            continue
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


async def _analyze(content: bytes, endpoint: str, page_count: int) -> dict:
    """The DI ``analyzeResult`` for every page of the PDF."""
    token = await get_bearer_token(COGNITIVE_SERVICES_SCOPE)
    if not token:
        raise RuntimeError("No Entra token for Azure Document Intelligence")
    url = (
        f"{endpoint.rstrip('/')}/documentintelligence/documentModels/prebuilt-layout:analyze"
        f"?api-version={DI_API_VERSION}&outputContentFormat=markdown"
        f"&features=ocrHighResolution&pages=1-{page_count}"
    )
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await _send(
            client, "POST", url, content=content, headers={**headers, "Content-Type": _PDF}
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


async def to_markdown(content: bytes, filename: str) -> MarkdownResult:
    """The whole document as Markdown, or a failure with its reason. Never partial, never raises."""
    ext = _extension(filename)
    try:
        if ext == ".pdf":
            endpoint = get_settings().azure_foundry_endpoint
            if endpoint:
                return MarkdownResult(
                    await _pdf_via_document_intelligence(content, endpoint),
                    "document_intelligence",
                )
            # Dev / CI only: no Document Intelligence configured. Labelled, never silent.
            texts = await asyncio.to_thread(_pdf_page_texts, content)
            return MarkdownResult("\n\n<!-- PageBreak -->\n\n".join(texts), "pdf_text")
        if ext == ".docx":
            from app.sop.docx_markdown import docx_to_markdown

            return MarkdownResult(await asyncio.to_thread(docx_to_markdown, content), "docx")
        if ext in (".txt", ".md"):
            return MarkdownResult(content.decode("utf-8", errors="replace"), "text")
        return MarkdownResult("", "failed", f"unsupported file type {ext or '(none)'}")
    except Exception as exc:  # noqa: BLE001 — recorded as a failed conversion, never a crash
        logger.exception("Could not convert %r to Markdown", filename)
        return MarkdownResult("", "failed", f"{type(exc).__name__}: {exc}"[:1000])
