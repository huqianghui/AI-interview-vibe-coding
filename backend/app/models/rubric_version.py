"""Immutable rubric versions (spec: docs/planning/spec-rubric-versioning.md).

The ``checklists`` / ``checklist_items`` rows are the editable working copy of a bank's rubric. A
``rubric_version`` is a frozen copy of the WHOLE bank's rubric at one moment, keyed by question id
in ``content_json``. A user is assigned one, an interview pins one at start, and scoring reads only
the pinned one — so editing the rubric never re-scores an interview that already ran.

Admin-only, like the rubric itself (SPEC P3): never part of a candidate-scoped response.
"""

from sqlalchemy import ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.mixins import TimestampMixin

# Why a version was created: the migration's backfill, an editor save, an AI draft becoming the
# default, or a bank bundle import.
RUBRIC_VERSION_REASONS = ("initial", "edit", "draft", "import")


class RubricVersion(TimestampMixin, Base):
    __tablename__ = "rubric_versions"
    # Two concurrent snapshots of one bank both computed the same next number; one must lose.
    __table_args__ = (UniqueConstraint("bank_id", "version_no", name="uq_rubric_version_bank_no"),)

    bank_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("question_banks.id", ondelete="CASCADE"), nullable=False, index=True
    )
    version_no: Mapped[int] = mapped_column(Integer, nullable=False)
    # {"questions": {question_id: [item, ...]}} — see rubric_version_service.ITEM_FIELDS.
    content_json: Mapped[str] = mapped_column(Text, nullable=False)
    # sha256 of content_json, so a save that changes nothing does not mint a new version.
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    reason: Mapped[str] = mapped_column(String(16), default="edit", nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
