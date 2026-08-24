"""Checklist (rubric) models (SPEC F3).

A ``checklist`` is the scoring standard for one question: a set of ``checklist_item`` rows, each
a ``required`` / ``recommended`` / ``forbidden`` point carrying its weight and — critically — the
SOP source it came from (``source_quote`` + ``source_document_id`` + ``source_page``). That source
link is the traceability the demo leads with: every scored judgment can point back to the exact
SOP text behind the rubric item.

Unlike the reference's ``ScoringRubric.dimensions`` JSON blob, items are **first-class rows** so
each one is independently source-attributable and (F3b) editable.

**Candidate boundary (SPEC P3):** a checklist and its items are the rubric — they must NEVER reach
a candidate-scoped response at any interview status. These routes are admin-only; the candidate
question projection (F2) already omits the rubric link.

PUBLIC repo: no real SOP content — schema + neutral defaults only.
"""

from sqlalchemy import Boolean, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.mixins import TimestampMixin

# An item is one of three kinds: required (must be present), recommended (bonus), forbidden
# (must NOT be present — triggers a "violated" judgment in F4 scoring).
CHECKLIST_ITEM_KINDS = ("required", "recommended", "forbidden")


class Checklist(TimestampMixin, Base):
    __tablename__ = "checklists"

    question_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("questions.id"), nullable=False, index=True
    )
    # Which prompt/version drafted this checklist (registry pattern, mirrors F4 scoring versioning).
    prompt_version: Mapped[str] = mapped_column(String(64), default="v1", nullable=False)
    is_default: Mapped[bool] = mapped_column(default=True, nullable=False)


class ChecklistItem(TimestampMixin, Base):
    __tablename__ = "checklist_items"

    checklist_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("checklists.id"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String(16), nullable=False)  # required|recommended|forbidden
    text: Mapped[str] = mapped_column(Text, nullable=False)
    # Weight toward the question's score. Weights across a checklist sum to 100 (F3 AC #3).
    weight: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # Advisory gate: a forbidden item flagged advisory still fires a "violated" judgment + warning
    # (so the report discloses it), but does NOT cap the overall result to "Needs Improvement". This
    # carries the known-conflict disclosure rule — an unresolved source conflict must be disclosed
    # yet must not force a hard-fail while its status is pending owner validation. Non-forbidden
    # items ignore the flag.
    advisory: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # SOP source attribution (the traceability spine). source_quote is the verbatim SOP text the
    # item was drawn from; source_document_id / source_page point back to where it lives.
    source_quote: Mapped[str] = mapped_column(Text, default="", nullable=False)
    source_document_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("sop_documents.id"), nullable=True
    )
    source_page: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Position within the checklist for stable display order.
    order_index: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
