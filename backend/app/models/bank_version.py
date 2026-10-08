"""Published bank versions (spec: docs/planning/spec-bank-versioning.md).

A version is a frozen copy of a WHOLE question bank at the moment an admin published it: every
question (text, order, enabled flag, expected points, ...) and each question's rubric, as one unit
in ``content_json``. The ``questions`` / ``checklists`` / ``checklist_items`` rows are the editable
DRAFT; nothing reads them for an interview that pinned a version. A user is assigned a version, an
interview pins one at start, and asking, resuming, reviewing and scoring all read only that one.

Admin-only, like the rubric itself (SPEC P3): never part of a candidate-scoped response.
"""

from sqlalchemy import ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.mixins import TimestampMixin

# Why a version exists: the migration's backfill, an admin's publish, or a bank bundle import.
# "edit"/"draft"/"sync" are rubric-only versions written by v0.52.0.0, kept readable.
BANK_VERSION_REASONS = ("initial", "publish", "import", "edit", "draft", "sync")


class BankVersion(TimestampMixin, Base):
    __tablename__ = "bank_versions"
    # Two concurrent publishes of one bank both computed the same next number; one must lose.
    __table_args__ = (UniqueConstraint("bank_id", "version_no", name="uq_bank_version_bank_no"),)

    # RESTRICT, not CASCADE: banks are only ever logically deleted (disabled), and a version must
    # outlive anything that could remove its bank, or the interviews pinned to it lose their
    # questions and rubric.
    bank_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("question_banks.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    version_no: Mapped[int] = mapped_column(Integer, nullable=False)
    # The bank's name when published, so the version reads on its own (spec: logical delete).
    bank_name: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    # {"questions": [question + "rubric": [item, ...], ...]} — see bank_version_service.
    content_json: Mapped[str] = mapped_column(Text, nullable=False)
    # sha256 of the content without row ids, so publishing an unchanged draft mints nothing.
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    reason: Mapped[str] = mapped_column(String(16), default="publish", nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
