"""Hardcoded interview questions for the Step 0 thin slice.

Step 0 proves the end-to-end spine (ask → answer → placeholder report) with a fixed,
in-code question set — no question_bank table yet (that arrives with F1/F2). Two questions
so the state machine's 1→N advancement is exercised, not just a single turn.

PUBLIC repo: these are generic placeholder questions, never real client SOP content.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Question:
    id: str
    prompt: str
    # F6 follow-up hook: how many follow-up turns this question may generate (demo default 0/1).
    max_follow_ups: int = 0
    # Prompt used for the (single) follow-up turn when max_follow_ups > 0. F7 will make this
    # reference the candidate's prior answer; Step 0 uses a fixed probe.
    follow_up_prompt: str = "Can you walk me through that in a bit more detail?"


QUESTIONS: tuple[Question, ...] = (
    Question(
        id="q1",
        prompt="Please introduce your relevant experience for this role.",
    ),
    Question(
        id="q2",
        prompt="Describe a situation where you had to follow a strict procedure. What did you do?",
        # One follow-up so the state machine's follow-up hook is exercised end-to-end (F6 AC #4).
        max_follow_ups=1,
    ),
)

QUESTION_COUNT = len(QUESTIONS)


def get_question(index: int) -> Question | None:
    """Return the question at ``index`` (0-based), or None if past the end."""
    if 0 <= index < QUESTION_COUNT:
        return QUESTIONS[index]
    return None
