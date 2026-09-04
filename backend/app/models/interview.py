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

# Which interview engine drives a session (Phase 2). "bank" = the built-in question-bank state
# machine (default, unchanged); "external" = the client's external interview API/server, driven
# turn-by-turn by app.interview.external_runner. The value is a per-session SNAPSHOT copied from
# InterviewerPersona.interview_brain at start, so flipping a persona later never re-interprets a
# past session. Vendor-neutral by owner directive: never the product name, only "external".
BRAIN_MODES = ("bank", "external")

# External sub-state within a still-``in_progress`` external session (NULL for bank sessions). It is
# deliberately NOT a new top-level status, so find_resumable_interview (status == "in_progress")
# resumes external sessions unmodified. "idle" = healthy, between turns; "awaiting" = a turn is
# CAS-reserved and the external brain is being called (a fresh page treats this like recovery, since
# the in-flight outcome is unknown); "recovery_required" = auto-retry exhausted, the candidate is
# owed a 恢复/Recover action.
EXTERNAL_PHASES = ("idle", "awaiting", "recovery_required")


class InterviewSession(TimestampMixin, Base):
    __tablename__ = "interview_sessions"

    candidate_session_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("anonymous_candidate_sessions.id"), nullable=False, index=True
    )
    status: Mapped[str] = mapped_column(String(16), default="created", nullable=False)
    current_question_index: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # --- Phase 2: external interview brain (all NULL/default for bank sessions) --------------
    # The engine driving this session, snapshotted from the persona at start (see BRAIN_MODES).
    brain_mode: Mapped[str] = mapped_column(String(16), default="bank", nullable=False)
    # The external API's opaque conversation label (echoed back each turn). Never authoritative on
    # its own — the state blob below is what actually carries the interview's position.
    external_conversation_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # The opaque ``session_state_json`` blob round-tripped verbatim every turn. Backend-only: it
    # carries live per-question scores/rubric, so it MUST NEVER reach the browser or any LLM.
    external_state: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The full scrubbed public_response_json of the last committed turn, for silent resume replay
    # (re-render its text WITHOUT re-calling the API or re-speaking). Candidate-safe content only.
    external_last_response: Mapped[str | None] = mapped_column(Text, nullable=True)
    # External sub-state (see EXTERNAL_PHASES); NULL for bank sessions.
    external_phase: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # Optimistic-lock / CAS turn counter. A submit atomically reserves the turn by bumping this in a
    # single guarded UPDATE, so two distinct answers can never both drive the same turn.
    turn_version: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


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
