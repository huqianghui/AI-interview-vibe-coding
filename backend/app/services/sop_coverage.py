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
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.services import bank_version_service, scoring_service, sop_context
from app.services.agents.registry import get_llm_adapter

logger = logging.getLogger(__name__)

# TOTAL passage budget for one question's audit, across every SOP document its rubric cites. Larger
# than the per-item scoring budget because here we compare the WHOLE rubric against the WHOLE
# relevant passage, not one item.
COVERAGE_CONTEXT_CHARS = 2400

# Floor for ONE document's slice of that budget, matching `scoring_service`'s per-item budget. A
# question citing several SOPs splits the total evenly, but a sliver of a long document cannot
# support the judgement "this requirement is missing from the rubric", so sources past what the
# budget can serve at this floor are left unaudited rather than audited badly. With the two values
# above that is at most four documents per question — measured on the default bank, the busiest
# checklist cites two.
COVERAGE_MIN_PASSAGE_CHARS = 600

# Marker string the mock LLM adapter keys on to return a deterministic coverage payload in CI.
COVERAGE_PROMPT_MARKER = "auditing SOP coverage"


def _build_coverage_prompt(
    question_text: str, rubric_lines: list[str], passages: list[tuple[str | None, str]]
) -> str:
    """Ask the LLM which SOP points are NOT covered by the checklist. JSON-only output.

    ``passages`` is one ``(page_label, text)`` per cited SOP document, labelled and separated so two
    documents' requirements are not read as one run-on passage.
    """
    rubric_block = "\n".join(rubric_lines)
    passage_block = "\n\n".join(
        f"--- SOP PASSAGE {n}{f' ({page})' if page else ''} ---\n{text}"
        for n, (page, text) in enumerate(passages, start=1)
    )
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
        f"{passage_block}\n"
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


@dataclass(frozen=True)
class CoverageTask:
    """One question's audit with the database work already done.

    Same split, and for the same reason, as ``scoring_service.ScoringTask``: SQLAlchemy's
    ``AsyncSession`` is not safe for concurrent use, so every DB read happens sequentially up front
    (:func:`prepare_coverage`) and only the LLM call is dispatched concurrently
    (:func:`audit_prepared`).
    """

    question_id: str
    question_text: str
    prompt: str


async def prepare_coverage(
    db: AsyncSession,
    *,
    question_id: str,
    question_text: str,
    bank_version_id: str | None = None,
) -> CoverageTask | None:
    """Every database read for one question's audit, or None when there is nothing to audit.

    Returns None — meaning *no LLM call will be made for this question* — when there is no
    checklist, no items, no item linking a source document, or no retrievable passage. The caller
    can therefore count the tasks it gets back and know EXACTLY how many model round-trips the
    audit will cost, which is what the candidate's progress line reports.

    Makes no LLM call itself.
    """
    # The interview's pinned rubric version, like scoring (spec-bank-versioning).
    items = await bank_version_service.rubric_rows(
        db, question_id=question_id, bank_version_id=bank_version_id
    )
    if not items:
        return None

    # (document, page) PAIRED per item, deduplicated in rubric order. The pairing is half the fix:
    # the old code took the first linked document and, separately, the first non-empty page label —
    # two `next()` calls over the same items, so the pair could come from DIFFERENT items and point
    # the lookup at a section that item never cited.
    sources: list[tuple[str, str | None]] = []
    for it in items:
        if not it.source_document_id:
            continue
        pair = (it.source_document_id, it.source_page)
        if pair not in sources:
            sources.append(pair)
    if not sources:
        # No original SOP text to compare against (e.g. a hand-authored rubric) — nothing to audit.
        return None

    # EVERY cited document, not just the first — the other half. Measured on the default bank: 7 of
    # the 9 checklists that cite a source cite TWO distinct documents, so for most questions the
    # audit was asking "does the rubric cover this SOP?" while silently ignoring the other one, and
    # a requirement living only in the ignored document could never be reported as uncovered.
    #
    # The total budget is split across them, never below the per-source floor: stop rather than hand
    # the model a sliver too small to support "this requirement is missing from the rubric".
    passages: list[tuple[str | None, str]] = []
    budget = COVERAGE_CONTEXT_CHARS
    remaining = len(sources)
    for document_id, page_label in sources:
        if budget < COVERAGE_MIN_PASSAGE_CHARS:
            logger.info(
                "Question %s cites %d SOP sources; audited the first %d within the passage budget",
                question_id,
                len(sources),
                len(passages),
            )
            break
        share = max(COVERAGE_MIN_PASSAGE_CHARS, budget // remaining)
        remaining -= 1
        text = await sop_context.get_source_context(
            db, document_id=document_id, page_label=page_label, max_chars=share
        )
        if not text:
            continue
        passages.append((page_label, text))
        budget -= len(text)
    if not passages:
        return None

    rubric_lines = [f"({it.kind}) {it.text}" for it in items]
    return CoverageTask(
        question_id=question_id,
        question_text=question_text,
        prompt=_build_coverage_prompt(question_text, rubric_lines, passages),
    )


async def audit_prepared(task: CoverageTask, *, llm_provider: str | None = None) -> list[dict]:
    """Audit one prepared question. Touches no database, so it is safe to run concurrently.

    Bounded by ``scoring_service.complete_with_retry`` (the same 90 s per-call budget the judge
    uses). Until v0.45.0.0 this call had no application-level bound at all, so one slow audit could
    hold the report stream open past the ingress idle timeout and cost the candidate the whole
    report — twice over, because the frontend then silently re-scored from scratch.

    That 90 s was borrowed from the judge until it was measured here. Against live Azure
    (gpt-5-mini, a 3-item checklist citing two SOP documents, ~2.4k chars of passage,
    ``scripts/live_verify_sop_features.py --runs 6``, sequential): **min 8.5 s, median 12.1 s,
    max 17.0 s**. So 90 s is 5.3x the slowest observed call — a healthy audit never trips it, a
    stalled one is cut. Notably FASTER than a judge call (18.4 s median): the audit's output is a
    short list of gaps, not a per-item judgment set with quotes.

    ANY failure degrades to "no findings" rather than propagating: this is a reference-only audit
    that never affects a score, so it must never be the reason a report fails.
    """
    try:
        raw = await scoring_service.complete_with_retry(get_llm_adapter(llm_provider), task.prompt)
    except Exception as exc:  # noqa: BLE001 — advisory audit: degrade, never fail the report
        logger.warning("SOP coverage audit failed for question %s: %s", task.question_id, exc)
        return []
    return _parse_missing(raw)


async def check_question_coverage(
    db: AsyncSession,
    *,
    question_id: str,
    question_text: str,
    llm_provider: str | None = None,
) -> list[dict]:
    """Sequential prepare-then-audit for one question (may be empty).

    The report path does NOT use this — it prepares every question first and then audits them
    concurrently. Kept as the single-question entry point for scripts and tests.
    """
    task = await prepare_coverage(db, question_id=question_id, question_text=question_text)
    if task is None:
        return []
    return await audit_prepared(task, llm_provider=llm_provider)
