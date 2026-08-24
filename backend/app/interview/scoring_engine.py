"""SOP-traceable scoring engine (SPEC F4) — the demo's headline.

Grades one answer against its question's checklist (F3 rubric) into a **4-state judgment per item**
plus a weighted question score. The LLM proposes per-item judgments; this module owns the pure gate
that makes the result trustworthy and reproducible:

- **4 states:** ``met | partially_met | not_met | violated`` (violated = a forbidden item fired).
- **Anti-hallucination rails (P7):**
  1. *Empty / too-short answer* can't score high — every item is forced to ``not_met`` (there's no
     substance to have met anything).
  2. *Forbidden item fired* forces that item to ``violated`` + a warning, regardless of what else
     the answer contains.
  3. *Invented item* — a judgment for an item id not in the checklist is dropped + logged (the LLM
     doesn't get to grade against a rubric line that doesn't exist).
  4. *Missing item* — the LLM must judge every checklist item; a missing one raises
     :class:`ScoringIncomplete` so the caller retries rather than silently under-counting coverage.
- **Weighting:** each item's weight (F3 normalizes them to sum 100) contributes its fraction based
  on state (met=1.0, partially_met=0.5, else 0.0). Forbidden items carry weight 0, so a clean
  answer isn't penalized for them, but a fired forbidden surfaces as a warning + a ``violated`` row.

Pure + provider-agnostic: no LLM call, no DB. The state_machine composes this with the LLM adapter
and the checklist rows, so the rails + weighting (what the demo's credibility rests on) are verified
in CI without any Azure.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

JUDGMENTS = ("met", "partially_met", "not_met", "violated")
_STATE_CREDIT = {"met": 1.0, "partially_met": 0.5, "not_met": 0.0, "violated": 0.0}

# Classification rating (from the evaluation contract). The report headline is one of these three
# outcomes rather than a raw letter grade: a confirmed critical error caps the result at
# "Needs Improvement" regardless of the numeric score (see ``cap_outcome``).
MEETS_EXPECTATIONS = "Meets Expectations"
NEEDS_IMPROVEMENT = "Needs Improvement"
DOES_NOT_MEET = "Does Not Meet"
OUTCOMES = (MEETS_EXPECTATIONS, NEEDS_IMPROVEMENT, DOES_NOT_MEET)
# Best (index 0) → worst; used to take the more-severe of the natural and capped outcomes.
_OUTCOME_SEVERITY = {MEETS_EXPECTATIONS: 0, NEEDS_IMPROVEMENT: 1, DOES_NOT_MEET: 2}

# Score → outcome thresholds (0-100). Aligned to the existing B=70 / D=40 letter boundaries so the
# classification never disagrees with the legacy grade at the band edges.
OUTCOME_MEETS_MIN = 70.0
OUTCOME_NEEDS_MIN = 40.0

# An answer shorter than this (after strip) can't meet any rubric item — recalibrated for a SINGLE
# Q&A turn, deliberately NOT the reference's 100-char aggregate-transcript number (SPEC P7).
MIN_MEANINGFUL_LEN = 20


@dataclass(frozen=True)
class RubricItem:
    """The checklist row being judged (subset the engine needs)."""

    item_id: str
    kind: str  # required | recommended | forbidden
    text: str
    weight: int
    source_quote: str = ""
    source_page: str | None = None
    # Advisory forbidden item: fires "violated" + a warning (disclosure) but does NOT cap the
    # outcome. Carries a known, unvalidated source conflict. Ignored for non-forbidden items.
    advisory: bool = False


@dataclass(frozen=True)
class ItemJudgment:
    """One item's graded result — the row the report shows, with both traceability quotes."""

    item_id: str
    kind: str
    judgment: str
    weight: int
    rationale: str
    answer_quote: str
    source_quote: str
    source_page: str | None = None
    # Mirrors RubricItem.advisory: a fired advisory forbidden discloses but doesn't cap the outcome.
    advisory: bool = False


@dataclass(frozen=True)
class QuestionResult:
    question_id: str
    score: float  # weighted 0-100
    coverage_pct: float  # (met + 0.5*partial) / count of weighted items, 0-100
    items: list[ItemJudgment]
    warnings: list[str] = field(default_factory=list)
    # Classification headline for this question. ``capped`` is True when a confirmed
    # (non-advisory) critical error forced the outcome down to "Needs Improvement".
    outcome: str = MEETS_EXPECTATIONS
    capped: bool = False


class ScoringIncomplete(Exception):
    """Raised when the LLM omitted a judgment for a checklist item (caller should retry)."""


def _too_short(answer_text: str) -> bool:
    return len(answer_text.strip()) < MIN_MEANINGFUL_LEN


