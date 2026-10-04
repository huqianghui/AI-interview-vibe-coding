"""LLM-backed answer scoring (SPEC F4) — composes the rubric, the LLM, and the pure engine.

``score_answer_against_checklist`` grades one answer against its question's default checklist:
build a cross-language judging prompt, ask the LLM for a per-item judgment (JSON), parse it, and
run it through :mod:`app.interview.scoring_engine` (the rails + weighting).

Each call is bounded by ``SCORING_CALL_TIMEOUT_SECONDS``, and judgments accumulate across attempts:
a retry re-asks ONLY the items still unjudged rather than the whole checklist. If items are still
missing when the attempts run out it raises rather than inventing a judgment or under-counting
coverage (SPEC P7) — the caller then marks that one question unscored and keeps the rest of the
report, so a single bad question no longer costs the candidate every other answer.

Cross-language (SPEC F4 AC #4): the prompt states that the SOP, the answer, and the report may be
in different languages and instructs the model to compare across them. The mock LLM returns a
deterministic per-item judgment so CI exercises the real parse+rails path with zero Azure.

A question with no checklist yet falls back to the length-based stub judgment (from F4-stub) so an
un-authored question still produces a report row instead of erroring.
"""

from __future__ import annotations

import asyncio
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
from app.services import checklist_service, sop_context
from app.services.agents.registry import get_llm_adapter

logger = logging.getLogger(__name__)

MAX_SCORING_ATTEMPTS = 2

# Wall-clock ceiling for ONE scoring call. Measured against the live default bank (9 questions ×
# 12 checklist items, a ~4.1k-char prompt, gpt-5-mini at default reasoning effort): 13.1 s min,
# 18.4 s median, 24.8 s max over six calls. 90 s is ~3.6× the slowest observed, so a healthy call
# never trips it, while a stalled one is cut instead of hanging forever.
#
# Why this has to exist at all: without it one stalled Azure call made the report stream go silent
# for 270 s, and Azure Container Apps' ingress disconnects a request that stays idle past its
# "idle request timeout" (default 4 minutes) — the candidate got `504 stream timeout` and lost the
# whole report, including the questions that had already been graded. The judge has had this bound
# since #114 (`app/interview/judge.py`, `asyncio.wait_for`); scoring never got it.
#
# NOTE: do NOT reach for the adapter's `fast=True` to speed this up. Measured: `fast` caps output
# tokens, and a 12-item judgment set is then truncated to nothing — 0 of 12 judgments parsed on
# every one of three answer shapes, versus 12 of 12 without it.
SCORING_CALL_TIMEOUT_SECONDS = 90.0

# Feature C — SOP source-context injection. Each rubric item can carry, beyond its one-line
# ``source_quote``, a fuller slice of the original SOP passage it was drawn from so the judge reads
# the item in context rather than from a single quote. Bounded per item AND per question so a long
# SOP can't blow up the prompt.
SOURCE_CONTEXT_PER_ITEM_CHARS = 600
SOURCE_CONTEXT_TOTAL_CHARS = 3000


def _build_scoring_prompt(
    question_text: str,
    answer_text: str,
    rubric: list[RubricItem],
    source_context: dict[str, str] | None = None,
) -> str:
    """Cross-language per-item judging prompt; JSON-only output keyed by item_id.

    ``source_context`` (feature C) maps ``item_id`` → a fuller SOP passage for that item. When
    present it is appended after the item's short quote as supporting reference text. It is
    reference-only — the judge still decides per item against the checklist ``text``; the rubric,
    weighting, and rails are unchanged.
    """
    source_context = source_context or {}
    lines = []
    for it in rubric:
        line = f"[{it.item_id}] ({it.kind}) {it.text}"
        if it.source_quote:
            line += f'  — SOP: "{it.source_quote}"'
        passage = source_context.get(it.item_id)
        if passage:
            line += f"\n    原文依据 / SOP source passage: {passage}"
        lines.append(line)
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


