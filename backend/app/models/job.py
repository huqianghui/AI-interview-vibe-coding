"""Background jobs (docs/planning/spec-jobs-and-scale-out.md): one row per unit of slow work.

Scoring an interview, converting an SOP to sections, drafting its summary, relocating a bank's
citations and syncing the default persona run in the JOB PROCESS (``python -m app.jobs.runner``),
never in a web worker that also carries live voice sockets. The row is the only coordination
between processes: who runs it (``lease_owner``), until when (``lease_until``, renewed by a
heartbeat), and what came of it. A job whose lease expires is reclaimed by any runner, which is how
work interrupted by a restart resumes. ``payload``, ``progress`` and ``result`` are JSON as text,
like every other JSON column here.
"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Index, Integer, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.mixins import TimestampMixin

JOB_KINDS = (
    "score_interview",
    "sop_build",
    "sop_summary",
    "sop_backfill",
    "citation_run",
    "persona_sync",
)
JOB_STATUSES = ("queued", "running", "succeeded", "failed", "cancelled")
# A job in one of these holds its target: at most one per (kind, target_id), enforced below.
LIVE_STATUSES = ("queued", "running")
_LIVE = "status IN ('queued', 'running')"


class Job(TimestampMixin, Base):
    __tablename__ = "jobs"
    __table_args__ = (
        # One live job per target: two clicks, or two processes, enqueueing the same work get the
        # same job (the second insert fails and the caller returns the live one).
        Index(
            "uq_jobs_live_target",
            "kind",
            "target_id",
            unique=True,
            sqlite_where=text(_LIVE),
            postgresql_where=text(_LIVE),
        ),
        Index("ix_jobs_status_created_at", "status", "created_at"),
    )

    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    # The interview, document, bank (citation run) or persona the job works on.
    target_id: Mapped[str] = mapped_column(String(64), nullable=False)
    payload: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="queued", nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3, nullable=False)
    progress: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    result: Mapped[str] = mapped_column(Text, default="", nullable=False)
    error: Mapped[str] = mapped_column(Text, default="", nullable=False)
    lease_owner: Mapped[str] = mapped_column(String(128), default="", nullable=False)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # "candidate", "system", or the admin user id who asked for it.
    created_by: Mapped[str] = mapped_column(String(64), default="system", nullable=False)
