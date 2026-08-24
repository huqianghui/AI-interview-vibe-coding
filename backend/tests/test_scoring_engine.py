"""Scoring engine rails + weighting (SPEC F4) — pure, no LLM/DB."""

import pytest

from app.interview.scoring_engine import (
    DOES_NOT_MEET,
    MEETS_EXPECTATIONS,
    NEEDS_IMPROVEMENT,
    RubricItem,
    ScoringIncomplete,
    build_narrative,
    cap_outcome,
    enforce_and_score,
    grade_for_score,
    outcome_for_score,
)

_LONG = "This is a sufficiently detailed answer that clears the length rail comfortably."


def _rubric():
    return [
        RubricItem(item_id="i1", kind="required", text="does X", weight=60, source_quote="SOP X"),
        RubricItem(item_id="i2", kind="recommended", text="does Y", weight=40),
        RubricItem(item_id="i3", kind="forbidden", text="does Z", weight=0, source_quote="never Z"),
    ]


def test_all_four_states_carry_rationale_and_quotes():
    rubric = _rubric()
    judgments = [
        {"item_id": "i1", "judgment": "met", "rationale": "clear", "answer_quote": "I did X"},
        {
            "item_id": "i2",
            "judgment": "partially_met",
            "rationale": "partly",
            "answer_quote": "Y-ish",
        },
        {"item_id": "i3", "judgment": "not_met", "rationale": "clean", "answer_quote": ""},
    ]
    result = enforce_and_score("q1", _LONG, rubric, judgments)
    by_id = {it.item_id: it for it in result.items}
    assert by_id["i1"].judgment == "met"
    assert by_id["i1"].source_quote == "SOP X"  # AC #1: SOP source quote carried
    assert by_id["i1"].answer_quote == "I did X"  # AC #1: answer quote carried
    assert by_id["i2"].judgment == "partially_met"
    # score = (60*1.0 + 40*0.5)/100 * 100 = 80
    assert result.score == 80.0


def test_forbidden_trigger_forces_violated_and_warns():
    # AC #2: a forbidden item the answer triggers becomes violated + a warning, regardless of text.
    rubric = _rubric()
    judgments = [
        {"item_id": "i1", "judgment": "met", "rationale": "", "answer_quote": ""},
        {"item_id": "i2", "judgment": "met", "rationale": "", "answer_quote": ""},
        {"item_id": "i3", "judgment": "met", "rationale": "said Z", "answer_quote": "I did Z"},
    ]
    result = enforce_and_score("q1", _LONG, rubric, judgments)
    forbidden = next(it for it in result.items if it.item_id == "i3")
    assert forbidden.judgment == "violated"
    assert any("Forbidden item triggered" in w for w in result.warnings)


def test_empty_answer_never_scores_high():
    # AC #3: an empty/too-short answer forces every item to not_met → score 0.
    rubric = _rubric()
    judgments = [
        {"item_id": "i1", "judgment": "met", "rationale": "", "answer_quote": ""},
        {"item_id": "i2", "judgment": "met", "rationale": "", "answer_quote": ""},
        {"item_id": "i3", "judgment": "not_met", "rationale": "", "answer_quote": ""},
    ]
    result = enforce_and_score("q1", "  ", rubric, judgments)
    assert result.score == 0.0
    assert all(it.judgment == "not_met" for it in result.items if it.kind != "forbidden")


def test_missing_item_raises_incomplete():
    # Rail #4: the LLM must judge every item; a gap raises so the caller retries (P7).
    rubric = _rubric()
    judgments = [{"item_id": "i1", "judgment": "met"}]  # i2, i3 missing
    with pytest.raises(ScoringIncomplete):
        enforce_and_score("q1", _LONG, rubric, judgments)


def test_invented_item_dropped():
    # Rail #3: a judgment for an item not in the checklist is ignored (not scored).
    rubric = _rubric()
    judgments = [
        {"item_id": "i1", "judgment": "met"},
        {"item_id": "i2", "judgment": "met"},
        {"item_id": "i3", "judgment": "not_met"},
        {"item_id": "ghost", "judgment": "met"},  # invented
    ]
    result = enforce_and_score("q1", _LONG, rubric, judgments)
    assert {it.item_id for it in result.items} == {"i1", "i2", "i3"}


def test_unknown_judgment_defaults_not_met():
    rubric = [RubricItem(item_id="i1", kind="required", text="x", weight=100)]
    result = enforce_and_score("q1", _LONG, rubric, [{"item_id": "i1", "judgment": "banana"}])
    assert result.items[0].judgment == "not_met"


def test_score_reproducible():
    # AC #5: same inputs → same weighted score (pure function).
    rubric = _rubric()
    judgments = [
        {"item_id": "i1", "judgment": "met"},
        {"item_id": "i2", "judgment": "not_met"},
        {"item_id": "i3", "judgment": "not_met"},
    ]
    a = enforce_and_score("q1", _LONG, rubric, judgments)
    b = enforce_and_score("q1", _LONG, rubric, judgments)
    assert a.score == b.score == 60.0  # 60*1.0 + 40*0.0 = 60


