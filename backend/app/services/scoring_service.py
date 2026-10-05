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
import random
import re
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.interview.scoring import score_answer  # stub fallback for un-authored questions
from app.interview.scoring_engine import (
    QuestionResult,
    RubricItem,
    ScoringIncomplete,
    enforce_and_score,
)
from app.services import checklist_service, sop_context
from app.services.agents.adapters.foundry_llm import LLMAdapterError
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

# Transport-level retry for ONE completion: transient failures only (429 / 408 / 409 / 5xx, and the
# no-status connection/timeout family). Three attempts with jittered exponential backoff — 2s, 4s
# plus up to half of each again. A 400-class error is not retried at all: a bad parameter or a
# content-filter rejection fails identically every time, and waiting only spends the candidate's
# time. Jitter matters because a report's concurrent questions hit the same rate limit together.
TRANSPORT_ATTEMPTS = 3
TRANSPORT_BACKOFF_BASE_SECONDS = 2.0

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
    """Cross-language per-item judging prompt; JSON-only output keyed by the item's ORDINAL.

    Items are numbered ``1..N`` in the order given, and the model answers with those numbers;
    :func:`_resolve_item_id` maps them back. They used to be printed as the item's database id — a
    36-character UUID — which made every call ask the model to transcribe up to 17 distinct UUIDs
    exactly (measured on the default bank: 17, 14, 14, 14, 13 items in the five largest checklists).
    One wrong character meant that item counted as UNJUDGED while the mistyped id counted as an
    invented one, and with only two attempts available the question could end up `scoring_failed` —
    reported to the candidate as a question nobody could score. The id is an internal key the model
    never needed to see. Observed signature of the old failure, in pairs:

        Scoring attempt 1 incomplete: 1 item(s) still unjudged
        Dropping 1 invented scoring item(s) not in the checklist

    ``source_context`` (feature C) maps the real ``item_id`` → a fuller SOP passage for that item.
    When present it is appended after the item's short quote as supporting reference text. It is
    reference-only — the judge still decides per item against the checklist ``text``; the rubric,
    weighting, and rails are unchanged.
    """
    source_context = source_context or {}
    lines = []
    for ordinal, it in enumerate(rubric, start=1):
        line = f"[{ordinal}] ({it.kind}) {it.text}"
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
        "item_id is the NUMBER in square brackets for that checklist item (1, 2, 3, ...) — return "
        "it exactly, and do not invent numbers that are not listed.\n"
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


# What a model actually returns for the item printed as "[3]". MEASURED, not guessed, and the reason
# this is deliberately permissive rather than one canonical spelling: against the SAME gpt-5-mini
# deployment with the SAME prompt, two live calls answered differently —
#
#   call 1:  "item_id": "[1]"     (the token copied verbatim from the prompt, brackets included)
#   call 2:  "item_id": 1         (a bare JSON number)
#
# A bare-digits pattern therefore matched NOTHING on the first shape and every judgment was dropped.
# The live run that caught it failed 3 of 3 items on both attempts:
#
#   Dropping 3 scoring judgment(s) whose item_id matched no listed item
#   ScoringIncomplete: LLM did not judge 3 checklist item(s) after 2 attempt(s)
#
# The unit tests could not catch it: the mock adapter's own regex (`^\[([^\]]+)\]`) captures the
# bracket CONTENTS, so the mock always answers with bare digits — the one form the real model does
# not use. Hence this accepts any plausible wrapping rather than one canonical spelling.
_ORDINAL_RE = re.compile(r"^[\[\(#\s]*(\d+)[\]\)\.\s]*$")


