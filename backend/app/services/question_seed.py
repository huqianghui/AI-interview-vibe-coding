"""Demo question-bank seed (SPEC F2 AC #1): one enabled default bank + 10 ordered questions.

Idempotent — :func:`seed_default_bank` is a no-op when an enabled default bank already exists, so
it is safe to call on every boot or in a test fixture. The interview state machine resolves
questions from this bank once it's seeded (otherwise it uses the built-in fallback pair).

PUBLIC repo: these are generic, role-agnostic placeholder questions. Real client SOP-derived
questions and their ``expected_points`` are loaded at deploy time, never committed here.
"""

import json

from sqlalchemy.ext.asyncio import AsyncSession

from app.services import question_service

# 10 generic behavioral/procedural questions. `expected_points` are neutral placeholders that F3
# checklist items will later attach to; they are interviewer-internal (never candidate-facing, P3).
DEMO_QUESTIONS: tuple[dict, ...] = (
    {"text": "Please introduce your relevant experience for this role.", "points": []},
    {
        "text": "Describe a situation where you had to follow a strict procedure. What did you do?",
        "points": ["identifies the procedure", "follows each step", "verifies the outcome"],
        "max_follow_ups": 1,
    },
    {"text": "How do you make sure you understand a task before starting it?", "points": []},
    {
        "text": "Tell me about a time you caught a mistake before it caused a problem.",
        "points": ["notices the issue early", "takes corrective action"],
    },
    {"text": "How do you prioritise when several tasks are urgent at once?", "points": []},
    {
        "text": "Describe how you handle a step you are unsure about during a procedure.",
        "points": ["pauses safely", "seeks the right reference or person"],
    },
    {
        "text": "Give an example of following a safety or compliance rule under pressure.",
        "points": [],
    },
    {"text": "How do you record and hand off work so someone else can continue it?", "points": []},
    {
        "text": "Tell me about a time you improved a process you were responsible for.",
        "points": ["identifies the inefficiency", "proposes a concrete change"],
    },
    {
        "text": "Why are you interested in this role, and what do you hope to contribute?",
        "points": [],
    },
)

DEFAULT_BANK_NAME = "Demo interview bank"


async def seed_default_bank(db: AsyncSession, *, language: str = "zh-CN") -> str | None:
    """Create the demo default bank + questions if none is set. Returns the bank id, or None.

    Idempotent: returns None (and writes nothing) when an enabled default bank already exists.
    """
    existing = await question_service.get_default_bank(db)
    if existing is not None:
        return None

    bank = await question_service.create_bank(
        db,
        name=DEFAULT_BANK_NAME,
        description="Seeded generic interview questions for the demo.",
        language=language,
        enabled=True,
        is_default=True,
    )
    for order_index, q in enumerate(DEMO_QUESTIONS):
        await question_service.add_question(
            db,
            bank_id=bank.id,
            text=q["text"],
            order_index=order_index,
            language=language,
            expected_points=json.dumps(q.get("points", []), ensure_ascii=False),
            max_follow_ups=int(q.get("max_follow_ups", 0)),
        )
    return bank.id
