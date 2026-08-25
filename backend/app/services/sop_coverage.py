"""Optional SOP original-text coverage check (feature D) — a reference-only audit, never a score.

The scored result is a deterministic function of the checklist alone (features C/§scoring keep it
that way). This module answers a *different*, opt-in question a reviewer sometimes wants: "did the
rubric miss anything the original SOP actually requires?" It re-reads the fuller SOP passage behind
a question's checklist and asks the LLM which SOP points look **not covered** by any checklist item.

Strictly advisory:
- It runs only when the caller passes ``sop_coverage_check=True`` (the report route's opt-in
  checkbox). Default off ⇒ zero extra LLM calls and byte-identical behaviour to before.
- Its output is attached to the report for display; it NEVER feeds back into
  ``QuestionResult.score`` or the interview total. Turning it on cannot change a single score.

Robustness mirrors ``checklist_service.draft_checklist``: the LLM output is untrusted, so a parse
failure or empty result degrades to "no findings" rather than erroring the report.
"""

from __future__ import annotations

import json
import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.services import checklist_service, sop_context
from app.services.agents.registry import get_llm_adapter

logger = logging.getLogger(__name__)

# The fuller passage the audit reads per question. Larger than the per-item scoring budget because
# here we compare the WHOLE rubric against the WHOLE relevant passage, not one item.
COVERAGE_CONTEXT_CHARS = 2400

# Marker string the mock LLM adapter keys on to return a deterministic coverage payload in CI.
COVERAGE_PROMPT_MARKER = "auditing SOP coverage"


def _build_coverage_prompt(question_text: str, rubric_lines: list[str], sop_passage: str) -> str:
    """Ask the LLM which SOP points are NOT covered by the checklist. JSON-only output."""
    rubric_block = "\n".join(rubric_lines)
    return (
        f"You are {COVERAGE_PROMPT_MARKER}: checking whether a scoring checklist fully covers the "
        "requirements stated in the original SOP passage for one interview question.\n"
        "The SOP and the checklist may be in different languages — compare by meaning.\n"
        "Identify SOP points/requirements that are NOT already covered by any checklist item. "
        "Do NOT restate points the checklist already covers. If everything is covered, return an "
        "empty list.\n"
        'Return ONLY JSON: {"missing": [{"point", "sop_evidence"}]}. '
        "point is the uncovered requirement in your own words; sop_evidence is a short verbatim "
        "span from the SOP passage supporting it.\n\n"
        f"QUESTION:\n{question_text}\n\nCHECKLIST ITEMS:\n{rubric_block}\n\n"
        f"SOP PASSAGE:\n{sop_passage}\n"
    )


def _parse_missing(raw_output: str) -> list[dict]:
    """Best-effort parse of the LLM coverage JSON into ``{point, sop_evidence}`` dicts."""
    try:
        parsed = json.loads(raw_output)
    except (ValueError, TypeError):
        return []
    missing = parsed.get("missing") if isinstance(parsed, dict) else parsed
    if not isinstance(missing, list):
        return []
    out: list[dict] = []
    for m in missing:
        if isinstance(m, dict) and str(m.get("point", "")).strip():
            out.append(
                {
                    "point": str(m["point"]).strip(),
                    "sop_evidence": str(m.get("sop_evidence", "")).strip(),
                }
            )
    return out


async def check_question_coverage(
    db: AsyncSession,
    *,
    question_id: str,
    question_text: str,
    llm_provider: str | None = None,
) -> list[dict]:
    """Return SOP points for one question that appear uncovered by its checklist (may be empty).

    Returns ``[]`` (no findings) whenever there's nothing to audit — no checklist, no linked SOP
    source, no retrievable passage, or an unparseable LLM response — so the caller can always attach
    the result without special-casing failure.
    """
    checklist = await checklist_service.get_default_checklist(db, question_id)
    if checklist is None:
        return []
    items = await checklist_service.list_items(db, checklist.id)
    if not items:
        return []

    # Assemble the fuller SOP passage from the first item that links a source document.
    document_id = next((it.source_document_id for it in items if it.source_document_id), None)
    page_label = next(
        (it.source_page for it in items if it.source_document_id and it.source_page), None
    )
    sop_passage = await sop_context.get_source_context(
        db, document_id=document_id, page_label=page_label, max_chars=COVERAGE_CONTEXT_CHARS
    )
    if not sop_passage:
        # No original SOP text to compare against (e.g. hand-authored rubric) — nothing to audit.
        return []

    rubric_lines = [f"({it.kind}) {it.text}" for it in items]
    prompt = _build_coverage_prompt(question_text, rubric_lines, sop_passage)
    raw = await get_llm_adapter(llm_provider).complete(prompt, json_mode=True)
    return _parse_missing(raw)
