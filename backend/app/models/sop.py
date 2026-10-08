"""SOP document + chunk models (SPEC F1).

An SOP document is uploaded, its text extracted, then split into section-aware chunks that carry
page/section labels so citations can point back to an exact location (the traceability the demo
leads with). ``sop_chunk`` mirrors the reference's ``material_chunks`` shape
(chunk_index / content / page_label).

PUBLIC repo: no real SOP content is stored in this repo — these are schema definitions only.
"""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.mixins import TimestampMixin

# Ingestion lifecycle for a document.
SOP_STATUSES = ("uploaded", "extracting", "chunked", "indexed", "failed")


class SopDocument(TimestampMixin, Base):
    __tablename__ = "sop_documents"

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # Storage pointer resolved by the pluggable storage backend (local dev / Azure Blob prod).
    # Never exposed directly to candidates (SPEC P4) — only server-mediated citation text is.
    blob_path: Mapped[str] = mapped_column(String(512), default="", nullable=False)
    content_type: Mapped[str] = mapped_column(String(128), default="", nullable=False)
    size: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="uploaded", nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    # The document as Markdown (spec-sop-section-grounding), the source the sections were split
    # from, kept so an admin can see what the split worked on. Empty until converted.
    markdown: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # How it was converted: document_intelligence | pdf_text | docx | text | failed; "" = not yet.
    markdown_source: Mapped[str] = mapped_column(String(32), default="", nullable=False)
    # Why the last conversion failed (which pages were not fully read, a timeout, ...); "" if not.
    markdown_error: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # Which version of the converter for ``markdown_source`` produced ``markdown``
    # (``sop_markdown.CONVERTER_VERSIONS``); one converted by an older version is converted again.
    markdown_converter_version: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # The document's key-points summary (spec-sop-section-grounding §2): AI-drafted from the whole
    # Markdown, edited and approved by an admin. Only an approved summary is used in scoring.
    summary: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # "" = none yet | draft = AI-drafted or edited, not approved | reviewed = approved | failed
    summary_status: Mapped[str] = mapped_column(String(16), default="", nullable=False)
    summary_error: Mapped[str] = mapped_column(Text, default="", nullable=False)
    summary_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class SopChunk(TimestampMixin, Base):
    __tablename__ = "sop_chunks"

    document_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("sop_documents.id"), nullable=False, index=True
    )
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    content: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # Human-facing location label used verbatim in the citation `page` field.
    page_label: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Structural path (e.g. "3 > Safety > 3.2") for section-aware retrieval, when available.
    section_path: Mapped[str | None] = mapped_column(String(255), nullable=True)
    token_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class SopSection(TimestampMixin, Base):
    """One section of an SOP, split from its Markdown (spec-sop-section-grounding).

    ``text`` is this section's own text only; the full cited passage is it plus every descendant
    (``sop_section_service.full_text``), never a fixed-size slice. ``number`` is the clause number
    ("4.2.3"), or "§n" for an unnumbered heading and "§0" for text before the first heading.
    """

    __tablename__ = "sop_sections"
    # A document's sections are numbered once: a second concurrent build fails instead of
    # interleaving a duplicate set.
    __table_args__ = (UniqueConstraint("document_id", "order_index", name="uq_sop_sections_order"),)

    document_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("sop_documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    order_index: Mapped[int] = mapped_column(Integer, nullable=False)
    number: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    level: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    # order_index of the parent section in the same document; NULL at the top level.
    parent_index: Mapped[int | None] = mapped_column(Integer, nullable=True)
    page_start: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    page_end: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    text: Mapped[str] = mapped_column(Text, default="", nullable=False)
