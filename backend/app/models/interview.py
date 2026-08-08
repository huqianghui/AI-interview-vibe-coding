"""Interview session + turn models (SPEC F6).

Step 0 thin slice: questions come from the hardcoded set (app.interview.questions), so
``question_id`` is a plain string, not yet an FK to a question_bank table (that arrives with
F1/F2). The status enum and turn grouping match the F6 contract so later features add columns,
not rewrites.

An **Answer** = the group of candidate turns for one question (main + 0..N follow_up), per
F6. ``turn_kind`` distinguishes them so follow-up content is scorable without a schema change.
"""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.mixins import TimestampMixin

# Status lifecycle: created → in_progress → completed → scored (F6 AC #5).
INTERVIEW_STATUSES = ("created", "in_progress", "completed", "scored")
TURN_ROLES = ("interviewer", "candidate")
TURN_KINDS = ("main", "follow_up")


class InterviewSession(TimestampMixin, Base):
    __tablename__ = "interview_sessions"

    candidate_session_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("anonymous_candidate_sessions.id"), nullable=False, index=True
    )
    status: Mapped[str] = mapped_column(String(16), default="created", nullable=False)
    current_question_index: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class InterviewTurn(TimestampMixin, Base):
    __tablename__ = "interview_turns"

    interview_session_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("interview_sessions.id"), nullable=False, index=True
    )
    question_id: Mapped[str] = mapped_column(String(64), nullable=False)
    turn_index: Mapped[int] = mapped_column(Integer, nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    turn_kind: Mapped[str] = mapped_column(String(16), default="main", nullable=False)
    # Transport channel that produced the turn: text | voice | verbal_cue (P9 answer source).
    source: Mapped[str] = mapped_column(String(16), default="text", nullable=False)
    content: Mapped[str] = mapped_column(Text, default="", nullable=False)
    audio_ref: Mapped[str | None] = mapped_column(String(255), nullable=True)
