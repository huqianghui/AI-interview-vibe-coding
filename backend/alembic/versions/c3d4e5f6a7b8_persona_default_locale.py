"""persona default_locale column

Revision ID: c3d4e5f6a7b8
Revises: a7b8c9d0e1f2
Create Date: 2026-09-01 09:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c3d4e5f6a7b8"
down_revision: str | None = "a7b8c9d0e1f2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The editor's remembered "Language" selector locale (which locale of voice_map/greeting_map the
    # editor opens on and last edited). Not null with a server_default so existing rows backfill to
    # the historical hardcoded default ("zh-CN"), matching the pre-migration UI behavior.
    op.add_column(
        "interviewer_personas",
        sa.Column(
            "default_locale",
            sa.String(length=16),
            nullable=False,
            server_default="zh-CN",
        ),
    )


def downgrade() -> None:
    op.drop_column("interviewer_personas", "default_locale")
