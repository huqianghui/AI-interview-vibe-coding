"""persona tools_config

Revision ID: c1a2b3d4e5f6
Revises: 9a62a4b063ec
Create Date: 2026-08-11 20:10:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c1a2b3d4e5f6"
down_revision: str | None = "9a62a4b063ec"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Per-persona agent tools (JSON array of tool dicts). server_default="[]" so the NOT NULL add
    # succeeds on existing persona rows.
    op.add_column(
        "interviewer_personas",
        sa.Column("tools_config", sa.Text(), nullable=False, server_default="[]"),
    )


def downgrade() -> None:
    op.drop_column("interviewer_personas", "tools_config")