def test_grade_bands():
    assert grade_for_score(90) == "A"
    assert grade_for_score(72) == "B"
    assert grade_for_score(60) == "C"
    assert grade_for_score(45) == "D"
    assert grade_for_score(10) == "F"


def test_build_narrative_strengths_and_gap():
    # F8: narrative reads the same judgments the detail view shows — strengths + a main gap.
    rubric = _rubric()
    judgments = [
        {"item_id": "i1", "judgment": "met", "rationale": "did the procedure"},
        {"item_id": "i2", "judgment": "not_met"},
        {"item_id": "i3", "judgment": "not_met"},
    ]
    result = enforce_and_score("q1", _LONG, rubric, judgments)
    text = build_narrative([result])
    assert "Demonstrated" in text
    assert "did the procedure" in text


def test_build_narrative_flags_violation():
    rubric = _rubric()
    judgments = [
        {"item_id": "i1", "judgment": "met"},
        {"item_id": "i2", "judgment": "met"},
        {"item_id": "i3", "judgment": "met", "rationale": "bypassed safety"},  # forbidden→violated
    ]
    result = enforce_and_score("q1", _LONG, rubric, judgments)
    text = build_narrative([result])
    assert "forbidden" in text.lower()


def test_build_narrative_empty_when_nothing_graded():
    assert build_narrative([]) == ""


# --- classification rating (outcome) + critical-error cap ------------------------------------


def test_outcome_for_score_bands():
    # Thresholds align to the B=70 / D=40 letter boundaries.
    assert outcome_for_score(100) == MEETS_EXPECTATIONS
    assert outcome_for_score(70) == MEETS_EXPECTATIONS  # boundary is inclusive
    assert outcome_for_score(69.9) == NEEDS_IMPROVEMENT
    assert outcome_for_score(40) == NEEDS_IMPROVEMENT  # boundary is inclusive
    assert outcome_for_score(39.9) == DOES_NOT_MEET
    assert outcome_for_score(0) == DOES_NOT_MEET


def test_cap_outcome_moves_meets_to_needs_when_critical_fires():
    outcome, capped = cap_outcome(MEETS_EXPECTATIONS, critical_fired=True)
    assert outcome == NEEDS_IMPROVEMENT
    assert capped is True


def test_cap_outcome_no_cap_when_no_critical():
    outcome, capped = cap_outcome(MEETS_EXPECTATIONS, critical_fired=False)
    assert outcome == MEETS_EXPECTATIONS
    assert capped is False


def test_cap_outcome_preserves_more_severe_does_not_meet():
    # A cap never *improves* an already-worse outcome, and doesn't flag itself as the cause.
    outcome, capped = cap_outcome(DOES_NOT_MEET, critical_fired=True)
    assert outcome == DOES_NOT_MEET
    assert capped is False


def test_high_score_capped_to_needs_improvement_on_critical_error():
    # A near-perfect numeric answer that trips a (non-advisory) forbidden item is capped.
    rubric = _rubric()
    judgments = [
        {"item_id": "i1", "judgment": "met"},
        {"item_id": "i2", "judgment": "met"},
        {"item_id": "i3", "judgment": "met", "rationale": "invented a timeline"},  # → violated
    ]
    result = enforce_and_score("q1", _LONG, rubric, judgments)
    assert result.score == 100.0  # weighted score ignores the weight-0 forbidden
    assert result.outcome == NEEDS_IMPROVEMENT
    assert result.capped is True


def test_advisory_forbidden_discloses_but_does_not_cap():
    # Known-conflict disclosure: an advisory forbidden fires "violated" + a disclosure
    # warning, but the outcome follows the score (no cap).
    rubric = [
        RubricItem(item_id="i1", kind="required", text="does X", weight=100, source_quote="SOP X"),
        RubricItem(
            item_id="c1",
            kind="forbidden",
            text="PD review timeline conflict",
            weight=0,
            advisory=True,
        ),
    ]
    judgments = [
        {"item_id": "i1", "judgment": "met"},
        {"item_id": "c1", "judgment": "violated", "rationale": "cited 30 days"},
    ]
    result = enforce_and_score("q1", _LONG, rubric, judgments)
    assert result.score == 100.0
    assert result.outcome == MEETS_EXPECTATIONS  # NOT capped
    assert result.capped is False
    advisory_item = next(it for it in result.items if it.item_id == "c1")
    assert advisory_item.judgment == "violated"
    assert advisory_item.advisory is True
    assert any("Advisory item disclosed" in w for w in result.warnings)
    assert not any("Forbidden item triggered" in w for w in result.warnings)


def test_low_score_without_critical_is_does_not_meet():
    rubric = _rubric()
    judgments = [
        {"item_id": "i1", "judgment": "not_met"},
        {"item_id": "i2", "judgment": "not_met"},
        {"item_id": "i3", "judgment": "not_met"},
    ]
    result = enforce_and_score("q1", _LONG, rubric, judgments)
    assert result.score == 0.0
    assert result.outcome == DOES_NOT_MEET
    assert result.capped is False  # low score is natural, not a cap
