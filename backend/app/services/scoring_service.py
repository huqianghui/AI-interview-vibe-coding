"""LLM-backed answer scoring (SPEC F4) — composes the rubric, the LLM, and the pure engine.

``score_answer_against_checklist`` grades one answer against its question's default checklist:
build a cross-language judging prompt, ask the LLM for a per-item judgment (JSON), parse it, and
run it through :mod:`app.interview.scoring_engine` (the rails + weighting). On a
:class:`ScoringIncomplete` (the LLM skipped an item) it retries once with a stricter reminder
before giving up — never silently under-counts (SPEC P7).

Cross-language (SPEC F4 AC #4): the prompt states that the SOP, the answer, and the report may be
in different languages and instructs the model to compare across them. The mock LLM returns a
deterministic per-item judgment so CI exercises the real parse+rails path with zero Azure.

A question with no checklist yet falls back to the length-based stub judgment (from F4-stub) so an
un-authored question still produces a report row instead of erroring.
"""

from __future__ import annotations

import json
import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.interview.scoring import score_answer  # stub fallback for un-authored questions
from app.interview.scoring_engine import (
    QuestionResult,
    RubricItem,
    ScoringIncomplete,
    enforce_and_score,
)
from app.services import checklist_service
from app.services.agents.registry import get_llm_adapter

logger = logging.getLogger(__name__)

MAX_SCORING_ATTEMPTS = 2


def _build_scoring_prompt(question_text: str, answer_text: str, rubric: list[RubricItem]) -> str:
    """Cross-language per-item judging prompt; JSON-only output keyed by item_id."""
    lines = [
        f"[{it.item_id}] ({it.kind}) {it.text}"
        + (f'  — SOP: "{it.source_quote}"' if it.source_quote else "")
        for it in rubric
    ]
    rubric_block = "\n".join(lines)
    return (
        "You are scoring one interview answer against a fixed checklist derived from an SOP.\n"
        "The SOP, the answer, and your rationale may be in different languages — compare across "
        "languages by meaning, not by matching words.\n"
        "For EVERY checklist item return a judgment: met | partially_met | not_met | violated "
        "(violated only for a forbidden item the answer actually triggers).\n"
        'Return ONLY JSON: {"judgments": [{"item_id", "judgment", "rationale", "answer_quote"}]}. '
        "answer_quote is a short verbatim span from the candidate's answer for the judgment.\n"
        "Judge every item — do not omit any.\n\n"
        f"QUESTION:\n{question_text}\n\nCHECKLIST:\n{rubric_block}\n\nANSWER:\n{answer_text}\n"
    )


def _parse_judgments(raw_output: str) -> list[dict]:
    try:
        parsed = json.loads(raw_output)
    except (ValueError, TypeError):
        return []
    if isinstance(parsed, dict):
        judgments = parsed.get("judgments")
        return judgments if isinstance(judgments, list) else []
    return parsed if isinstance(parsed, list) else []


async def score_answer_against_checklist(
    db: AsyncSession,
    *,
    question_id: str,
    question_text: str,
    answer_text: str,
    llm_provider: str | None = None,
) -> QuestionResult | None:
    """Score one answer against the question's default checklist, or None if none is authored.

    Returns None when the question has no checklist (caller falls back to the stub). Retries once
    on an incomplete LLM judgment set before surfacing the failure.
    """
    checklist = await checklist_service.get_default_checklist(db, question_id)
    if checklist is None:
        return None
    item_rows = await checklist_service.list_items(db, checklist.id)
    if not item_rows:
        return None

    rubric = [
        RubricItem(
            item_id=row.id,
            kind=row.kind,
            text=row.text,
            weight=row.weight,
            source_quote=row.source_quote,
            source_page=row.source_page,
            source_document_id=row.source_document_id,
            advisory=row.advisory,
        )
        for row in item_rows
    ]

    llm = get_llm_adapter(llm_provider)
    prompt = _build_scoring_prompt(question_text, answer_text, rubric)
    last_error: ScoringIncomplete | None = None
    for attempt in range(MAX_SCORING_ATTEMPTS):
        raw = await llm.complete(prompt, json_mode=True)
        try:
            return enforce_and_score(question_id, answer_text, rubric, _parse_judgments(raw))
        except ScoringIncomplete as exc:
            last_error = exc
            logger.warning("Scoring attempt %d incomplete: %s", attempt + 1, exc)
            prompt = prompt + "\n\nIMPORTANT: your last response omitted items. Judge ALL of them."
    # Exhausted retries — surface it rather than under-counting coverage (P7).
    raise last_error  # type: ignore[misc]


def stub_result_dict(question_id: str, answer_text: str) -> dict:
    """The F4-stub per-question row, used for questions that have no checklist authored yet."""
    stub = score_answer(question_id, answer_text)
    return {
        "question_id": question_id,
        "judgment": stub.judgment,
        "rationale": stub.rationale,
        "is_stub": True,
    }
