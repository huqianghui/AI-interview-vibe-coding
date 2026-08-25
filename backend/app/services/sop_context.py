"""Read SOP source text back out of the local ``sop_chunks`` table (C: richer scoring context).

The scoring path historically judged an answer against the checklist alone — each rubric item
carried only its short ``source_quote``. This module is the read-side counterpart to
``sop_ingestion`` (which writes the chunks): given a checklist item's ``source_document_id`` (+
optional ``source_page``), it reassembles a bounded slice of the *original* SOP text so the judge
can read the fuller passage the item was drawn from, not just the one-line quote.

Two callers share it:
- ``scoring_service`` (feature C) — inline per-item source context in the scoring prompt.
- ``sop_coverage`` (feature D) — the fuller passage a coverage check compares the rubric against.

It never raises on missing data: an unknown document, a doc with no chunks, or a blank corpus all
return ``""`` so the scoring path degrades to exactly today's behaviour (quote-only) rather than
erroring. Output is always length-capped (``max_chars``) to keep prompt tokens bounded.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.sop import SopChunk

# Per-item source-context budget. ~600 chars ≈ a paragraph or two — enough to give the judge the
# surrounding passage without letting a long SOP dominate the prompt. Tunable; the total across a
# question's items is additionally bounded by the caller.
DEFAULT_MAX_CHARS = 600


async def get_source_context(
    db: AsyncSession,
    *,
    document_id: str | None,
    page_label: str | None = None,
    max_chars: int = DEFAULT_MAX_CHARS,
) -> str:
    """Reassemble a bounded slice of a document's original SOP text.

    Chunks are ordered by ``chunk_index`` (their ingestion order). When ``page_label`` is given and
    any chunk carries that label, only those chunks are used (the passage "near" that page/section);
    otherwise the document's leading chunks are used. The joined text is truncated to ``max_chars``
    on a whitespace boundary where possible. Returns ``""`` for a missing/empty document so callers
    degrade gracefully.
    """
    if not document_id or max_chars <= 0:
        return ""

    rows = (
        (
            await db.execute(
                select(SopChunk)
                .where(SopChunk.document_id == document_id)
                .order_by(SopChunk.chunk_index)
            )
        )
        .scalars()
        .all()
    )
    if not rows:
        return ""

    # Prefer chunks tagged with the item's page/section label (the passage it was drawn from).
    # Fall back to the whole document in order when the label matches nothing (e.g. md/txt whose
    # single segment is labelled "body", or a stale label).
    if page_label:
        matched = [r for r in rows if r.page_label == page_label]
        selected = matched or rows
    else:
        selected = rows

    joined = "\n".join(r.content for r in selected if r.content).strip()
    return _truncate(joined, max_chars)


def _truncate(text: str, max_chars: int) -> str:
    """Cut ``text`` to at most ``max_chars``, preferring a whitespace boundary near the limit."""
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars]
    # Back off to the last whitespace so we don't slice mid-word; keep most of the budget.
    boundary = cut.rfind(" ")
    newline = cut.rfind("\n")
    boundary = max(boundary, newline)
    if boundary >= max_chars // 2:
        cut = cut[:boundary]
    return cut.rstrip() + "…"
