"""Question bank + question models (SPEC F2).

A ``question_bank`` is an ordered set of interview questions; a ``question`` is one prompt with
its display order, language, and the ``expected_points`` that later link to checklist items (F3).
The interview state machine (F6) reads questions in ``order_index`` order from the enabled default
bank, replacing the Step-0 hardcoded set — the ``max_follow_ups`` / ``follow_up_prompt`` columns
preserve F6's follow-up hook so the progression contract is unchanged.

**Exactly one enabled default bank** is enforced at the DB level (partial-unique index), mirroring
the interviewer-persona invariant so the state machine can always resolve "the" bank without app
guesswork.

**Candidate boundary (SPEC P3):** ``expected_points`` links to the rubric and must NEVER reach a
candidate-scoped response — the candidate read API projects only ``text`` / ``order_index`` /
``language``. That projection lives in the API layer; this model just stores the column.

PUBLIC repo: seeded questions are generic placeholders, never real client SOP content.
"""

from sqlalchemy import Boolean, ForeignKey, Index, Integer, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.mixins import TimestampMixin


class QuestionBank(TimestampMixin, Base):
    __tablename__ = "question_banks"

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # Bank-level default language; a question may override per-row (F2 AC #4).
    language: Mapped[str] = mapped_column(String(16), default="zh-CN", nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    __table_args__ = (
        # SPEC F2 (mirrors F5 persona): at most one enabled default bank, enforced in the DB.
        Index(
            "uq_one_enabled_default_bank",
            "is_default",
            unique=True,
            sqlite_where=text("enabled = 1 AND is_default = 1"),
            postgresql_where=text("enabled = true AND is_default = true"),
        ),
    )


class Question(TimestampMixin, Base):
    __tablename__ = "questions"

    bank_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("question_banks.id"), nullable=False, index=True
    )
    # 0-based position within the bank; the state machine advances by this order.
    order_index: Mapped[int] = mapped_column(Integer, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    language: Mapped[str] = mapped_column(String(16), default="zh-CN", nullable=False)
    # JSON list of expected answer points that F3 checklist items link to. NEVER candidate-facing
    # (P3) — stored here, projected out of candidate responses at the API layer.
    expected_points: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # F6 follow-up hook (carried over from the Step-0 hardcoded set so progression is unchanged).
    max_follow_ups: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    follow_up_prompt: Mapped[str] = mapped_column(
        Text, default="Can you walk me through that in a bit more detail?", nullable=False
    )
