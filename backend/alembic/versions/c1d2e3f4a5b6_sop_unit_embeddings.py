"""SOP unit embeddings for hybrid search: ``sop_unit_embeddings``.

One row per unit of an SOP (app.sop.units): its citation key, a hash of its text and its vector
as JSON (a plain column; the backend ranks, owner 2026-10-09). A new table only: nothing existing
is rebuilt, so it is safe on SQLite with foreign keys on and on PostgreSQL.

Revision ID: c1d2e3f4a5b6
Revises: f1a2b3c4d5e6
Create Date: 2026-10-10 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c1d2e3f4a5b6"
down_revision: str | None = "f1a2b3c4d5e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "sop_unit_embeddings",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "document_id",
            sa.String(length=36),
            sa.ForeignKey("sop_documents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("unit_key", sa.String(length=120), nullable=False),
        sa.Column("text_hash", sa.String(length=64), nullable=False),
        sa.Column("model", sa.String(length=100), nullable=False, server_default=""),
        sa.Column("vector", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
        sa.UniqueConstraint("document_id", "unit_key", "text_hash", name="uq_sop_unit_embeddings"),
    )
    op.create_index("ix_sop_unit_embeddings_document_id", "sop_unit_embeddings", ["document_id"])


def downgrade() -> None:
    op.drop_index("ix_sop_unit_embeddings_document_id", table_name="sop_unit_embeddings")
    op.drop_table("sop_unit_embeddings")
