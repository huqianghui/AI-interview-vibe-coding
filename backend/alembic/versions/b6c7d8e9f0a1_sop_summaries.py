"""SOP summaries: one key-points summary per document, approved by an admin before scoring uses it.

Spec: docs/planning/spec-sop-section-grounding.md (PR 2 of 3). Adds ``sop_documents.summary`` /
``summary_status`` / ``summary_error`` / ``summary_reviewed_at``. Summaries are drafted at boot by
``sop_summary_service.summarize_missing`` (an LLM call), not here.

Also adds ``markdown_converter_version``: every existing conversion is version 1, and this
release's Word converter is version 2 (merged cells once, form tables as sections), so the boot
build converts the Word documents again. A failed re-conversion keeps the version-1 result.

Revision ID: b6c7d8e9f0a1
Revises: a4b5c6d7e8f9
Create Date: 2026-10-08 23:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b6c7d8e9f0a1"
down_revision: str | None = "a4b5c6d7e8f9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_COLUMNS = (
    "markdown_converter_version",
    "summary_reviewed_at",
    "summary_error",
    "summary_status",
    "summary",
)


def upgrade() -> None:
    op.add_column(
        "sop_documents", sa.Column("summary", sa.Text(), nullable=False, server_default="")
    )
    op.add_column(
        "sop_documents",
        sa.Column("summary_status", sa.String(length=16), nullable=False, server_default=""),
    )
    op.add_column(
        "sop_documents", sa.Column("summary_error", sa.Text(), nullable=False, server_default="")
    )
    op.add_column("sop_documents", sa.Column("summary_reviewed_at", sa.DateTime(), nullable=True))
    op.add_column(
        "sop_documents",
        sa.Column(
            "markdown_converter_version", sa.Integer(), nullable=False, server_default="0"
        ),
    )
    op.execute(
        "UPDATE sop_documents SET markdown_converter_version = 1"
        " WHERE markdown_source NOT IN ('', 'failed')"
    )


def downgrade() -> None:
    for column in _COLUMNS:
        if op.get_bind().dialect.name == "sqlite":
            op.execute(f"ALTER TABLE sop_documents DROP COLUMN {column}")
        else:
            op.drop_column("sop_documents", column)
