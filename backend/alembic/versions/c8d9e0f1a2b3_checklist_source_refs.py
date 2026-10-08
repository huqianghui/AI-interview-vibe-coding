"""Rubric items cite SOP sections: ``checklist_items.source_refs``.

Spec: docs/planning/spec-sop-section-grounding.md §3 (PR 3 of 3). A JSON list of
``{"document_id", "section"}``; existing items cite none until their citations are relocated
(``sop_citation_service``) and the bank is published again.

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


def downgrade() -> None:
    if op.get_bind().dialect.name == "sqlite":
        op.execute("ALTER TABLE checklist_items DROP COLUMN source_refs")
    else:
        op.drop_column("checklist_items", "source_refs")
