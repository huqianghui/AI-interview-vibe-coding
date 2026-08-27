"""persona model column

Revision ID: f4d5e6a7b8c9
Revises: e3c4d5f6a7b8
Create Date: 2026-08-17 09:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f4d5e6a7b8c9"
down_revision: str | None = "e3c4d5f6a7b8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Per-persona model deployment (different agent versions may run different models). Nullable —
    # null means "fall back to the global foundry_agent_model", so no server_default is needed.
    op.add_column(
        "interviewer_personas",
        sa.Column("model", sa.String(length=100), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("interviewer_personas", "model")
