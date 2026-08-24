"""Checklist (rubric) lifecycle + AI drafting (SPEC F3).

``draft_checklist`` is the F3 headline: given a question, it retrieves the relevant SOP passages,
asks the LLM to draft ``required`` / ``recommended`` / ``forbidden`` items with source quotes, then
gates the output through the pure ``checklist_draft`` module (valid kinds, weights summing to 100,
source attribution) and persists a ``Checklist`` + ``ChecklistItem`` rows.

Robustness: the LLM output is untrusted. When it doesn't parse into any valid item, the draft falls
back to the question's ``expected_points`` (each becomes a required item) so the flow is
deterministic and useful with zero Azure — the mock LLM adapter drives CI, a real adapter drives
prod. Weights are always normalized to 100 before persisting.

Admin-only surface (SPEC P3): a checklist is the rubric and is never candidate-facing.
"""

from __future__ import annotations

import json
from collections.abc import Sequence

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.interview.checklist_draft import (
    ChecklistDraft,
    DraftItem,
    fallback_items_from_points,
    gate_source_citations,
    normalize_weights,
    parse_draft_items,
)
from app.interview.questions import parse_points
from app.models.checklist import Checklist, ChecklistItem
from app.models.question import Question
from app.services.agents.registry import get_llm_adapter, get_retrieval_adapter

DRAFT_PROMPT_VERSION = "v1"

# Design B invariant: every question has a NON-EMPTY checklist. When the LLM yields nothing usable
# and the question has no expected_points to derive from either (e.g. a chit-chat question drafted
# with no SOP), we synthesize this one generic required item so scoring is never a length-based
# stub. It is intentionally question-agnostic — the admin can refine it in the editor.
GENERIC_REQUIRED_ITEM_TEXT = "Answer is on-topic, complete, and accurate."


class ChecklistError(Exception):
    """Base class for checklist-service errors."""


class QuestionNotFound(ChecklistError):
    """Raised when the target question id does not exist."""


def _build_draft_prompt(question_text: str, sop_snippets: list[str]) -> str:
    """Assemble the LLM drafting instruction. Kept small + explicit; JSON-only output requested.

    SOP-optional (Design B / P2): the checklist is drafted from the QUESTION itself. When SOP
    passages are retrieved they refine the rubric and supply source quotes; when none are (e.g. a
    chit-chat question, or no SOP corpus is configured at all — the F1 SOP-upload UI does not exist
    yet), the LLM must still produce a sensible rubric from the question text alone. The old wording
    ("grounded in the SOP") made the model return nothing when there was no SOP, which is exactly
    how questions ended up with an empty checklist → stub scoring.
    """
    has_sop = bool(sop_snippets)
    sources = "\n".join(f"- {s}" for s in sop_snippets) or "(no SOP passages retrieved)"
    sop_clause = (
        "Use the SOP passages below to ground and refine the items, and quote the SOP verbatim in "
        "source_quote where an item is supported by a passage."
        if has_sop
        else "No SOP passages were retrieved. Draft a reasonable rubric from the question text "
        "alone; leave source_quote empty."
    )
    return (
        "You are drafting a scoring checklist (rubric) for one interview question.\n"
        f"{sop_clause}\n"
        'Return ONLY a JSON object: {"items": [{"kind", "text", "weight", '
        '"source_quote", "source_page"}]}.\n'
        "kind is one of required|recommended|forbidden. Include at least one required item. "
        "Weights of required+recommended items should sum to about 100.\n\n"
        f"QUESTION:\n{question_text}\n\nSOP PASSAGES:\n{sources}\n"
    )


def _parse_llm_items(raw_output: str) -> list[dict]:
    """Best-effort parse of the LLM's JSON output into a list of raw item dicts (never raises)."""
    try:
        parsed = json.loads(raw_output)
    except (ValueError, TypeError):
        return []
    if isinstance(parsed, dict):
        items = parsed.get("items")
        return items if isinstance(items, list) else []
    return parsed if isinstance(parsed, list) else []


async def draft_checklist(
    db: AsyncSession,
    question_id: str,
    *,
    llm_provider: str | None = None,
    retrieval_provider: str | None = None,
) -> Checklist:
    """Draft + persist a checklist for a question (F3 AC #1). Idempotent per call — always creates
    a new default checklist and demotes prior ones for the same question.

    Retrieves SOP passages for the question text, asks the LLM for items, gates/normalizes them
    (falling back to ``expected_points`` when the LLM yields nothing usable), and writes the rows
    with weights summing to 100.
    """
    question = (
        await db.execute(select(Question).where(Question.id == question_id))
    ).scalar_one_or_none()
    if question is None:
        raise QuestionNotFound(question_id)

    # 1. Retrieve SOP context (citations carry the source quote + page for attribution).
    retrieval = get_retrieval_adapter(retrieval_provider)
    citations = await retrieval.retrieve_citations(question.text, max_citations=3)
    sop_snippets = [str(c.get("title", "")) for c in citations if c.get("title")]
    primary_page = str(citations[0]["page"]) if citations and citations[0].get("page") else None

    # 2. Ask the LLM to draft items (JSON), then gate the untrusted output.
    llm = get_llm_adapter(llm_provider)
    raw_output = await llm.complete(
        _build_draft_prompt(question.text, sop_snippets), json_mode=True
    )
    items = parse_draft_items(_parse_llm_items(raw_output), source_document_id=None)
    # Gate the LLM's (untrusted) SOP citations: a half-attributed quote/page pair is stripped so no
    # partial citation reaches the report (Phase 5). Only the LLM branch — fallback items below get
    # their page from trusted retrieval code, not the model.
    items = gate_source_citations(items)

    # 3. Fallback: if the LLM gave nothing usable, derive required items from expected_points.
    if not items:
        items = fallback_items_from_points(parse_points(question.expected_points))
        # Attach the retrieved SOP page to the derived items so they're still source-hinted.
        for it in items:
            it.source_page = primary_page

    # 4. Final non-empty guarantee (Design B): LLM AND expected_points both empty → synthesize one
    # generic required item so the checklist is never empty (never falls back to stub scoring).
    if not items:
        items = [DraftItem(kind="required", text=GENERIC_REQUIRED_ITEM_TEXT, order_index=0)]

    normalize_weights(items)
    draft = ChecklistDraft(prompt_version=DRAFT_PROMPT_VERSION, items=items)
    return await _persist_draft(db, question_id, draft)


