"""Question-bank lifecycle + resolution (SPEC F2).

Owns the read/resolve surface the interview flow needs and the one-enabled-default invariant
(mirrors ``persona_service``): ``set_default_bank`` clears every other enabled default before
setting the new one, flushing between so the partial-unique index never sees two defaults, and
translates a racing ``IntegrityError`` into ``QuestionBankConflict`` rather than a 500.

The candidate-facing read (``list_questions_for_bank``) returns ORM rows; the API layer projects
them to a candidate-safe shape (no ``expected_points`` — SPEC P3). F2b admin editing (create/edit/
reorder) rides on ``create_bank`` / ``add_question`` here; the demo ships seed + read only.
"""

from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.question import Question, QuestionBank


class QuestionError(Exception):
    """Base class for question-service errors."""


class QuestionBankNotFound(QuestionError):
    """Raised when a bank id does not exist."""


class QuestionBankConflict(QuestionError):
    """Raised when an operation would violate the one-enabled-default-bank invariant."""


class QuestionNotFound(QuestionError):
    """Raised when a question id does not exist."""


async def create_bank(
    db: AsyncSession,
    *,
    name: str,
    description: str = "",
    language: str = "zh-CN",
    enabled: bool = True,
    is_default: bool = False,
) -> QuestionBank:
    """Create a bank; if ``is_default`` (and enabled), demote any current enabled default."""
    bank = QuestionBank(
        name=name,
        description=description,
        language=language,
        enabled=enabled,
        is_default=is_default,
    )
    if is_default and enabled:
        await _clear_enabled_default_banks(db, exclude_id=None)
        await db.flush()
    db.add(bank)
    await _commit_translating_conflict(db)
    await db.refresh(bank)
    return bank


async def add_question(
    db: AsyncSession,
    *,
    bank_id: str,
    text: str,
    order_index: int,
    language: str = "zh-CN",
    expected_points: str = "[]",
    enabled: bool = True,
    max_follow_ups: int = 0,
    follow_up_prompt: str = "Can you walk me through that in a bit more detail?",
) -> Question:
    """Append/insert a question into a bank at ``order_index``."""
    question = Question(
        bank_id=bank_id,
        text=text,
        order_index=order_index,
        language=language,
        expected_points=expected_points,
        enabled=enabled,
        max_follow_ups=max_follow_ups,
        follow_up_prompt=follow_up_prompt,
    )
    db.add(question)
    await db.commit()
    await db.refresh(question)
    return question


async def get_default_bank(db: AsyncSession) -> QuestionBank | None:
    """The single enabled default bank, or None if none is set."""
    return (
        await db.execute(
            select(QuestionBank).where(
                QuestionBank.enabled.is_(True),
                QuestionBank.is_default.is_(True),
            )
        )
    ).scalar_one_or_none()


async def list_banks(db: AsyncSession) -> Sequence[QuestionBank]:
    return (
        (await db.execute(select(QuestionBank).order_by(QuestionBank.created_at))).scalars().all()
    )


async def list_questions_for_bank(
    db: AsyncSession, bank_id: str, *, enabled_only: bool = True
) -> Sequence[Question]:
    """Questions for a bank in ``order_index`` order (the interview's ask order)."""
    stmt = select(Question).where(Question.bank_id == bank_id)
    if enabled_only:
        stmt = stmt.where(Question.enabled.is_(True))
    stmt = stmt.order_by(Question.order_index)
    return (await db.execute(stmt)).scalars().all()


# --- F2b admin editing -----------------------------------------------------


async def get_bank(db: AsyncSession, bank_id: str) -> QuestionBank:
    bank = (
        await db.execute(select(QuestionBank).where(QuestionBank.id == bank_id))
    ).scalar_one_or_none()
    if bank is None:
        raise QuestionBankNotFound(bank_id)
    return bank


async def get_question(db: AsyncSession, question_id: str) -> Question:
    q = (await db.execute(select(Question).where(Question.id == question_id))).scalar_one_or_none()
    if q is None:
        raise QuestionNotFound(question_id)
    return q


async def update_question(db: AsyncSession, question_id: str, **changes: object) -> Question:
    """Patch a question's editable fields (text, language, expected_points, enabled, follow-up)."""
    q = await get_question(db, question_id)
    for field, value in changes.items():
        setattr(q, field, value)
    await db.commit()
    await db.refresh(q)
    return q


async def delete_question(db: AsyncSession, question_id: str) -> None:
    q = await get_question(db, question_id)
    await db.delete(q)
    await db.commit()


async def reorder_questions(db: AsyncSession, bank_id: str, ordered_ids: list[str]) -> None:
    """Set ``order_index`` to match ``ordered_ids`` (the new display order for the bank).

    Only reorders questions actually in the bank; ids not in the bank are ignored, and any bank
    question omitted from ``ordered_ids`` keeps its relative order after the listed ones.
    """
    await get_bank(db, bank_id)  # 404 if the bank doesn't exist
    rows = {
        q.id: q
        for q in (await db.execute(select(Question).where(Question.bank_id == bank_id)))
        .scalars()
        .all()
    }
    index = 0
    for qid in ordered_ids:
        q = rows.pop(qid, None)
        if q is not None:
            q.order_index = index
            index += 1
    # Preserve any unlisted questions after the explicitly-ordered ones.
    for q in sorted(rows.values(), key=lambda x: x.order_index):
        q.order_index = index
        index += 1
    await db.commit()


async def set_default_bank(db: AsyncSession, bank_id: str) -> QuestionBank:
    """Make ``bank_id`` the sole enabled default (enabling it if needed)."""
    bank = (
        await db.execute(select(QuestionBank).where(QuestionBank.id == bank_id))
    ).scalar_one_or_none()
    if bank is None:
        raise QuestionBankNotFound(bank_id)
    await _clear_enabled_default_banks(db, exclude_id=bank.id)
    await db.flush()  # release the single-default slot before claiming it
    bank.enabled = True
    bank.is_default = True
    await _commit_translating_conflict(db)
    await db.refresh(bank)
    return bank


# --- internals -------------------------------------------------------------


async def _clear_enabled_default_banks(db: AsyncSession, *, exclude_id: str | None) -> None:
    """Demote every currently-enabled default bank (optionally except one) to non-default."""
    stmt = select(QuestionBank).where(
        QuestionBank.enabled.is_(True),
        QuestionBank.is_default.is_(True),
    )
    if exclude_id is not None:
        stmt = stmt.where(QuestionBank.id != exclude_id)
    for row in (await db.execute(stmt)).scalars().all():
        row.is_default = False


async def _commit_translating_conflict(db: AsyncSession) -> None:
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise QuestionBankConflict("more than one enabled default question bank") from exc