def enforce_and_score(
    question_id: str,
    answer_text: str,
    rubric: list[RubricItem],
    raw_judgments: list[dict],
) -> QuestionResult:
    """Apply the rails to the LLM's raw per-item judgments and compute the weighted score.

    ``raw_judgments`` is the LLM output: dicts of ``item_id`` / ``judgment`` / ``rationale`` /
    ``answer_quote``. Returns a :class:`QuestionResult`. Raises :class:`ScoringIncomplete` if any
    checklist item has no judgment (rail #4).
    """
    by_id = {j.get("item_id"): j for j in raw_judgments if isinstance(j, dict)}
    rubric_ids = {it.item_id for it in rubric}

    # Rail #3: an LLM judgment for an item not in the checklist is dropped + logged.
    invented = [jid for jid in by_id if jid not in rubric_ids]
    if invented:
        logger.warning("Dropping %d invented scoring item(s) not in the checklist", len(invented))

    short = _too_short(answer_text)
    warnings: list[str] = []
    items: list[ItemJudgment] = []
    for it in rubric:
        raw = by_id.get(it.item_id)
        if raw is None:
            # Rail #4: every rubric item must be judged; a gap would inflate coverage.
            raise ScoringIncomplete(f"LLM did not judge checklist item {it.item_id!r}")

        judgment = str(raw.get("judgment", "")).strip().lower()
        if judgment not in JUDGMENTS:
            judgment = "not_met"

        # Rail #2: a fired forbidden item is always "violated" + a warning, no matter the text. An
        # advisory forbidden item is disclosed distinctly so it never reads as a
        # hard critical error and never caps the outcome below.
        if it.kind == "forbidden" and judgment != "not_met":
            judgment = "violated"
            if it.advisory:
                warnings.append(f"Advisory item disclosed (does not cap): {it.text}")
            else:
                warnings.append(f"Forbidden item triggered: {it.text}")

        # Rail #1: empty/too-short answers can't have met anything — force not_met (but keep a
        # genuinely-violated forbidden as violated: a brief forbidden statement still counts).
        if short and judgment != "violated":
            judgment = "not_met"

        items.append(
            ItemJudgment(
                item_id=it.item_id,
                kind=it.kind,
                judgment=judgment,
                weight=it.weight,
                rationale=str(raw.get("rationale", "")).strip(),
                answer_quote=str(raw.get("answer_quote", "")).strip(),
                source_quote=it.source_quote,
                source_page=it.source_page,
                advisory=it.advisory,
            )
        )

    score, coverage = _weighted_score(items)
    # Classification: natural outcome from the score, then cap to "Needs Improvement" if a
    # confirmed (non-advisory) critical error fired. Advisory disclosures are excluded from the cap.
    natural = outcome_for_score(score)
    critical_fired = any(
        it.kind == "forbidden" and it.judgment == "violated" and not it.advisory for it in items
    )
    outcome, capped = cap_outcome(natural, critical_fired=critical_fired)
    return QuestionResult(
        question_id=question_id,
        score=score,
        coverage_pct=coverage,
        items=items,
        warnings=warnings,
        outcome=outcome,
        capped=capped,
    )


def _weighted_score(items: list[ItemJudgment]) -> tuple[float, float]:
    """Weighted score (by item weight) and coverage (by count) over weighted items, both 0-100."""
    weighted = [it for it in items if it.weight > 0]
    total_weight = sum(it.weight for it in weighted)
    if total_weight <= 0:
        return 0.0, 0.0
    score = sum(it.weight * _STATE_CREDIT[it.judgment] for it in weighted) / total_weight * 100
    coverage = sum(_STATE_CREDIT[it.judgment] for it in weighted) / len(weighted) * 100
    return round(score, 1), round(coverage, 1)


def grade_for_score(score: float) -> str:
    """Map a 0-100 question/interview score to a letter grade for the report headline (F8)."""
    if score >= 85:
        return "A"
    if score >= 70:
        return "B"
    if score >= 55:
        return "C"
    if score >= 40:
        return "D"
    return "F"


def outcome_for_score(score: float) -> str:
    """Map a 0-100 score to the classification rating (the *natural*, pre-cap outcome).

    Thresholds align to the legacy B=70 / D=40 letter boundaries so the classification never
    disagrees with :func:`grade_for_score` at a band edge: ``>=70`` Meets, ``40-69`` Needs
    Improvement, ``<40`` Does Not Meet.
    """
    if score >= OUTCOME_MEETS_MIN:
        return MEETS_EXPECTATIONS
    if score >= OUTCOME_NEEDS_MIN:
        return NEEDS_IMPROVEMENT
    return DOES_NOT_MEET


def cap_outcome(natural: str, *, critical_fired: bool) -> tuple[str, bool]:
    """Apply the critical-error cap to a natural outcome.

    A confirmed critical error (a non-advisory forbidden item fired) caps the result at "Needs
    Improvement": the returned outcome is the **more severe** of the natural outcome and the cap, so
    an already-worse "Does Not Meet" is preserved. ``capped`` is True only when the cap actually
    moved the outcome (natural was "Meets Expectations"). Advisory disclosures never reach here.
    """
    if not critical_fired:
        return natural, False
    if _OUTCOME_SEVERITY[natural] >= _OUTCOME_SEVERITY[NEEDS_IMPROVEMENT]:
        # Already at or below the cap — the critical error changes nothing about the headline.
        return natural, False
    return NEEDS_IMPROVEMENT, True


def build_narrative(results: list[QuestionResult]) -> str:
    """A 1-2 sentence strength/gap summary for the report's executive headline (F8 / P14).

    Deterministic (no LLM): strengths are the ``met`` rubric items, gaps are ``not_met`` /
    ``violated`` ones, drawn from across the graded questions. A demo headline that reads from the
    same judgments the detail view shows, so the two views never disagree. Empty when nothing was
    graded (the caller then shows no narrative rather than a hollow sentence).
    """
    met: list[str] = []
    gaps: list[str] = []
    violations: list[str] = []
    for r in results:
        for it in r.items:
            label = it.rationale or it.item_id
            if it.judgment == "met" and it.kind != "forbidden":
                met.append(label)
            elif it.judgment == "violated":
                violations.append(label)
            elif it.judgment == "not_met" and it.kind == "required":
                gaps.append(label)
    if not (met or gaps or violations):
        return ""

    parts: list[str] = []
    if met:
        parts.append(f"Demonstrated {len(met)} of the expected points, including {met[0]}.")
    else:
        parts.append("Did not clearly demonstrate the expected points.")
    if violations:
        parts.append(f"Triggered a forbidden item: {violations[0]}.")
    elif gaps:
        parts.append(f"Main gap: {gaps[0]}.")
    return " ".join(parts)