async def _collect_source_context(db: AsyncSession, rubric: list[RubricItem]) -> dict[str, str]:
    """Map item_id → fuller SOP passage for items that link a source document (feature C).

    Bounded twice: each item gets at most ``SOURCE_CONTEXT_PER_ITEM_CHARS``, and once the running
    total reaches ``SOURCE_CONTEXT_TOTAL_CHARS`` no further passages are added (later items simply
    keep their one-line quote). Items with no ``source_document_id`` are skipped.
    """
    out: dict[str, str] = {}
    budget = SOURCE_CONTEXT_TOTAL_CHARS
    for it in rubric:
        if budget <= 0 or not it.source_document_id:
            continue
        passage = await sop_context.get_source_context(
            db,
            document_id=it.source_document_id,
            page_label=it.source_page,
            max_chars=min(SOURCE_CONTEXT_PER_ITEM_CHARS, budget),
        )
        if passage:
            out[it.item_id] = passage
            budget -= len(passage)
    return out


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
    include_source_context: bool = True,
) -> QuestionResult | None:
    """Score one answer against the question's default checklist, or None if none is authored.

    Returns None when the question has no checklist (caller falls back to the stub). Retries once
    on an incomplete LLM judgment set before surfacing the failure.

    ``include_source_context`` (feature C, default on) attaches each item's fuller SOP passage to
    the prompt as reference. It is a pure prompt enrichment — the pure scoring engine
    (:func:`enforce_and_score`) never sees it, so the weighted score for a given set of judgments is
    identical whether or not it is on. Set False to fall back to the historical quote-only prompt.
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

    # Feature C: reassemble each item's fuller SOP passage (bounded per item and in total). Purely
    # for the prompt; not passed to the scoring engine, so scores stay reproducible.
    source_context: dict[str, str] = {}
    if include_source_context:
        source_context = await _collect_source_context(db, rubric)

    llm = get_llm_adapter(llm_provider)

    # Judgments accumulate ACROSS attempts, keyed by item_id. The previous loop rebuilt the full
    # prompt with a "you omitted items, judge ALL of them" suffix and threw the partial answer away,
    # so a first attempt that judged 11 of 12 items was worth nothing and the retry had the same
    # 12-item job to get right. Now each retry re-asks ONLY the items still missing: a smaller
    # prompt, and the model cannot omit an item that is not in front of it.
    merged: dict[str, dict] = {}
    pending = list(rubric)
    last_error: Exception | None = None

    for attempt in range(MAX_SCORING_ATTEMPTS):
        prompt = _build_scoring_prompt(question_text, answer_text, pending, source_context)
        if attempt:
            prompt += (
                f"\n\nIMPORTANT: a previous response omitted these {len(pending)} item(s). "
                "Judge every one of them."
            )
        try:
            raw = await asyncio.wait_for(
                llm.complete(prompt, json_mode=True), timeout=SCORING_CALL_TIMEOUT_SECONDS
            )
        except TimeoutError as exc:  # asyncio.TimeoutError is this builtin on 3.11+
            # A stalled call, cut. Retry once from the top: the pending set is unchanged, and a
            # fresh call usually returns. The caller isolates the question if this keeps happening.
            last_error = exc
            logger.warning(
                "Scoring attempt %d timed out after %.0fs (%d item(s) pending)",
                attempt + 1,
                SCORING_CALL_TIMEOUT_SECONDS,
                len(pending),
            )
            continue

        for j in _parse_judgments(raw):
            if isinstance(j, dict) and j.get("item_id") not in merged:
                merged[j["item_id"]] = j

        pending = [it for it in rubric if it.item_id not in merged]
        if not pending:
            # Rail #3 still applies inside enforce_and_score: judgments for items that are not in
            # the checklist are dropped there, so a mis-echoed id cannot sneak in as a real one.
            return enforce_and_score(question_id, answer_text, rubric, list(merged.values()))

        last_error = ScoringIncomplete(
            f"LLM did not judge {len(pending)} checklist item(s) after {attempt + 1} attempt(s)"
        )
        logger.warning(
            "Scoring attempt %d incomplete: %d item(s) still unjudged", attempt + 1, len(pending)
        )

    # Exhausted retries. Surface it rather than inventing a judgment or under-counting coverage
    # (P7) — the caller marks THIS question unscored and keeps the rest of the report.
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
