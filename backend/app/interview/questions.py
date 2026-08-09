"""Interview question source (SPEC F2, replacing the Step-0 hardcoded set).

The state machine (F6) asks questions in order from the **enabled default question bank**. This
module owns the resolution: :func:`resolve_questions` reads the default bank's enabled questions
(``order_index`` order) and maps each ORM row to the lightweight :class:`Question` the state
machine consumes — so F6's progression logic (which reads ``id`` / ``prompt`` / ``max_follow_ups``
/ ``follow_up_prompt``) is unchanged.

**Fallback:** when no default bank is seeded (fresh DB, Step-0 flows, older tests), resolution
returns the built-in ``FALLBACK_QUESTIONS`` so the interview spine keeps working with zero F2 data.
The seed (:mod:`app.services.question_seed`) installs the demo bank so real runs use the DB.

PUBLIC repo: fallback questions are generic placeholders, never real client SOP content.
"""

import json
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession


@dataclass(frozen=True)
class Question:
    id: str
    prompt: str
    # F6 follow-up hook: how many follow-up turns this question may generate.
    max_follow_ups: int = 0
    follow_up_prompt: str = "Can you walk me through that in a bit more detail?"
    # Expected answer points (F3 checklist links here). NEVER candidate-facing (P3) — the read API
    # projects it out; it rides here only so scoring can reach it later without a second query.
    expected_points: tuple[str, ...] = ()


# Built-in fallback used only when no default bank is seeded — keeps the F6 spine runnable.
FALLBACK_QUESTIONS: tuple[Question, ...] = (
    Question(id="q1", prompt="Please introduce your relevant experience for this role."),
    Question(
        id="q2",
        prompt="Describe a situation where you had to follow a strict procedure. What did you do?",
        max_follow_ups=1,
    ),
)


def _parse_points(raw: str | None) -> tuple[str, ...]:
    if not raw:
        return ()
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return ()
    return tuple(str(p) for p in parsed) if isinstance(parsed, list) else ()


async def resolve_questions(db: AsyncSession) -> tuple[Question, ...]:
    """Ordered questions for the current interview: the default bank's, or the fallback set.

    Imported lazily to avoid a models/service import cycle at module load. Returns the fallback
    when no enabled default bank exists or the bank has no enabled questions.
    """
    from app.services import question_service

    bank = await question_service.get_default_bank(db)
    if bank is None:
        return FALLBACK_QUESTIONS
    rows = await question_service.list_questions_for_bank(db, bank.id, enabled_only=True)
    if not rows:
        return FALLBACK_QUESTIONS
    return tuple(
        Question(
            id=row.id,
            prompt=row.text,
            max_follow_ups=row.max_follow_ups,
            follow_up_prompt=row.follow_up_prompt,
            expected_points=_parse_points(row.expected_points),
        )
        for row in rows
    )


def question_at(questions: tuple[Question, ...], index: int) -> Question | None:
    """Return the question at ``index`` (0-based), or None if past the end."""
    return questions[index] if 0 <= index < len(questions) else None
