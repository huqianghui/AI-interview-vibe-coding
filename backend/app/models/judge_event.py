"""One row per LLM judge call (issue #114) — the audit trail behind the "judged turns" contract.

Written by ``POST /candidate/interview/{id}/judge`` for every actual LLM call, plus the two
non-call outcomes worth seeing (``error``, ``leak_blocked``). Blank / stale / capped requests make
no LLM call and write NO row. ``reason`` is the judge's own rationale — internal, never shown to the
candidate. Read by the acceptance metrics (latency p50, calls per question) and by admins debugging
"why did it interject".
"""

from sqlalchemy import Boolean, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.mixins import TimestampMixin

JUDGE_TRIGGERS = ("voice_silence", "text_idle")
JUDGE_VERDICTS = ("wait", "nudge", "follow_up", "redirect")
JUDGE_EVENT_VERDICTS = JUDGE_VERDICTS + ("error", "leak_blocked")


class JudgeEvent(TimestampMixin, Base):
    __tablename__ = "judge_events"

    interview_session_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("interview_sessions.id"), nullable=False
    )
    question_id: Mapped[str] = mapped_column(String(64), nullable=False)
    trigger: Mapped[str] = mapped_column(String(16), nullable=False)
    verdict: Mapped[str] = mapped_column(String(16), nullable=False)
    speech_text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    reason: Mapped[str] = mapped_column(Text, default="", nullable=False)
    model: Mapped[str] = mapped_column(String(100), default="", nullable=False)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # Speculative prefetch (issue #114 follow-up, owner decision D17): the page asks the judge the
    # moment an utterance ends (``dry_run``) and APPLIES the verdict only if the silence lasts. Only
    # applied verdicts count against ``judge_max_calls_per_question``; the raw LLM-call count is
    # bounded separately (see the /judge route).
    applied: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="0", nullable=False
    )

    __table_args__ = (Index("ix_judge_events_session", "interview_session_id"),)