def _resolve_item_id(raw_id: object, asked: list[RubricItem]) -> str | None:
    """Map what the model returned for ``item_id`` back to a real checklist item id, or None.

    ``asked`` must be the SAME list, in the same order, that built the prompt — a retry re-asks only
    the still-pending items, so it renumbers from 1 and the mapping differs per attempt.

    Returns None for anything unresolvable (a number out of range, an id that is not in this
    checklist), which the caller drops and counts. Dropping is the same outcome as the old
    "invented item" rail; what changed is how rarely it should now happen.

    An ordinal wins over an id match, which is unambiguous in practice because real ids are UUIDs
    and can never be a bare integer. The id branch exists only so that a model which echoes the real
    id anyway — it is still in ``source_context`` keys, never in the prompt text — is not discarded.
    """
    key = str(raw_id).strip()
    if not key:
        return None
    ordinal = _ORDINAL_RE.match(key)
    if ordinal:
        n = int(ordinal.group(1))
        return asked[n - 1].item_id if 1 <= n <= len(asked) else None
    return key if any(it.item_id == key for it in asked) else None


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
    task = await prepare_scoring(
        db,
        question_id=question_id,
        question_text=question_text,
        answer_text=answer_text,
        include_source_context=include_source_context,
    )
    if task is None:
        return None
    return await judge_prepared(task, llm_provider=llm_provider)


@dataclass(frozen=True)
class ScoringTask:
    """Everything needed to grade one answer, with the database work already done.

    The split exists so questions can be graded CONCURRENTLY. SQLAlchemy's ``AsyncSession`` is not
    safe for concurrent use — two coroutines awaiting the same session corrupt it — so the DB reads
    (checklist, items, SOP passages) all happen sequentially up front, and only the LLM call, which
    touches no session, runs in parallel.
    """

    question_id: str
    question_text: str
    answer_text: str
    rubric: list[RubricItem]
    source_context: dict[str, str]


