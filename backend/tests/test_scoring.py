"""Stub scoring unit tests.

Pins the 4-state vocabulary and the empty/too-short rails so F4 can swap the logic without
breaking F8's report shape.
"""

from app.interview.scoring import JUDGMENTS, group_answers, score_answer, score_interview


def test_empty_answer_is_not_met():
    assert score_answer("q1", "").judgment == "not_met"
    assert score_answer("q1", "   ").judgment == "not_met"


def test_short_answer_is_partial():
    assert score_answer("q1", "yes").judgment == "partially_met"


def test_substantive_answer_is_met():
    score = score_answer("q1", "I have five years of relevant hands-on experience.")
    assert score.judgment == "met"


def test_all_judgments_are_in_vocabulary():
    for text in ("", "yes", "a substantive and sufficiently long answer here"):
        assert score_answer("q1", text).judgment in JUDGMENTS


def test_interview_coverage_aggregation():
    result = score_interview(
        [
            ("q1", "a substantive and sufficiently long answer here"),  # met -> 1.0
            ("q2", ""),  # not_met -> 0.0
        ]
    )
    assert result.coverage_pct == 50.0
    assert len(result.per_question) == 2
    assert result.is_stub is True


def test_interview_coverage_empty_is_safe():
    result = score_interview([])
    assert result.coverage_pct == 0.0


# --- answer grouping (F6 AC #4) --------------------------------------------


def test_group_answers_joins_follow_ups_into_one_answer():
    grouped = group_answers(
        [
            ("q1", "main answer to q1"),
            ("q2", "main answer to q2"),
            ("q2", "follow-up elaboration for q2"),
        ]
    )
    # Two questions, in first-seen order; q2's two turns joined into one answer.
    assert [qid for qid, _ in grouped] == ["q1", "q2"]
    q2_answer = dict(grouped)["q2"]
    assert "main answer to q2" in q2_answer
    assert "follow-up elaboration for q2" in q2_answer


def test_group_answers_skips_empty_content():
    grouped = group_answers([("q1", ""), ("q1", "the real answer")])
    assert grouped == [("q1", "the real answer")]


def test_group_answers_empty_input():
    assert group_answers([]) == []
