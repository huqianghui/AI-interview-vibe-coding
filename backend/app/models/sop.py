"""SOP document + chunk models (SPEC F1).

An SOP document is uploaded, its text extracted, then split into section-aware chunks that carry
page/section labels so citations can point back to an exact location (the traceability the demo
leads with). ``sop_chunk`` mirrors the reference's ``material_chunks`` shape
(chunk_index / content / page_label).

PUBLIC repo: no real SOP content is stored in this repo — these are schema definitions only.
"""

from sqlalchemy import ForeignKey, Integer, String, Text
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
