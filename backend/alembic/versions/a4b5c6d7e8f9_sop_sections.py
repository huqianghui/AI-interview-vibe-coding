"""SOP sections: each document as Markdown, split into its sections.

Spec: docs/planning/spec-sop-section-grounding.md (PR 1 of 3). Adds ``sop_documents.markdown`` /
``markdown_source`` and the ``sop_sections`` table. Existing documents are converted and split at
boot from their stored originals (``sop_section_service.build_missing``), not here: conversion
calls Azure Document Intelligence, which a migration must not depend on.

Revision ID: a4b5c6d7e8f9
Revises: f3a4b5c6d7e8
Create Date: 2026-10-08 21:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "a4b5c6d7e8f9"
down_revision: str | None = "f3a4b5c6d7e8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "sop_documents", sa.Column("markdown", sa.Text(), nullable=False, server_default="")
    )
    op.add_column(
        "sop_documents",
        sa.Column("markdown_source", sa.String(length=32), nullable=False, server_default=""),
    )
    op.add_column(
        "sop_documents", sa.Column("markdown_error", sa.Text(), nullable=False, server_default="")
    )
    op.create_table(
        "sop_sections",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "document_id",
            sa.String(length=36),
            sa.ForeignKey("sop_documents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("order_index", sa.Integer(), nullable=False),
        sa.Column("number", sa.String(length=32), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("level", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("parent_index", sa.Integer(), nullable=True),
        sa.Column("page_start", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("page_end", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("text", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
        sa.UniqueConstraint("document_id", "order_index", name="uq_sop_sections_order"),
    )
    op.create_index("ix_sop_sections_document_id", "sop_sections", ["document_id"])


def downgrade() -> None:
    op.drop_index("ix_sop_sections_document_id", table_name="sop_sections")
    op.drop_table("sop_sections")
    if op.get_bind().dialect.name == "sqlite":
        op.execute("ALTER TABLE sop_documents DROP COLUMN markdown_error")
        op.execute("ALTER TABLE sop_documents DROP COLUMN markdown_source")
        op.execute("ALTER TABLE sop_documents DROP COLUMN markdown")
    else:
        op.drop_column("sop_documents", "markdown_error")
        op.drop_column("sop_documents", "markdown_source")
        op.drop_column("sop_documents", "markdown")
