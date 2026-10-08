"""Rubric items cite SOP sections: ``checklist_items.source_refs``, and ``citation_runs``.

Spec: docs/planning/spec-sop-section-grounding.md §3 (PR 3 of 3). A JSON list of
``{"document_id", "section"}``; existing items cite none until their citations are relocated
(``sop_citation_service``) and the bank is published again. ``citation_runs`` keeps each
relocation's progress and its old → new report for the admin to review.

Revision ID: c8d9e0f1a2b3
Revises: b6c7d8e9f0a1
Create Date: 2026-10-08 23:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c8d9e0f1a2b3"
down_revision: str | None = "b6c7d8e9f0a1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "checklist_items",
        sa.Column("source_refs", sa.Text(), nullable=False, server_default="[]"),
    )
    op.create_table(
        "citation_runs",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "bank_id",
            sa.String(length=36),
            sa.ForeignKey("question_banks.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="running"),
        sa.Column("done", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("report_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("error", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("ix_citation_runs_bank_id", "citation_runs", ["bank_id"])


def downgrade() -> None:
    op.drop_index("ix_citation_runs_bank_id", table_name="citation_runs")
    op.drop_table("citation_runs")
    if op.get_bind().dialect.name == "sqlite":
        op.execute("ALTER TABLE checklist_items DROP COLUMN source_refs")
    else:
        op.drop_column("checklist_items", "source_refs")