async def prepare_scoring(
    db: AsyncSession,
    *,
    question_id: str,
    question_text: str,
    answer_text: str,
    include_source_context: bool = True,
) -> ScoringTask | None:
    """Read everything one question's grading needs. Returns None when no checklist is authored.

    All of the DB work, none of the LLM work. Cheap and local: three queries against SQLite.
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

    return ScoringTask(
        question_id=question_id,
        question_text=question_text,
        answer_text=answer_text,
        rubric=rubric,
        source_context=source_context,
    )


async def complete_with_retry(llm, prompt: str) -> str:
    """One bounded completion, retried with exponential backoff on transient failures only.

    Public because the opt-in SOP coverage audit (``app.services.sop_coverage``) needs the exact
    same guarantee and used to have none: it called ``complete()`` raw, so its only bound was the
    OpenAI SDK default (measured: read=600 s, max_retries=2) — long past the ingress idle timeout
    that turns a slow report into a dead stream.

    There was no transport retry anywhere on this path: ``get_openai_client()`` is built with no
    ``max_retries``, so a single 429 or 502 failed the question outright. Backoff is jittered so a
    report's concurrent questions, which all hit the same rate limit at the same moment, do not
    retry in lockstep and collide again.

    A non-retryable failure (a 400-class error: bad parameter, content filter) is raised at once —
    waiting changes nothing about a request that is malformed.

    A TIMEOUT is not retried here either, deliberately. Retryable transport errors come back in
    milliseconds, so trying three of them costs almost nothing; a timeout has already spent the full
    90 s budget, and retrying it twice more would put the worst case at 2 x 3 x 90 s = 9 minutes per
    question — strictly worse than the unbounded stall this timeout exists to prevent. A timeout
    propagates to the item-level loop, which still gives it one more try.
    """
    # Seeded rather than declared, so the final `raise last` is provably bound even if someone sets
    # TRANSPORT_ATTEMPTS to 0 and the loop body never runs.
    last: Exception = RuntimeError("no scoring attempt was made")
    for attempt in range(max(TRANSPORT_ATTEMPTS, 1)):
        try:
            return await asyncio.wait_for(
                llm.complete(prompt, json_mode=True), timeout=SCORING_CALL_TIMEOUT_SECONDS
            )
        except TimeoutError:  # asyncio.TimeoutError is this builtin on 3.11+
            raise  # see the docstring: the 90 s budget is already spent, do not spend it again
        except Exception as exc:  # noqa: BLE001 — classify, then decide
            if not getattr(exc, "retryable", False):
                raise
            last = exc
        if attempt < TRANSPORT_ATTEMPTS - 1:
            delay = TRANSPORT_BACKOFF_BASE_SECONDS * (2**attempt)
            delay += random.uniform(0, delay / 2)  # noqa: S311 — jitter, not cryptography
            logger.warning(
                "Transient LLM failure (%s), retrying in %.1fs (attempt %d/%d)",
                type(last).__name__,
                delay,
                attempt + 1,
                TRANSPORT_ATTEMPTS,
            )
            await asyncio.sleep(delay)
    raise last


async def judge_prepared(task: ScoringTask, *, llm_provider: str | None = None) -> QuestionResult:
    """Grade one prepared question. Touches no database, so it is safe to run concurrently."""
    question_id = task.question_id
    question_text = task.question_text
    answer_text = task.answer_text
    rubric = task.rubric
    source_context = task.source_context

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
        # Bound to its own name: `pending` is reassigned below, and the ordinals in the prompt only
        # mean anything against the exact list that produced them.
        asked = pending
        prompt = _build_scoring_prompt(question_text, answer_text, asked, source_context)
        if attempt:
            # Say the numbers RESTART. The ordinal scheme introduced a failure mode the UUID scheme
            # could not have: this retry lists only the still-pending items, so they are numbered
            # from 1 again, and a model that answered with the ORIGINAL numbering would resolve to
            # nothing (out of range) and leave the item unjudged a second time. The ids are the ones
            # in front of it, not the ones from the earlier call.
            prompt += (
                f"\n\nIMPORTANT: a previous response omitted these {len(pending)} item(s). "
                "Judge every one of them. They are RENUMBERED from [1] in the list above — use "
                "those numbers, not any numbering from an earlier response."
            )
        try:
            raw = await complete_with_retry(llm, prompt)
        except LLMAdapterError as exc:
            if not exc.retryable:
                # A 400-class failure: bad parameter, unsupported model, content filter. It will
                # fail identically on attempt two, so the item-level retry has nothing to add —
                # going round again just spends the candidate's time. Surface it and let the caller
                # isolate this one question.
                raise
            last_error = exc
            logger.warning(
                "Scoring attempt %d failed (%s, status=%s), %d item(s) pending",
                attempt + 1,
                type(exc).__name__,
                exc.status_code,
                len(pending),
            )
            continue
        except Exception as exc:  # noqa: BLE001 — bounded + already retried inside
            # A stalled call (the 90 s timeout fired) or a non-adapter failure. The pending set is
            # unchanged, so the next item-level attempt re-asks the same items; the caller isolates
            # the question if this keeps happening.
            last_error = exc
            logger.warning(
                "Scoring attempt %d failed (%s), %d item(s) pending",
                attempt + 1,
                type(exc).__name__,
                len(pending),
            )
            continue

        unresolved = 0
        for j in _parse_judgments(raw):
            if not isinstance(j, dict):
                continue
            real_id = _resolve_item_id(j.get("item_id"), asked)
            if real_id is None:
                unresolved += 1
                continue
            if real_id not in merged:
                # Store the REAL id: the pure engine matches judgments to the rubric by item_id, and
                # knows nothing about the ordinals that exist only inside the prompt.
                merged[real_id] = {**j, "item_id": real_id}
        if unresolved:
            # The diagnostic that replaces "Dropping N invented scoring item(s)": the model answered
            # with something that is not one of the numbers it was given.
            logger.warning(
                "Dropping %d scoring judgment(s) whose item_id matched no listed item", unresolved
            )

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


def stub_result_dict(question_id: str, answer_text: str, prompt: str = "") -> dict:
    """The F4-stub per-question row, used for questions that have no checklist authored yet.

    ``prompt`` is the question's own text, so a stub row labels itself the same way a graded one
    does — the report should not be able to name some of its questions and not others.
    """
    stub = score_answer(question_id, answer_text)
    return {
        "question_id": question_id,
        "prompt": prompt,
        "judgment": stub.judgment,
        "rationale": stub.rationale,
        "is_stub": True,
    }