async def _persist_draft(db: AsyncSession, question_id: str, draft: ChecklistDraft) -> Checklist:
    """Persist a draft as the new default checklist for a question; demote prior defaults."""
    for prior in await _default_checklists(db, question_id):
        prior.is_default = False

    checklist = Checklist(
        question_id=question_id, prompt_version=draft.prompt_version, is_default=True
    )
    db.add(checklist)
    await db.flush()  # assign checklist.id before items

    for it in draft.items:
        db.add(
            ChecklistItem(
                checklist_id=checklist.id,
                kind=it.kind,
                text=it.text,
                weight=it.weight,
                advisory=it.advisory,
                source_quote=it.source_quote,
                source_document_id=it.source_document_id,
                source_page=it.source_page,
                order_index=it.order_index,
            )
        )
    await db.commit()
    await db.refresh(checklist)
    return checklist


async def get_default_checklist(db: AsyncSession, question_id: str) -> Checklist | None:
    """The current default checklist for a question, or None if none has been drafted."""
    rows = await _default_checklists(db, question_id)
    return rows[0] if rows else None


async def list_items(db: AsyncSession, checklist_id: str) -> Sequence[ChecklistItem]:
    """A checklist's items in display order."""
    return (
        (
            await db.execute(
                select(ChecklistItem)
                .where(ChecklistItem.checklist_id == checklist_id)
                .order_by(ChecklistItem.order_index)
            )
        )
        .scalars()
        .all()
    )


class ChecklistNotFound(ChecklistError):
    """Raised when a checklist id does not exist."""


async def update_items(db: AsyncSession, checklist_id: str, raw_items: list[dict]) -> Checklist:
    """Replace a checklist's items with an edited set (F3b). Weights are re-normalized to 100.

    Business editing (F3 AC #4): the caller sends the full desired item set (kind/text/weight/
    source_quote/source_page); this validates kinds, drops invalid rows, normalizes weights to sum
    100 (forbidden items → 0), and replaces the checklist's rows atomically. Raises
    :class:`ChecklistNotFound` if the checklist is gone.
    """
    checklist = (
        await db.execute(select(Checklist).where(Checklist.id == checklist_id))
    ).scalar_one_or_none()
    if checklist is None:
        raise ChecklistNotFound(checklist_id)

    items = parse_draft_items(raw_items)
    normalize_weights(items)

    # Replace: delete existing rows, then write the edited set.
    for existing in await list_items(db, checklist_id):
        await db.delete(existing)
    await db.flush()
    for it in items:
        db.add(
            ChecklistItem(
                checklist_id=checklist_id,
                kind=it.kind,
                text=it.text,
                weight=it.weight,
                advisory=it.advisory,
                source_quote=it.source_quote,
                source_document_id=it.source_document_id,
                source_page=it.source_page,
                order_index=it.order_index,
            )
        )
    await db.commit()
    await db.refresh(checklist)
    return checklist


async def default_item_counts(db: AsyncSession, question_ids: Sequence[str]) -> dict[str, int]:
    """Map each question id → number of items in its default checklist (0 if none).

    Feeds the admin editor's per-question rubric status marker ("✓ N items / ⚙ not configured")
    so discoverability doesn't require opening each question. Admin-only (P3): counts, never item
    content, and only ever reached through the admin question-editor API.
    """
    counts = {qid: 0 for qid in question_ids}
    if not question_ids:
        return counts
    rows = (
        await db.execute(
            select(Checklist.question_id, func.count(ChecklistItem.id))
            .join(ChecklistItem, ChecklistItem.checklist_id == Checklist.id)
            .where(
                Checklist.question_id.in_(list(question_ids)),
                Checklist.is_default.is_(True),
            )
            .group_by(Checklist.question_id)
        )
    ).all()
    for qid, n in rows:
        counts[qid] = int(n)
    return counts


async def _default_checklists(db: AsyncSession, question_id: str) -> list[Checklist]:
    return list(
        (
            await db.execute(
                select(Checklist).where(
                    Checklist.question_id == question_id,
                    Checklist.is_default.is_(True),
                )
            )
        )
        .scalars()
        .all()
    )
