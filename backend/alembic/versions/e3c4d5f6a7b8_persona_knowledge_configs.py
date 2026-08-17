"""persona knowledge configs

Revision ID: e3c4d5f6a7b8
Revises: d2b3c4e5f6a7
Create Date: 2026-08-12 12:00:00.000000
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "e3c4d5f6a7b8"
down_revision: str | None = "d2b3c4e5f6a7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "persona_knowledge_configs",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("persona_id", sa.String(length=36), nullable=False),
        sa.Column("connection_name", sa.String(length=255), nullable=False),
        sa.Column("connection_target", sa.String(length=500), nullable=False, server_default=""),
        sa.Column("index_name", sa.String(length=255), nullable=False),
        sa.Column("server_label", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("is_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(
            ["persona_id"], ["interviewer_personas.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_persona_knowledge_configs_persona_id",
        "persona_knowledge_configs",
        ["persona_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_persona_knowledge_configs_persona_id", table_name="persona_knowledge_configs"
    )
    op.drop_table("persona_knowledge_configs")
