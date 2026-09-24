"""judge_events.applied — speculative prefetch (issue #114 follow-up, decision D17).

The page now asks the judge the moment an utterance ends (``dry_run``) and applies the verdict only
if the pause lasts; ``applied`` marks the rows whose verdict was actually delivered. Budget
(``judge_max_calls_per_question``) counts applied rows only.

Revision ID: a3b4c5d6e7f8
Revises: f2a3b4c5d6e7
Create Date: 2026-09-24 20:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a3b4c5d6e7f8"
down_revision: str | None = "f2a3b4c5d6e7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("judge_events") as batch:
        batch.add_column(
            sa.Column("applied", sa.Boolean(), nullable=False, server_default=sa.text("0"))
        )
    # Every pre-existing row was a one-step call whose verdict was delivered.
    op.execute("UPDATE judge_events SET applied = 1")


def downgrade() -> None:
    with op.batch_alter_table("judge_events") as batch:
        batch.drop_column("applied")
