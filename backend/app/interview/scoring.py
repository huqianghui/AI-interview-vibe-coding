"""Stub scoring for the Step 0 thin slice.

Real scoring (SPEC F4) grades each answer against SOP-derived rubric items into a 4-state
judgment and produces SOP-traceable citations. Step 0 has no rubric or knowledge base yet, so
this is a deterministic placeholder that proves the report plumbing (answer group → per-question
result → aggregate report) without any Azure or SOP content.

The 4-state vocabulary is fixed here so F4 swaps the *logic*, not the DTO shape:
    met | partially_met | not_met | violated
"""

from dataclasses import asdict, dataclass

JUDGMENTS = ("met", "partially_met", "not_met", "violated")

# Answers shorter than this are treated as too-short (never scores high — F4 rail #3).
_MIN_MEANINGFUL_LEN = 15


@dataclass(frozen=True)
class QuestionScore:
    question_id: str
    judgment: str
    rationale: str


@dataclass(frozen=True)
class InterviewScore:
    per_question: list[dict]
    coverage_pct: float
    is_stub: bool = True


def group_answers(turns: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Group candidate turns into one answer per question (F6 AC #4).

    An **Answer** is the group of a question's candidate turns — the main answer plus any
    follow-up answers — so a question with a follow-up is scored once, not twice. ``turns`` is a
    list of ``(question_id, content)`` in turn order; the return preserves first-seen question
    order with each question's contents joined by a blank line.
    """
    grouped: dict[str, list[str]] = {}
    for question_id, content in turns:
        grouped.setdefault(question_id, [])
        if content:
            grouped[question_id].append(content)
    return [(qid, "\n\n".join(parts)) for qid, parts in grouped.items()]


def score_answer(question_id: str, answer_text: str) -> QuestionScore:
    """Deterministic placeholder judgment based only on answer length.

    Empty / too-short answers cannot score high (mirrors F4's empty-answer rail); anything
    substantive is optimistically ``met``. No SOP content is consulted — this is a stub.
    """
    text = (answer_text or "").strip()
    if not text:
        return QuestionScore(question_id, "not_met", "No answer was provided.")
    if len(text) < _MIN_MEANINGFUL_LEN:
        return QuestionScore(question_id, "partially_met", "Answer was very brief (stub scoring).")
    return QuestionScore(question_id, "met", "Answer received (stub scoring; not SOP-graded).")


def score_interview(answers: list[tuple[str, str]]) -> InterviewScore:
    """Aggregate per-question stub scores into an interview-level result.

    ``answers`` is a list of (question_id, answer_text). Coverage % = (met + 0.5*partial) / total,
    matching the F4 coverage definition so F8's report aggregation is unaffected by the swap.
    """
    per_question = [asdict(score_answer(qid, text)) for qid, text in answers]
    total = len(per_question) or 1
    weighted = sum(
        1.0 if q["judgment"] == "met" else 0.5 if q["judgment"] == "partially_met" else 0.0
        for q in per_question
    )
    coverage_pct = round(weighted / total * 100, 1)
    return InterviewScore(per_question=per_question, coverage_pct=coverage_pct)
