"""checklist_item.advisory + question.weight

Two additive columns for the 6-dimension MECE classification scoring model:

- ``checklist_items.advisory`` — a forbidden item that discloses (fires ``violated`` + a warning)
  without capping the overall result to "Needs Improvement". Carries a known, unvalidated conflict.
- ``questions.weight`` — relative weight of a question in the interview-level aggregate (default 1,
  = the historical simple mean).

Both have server-side defaults so existing rows backfill cleanly and are non-nullable after.

Revision ID: a7b8c9d0e1f2
Revises: f4d5e6a7b8c9
Create Date: 2026-08-24 16:00:00.000000
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "a7b8c9d0e1f2"
down_revision: str | None = "f4d5e6a7b8c9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "checklist_items",
        sa.Column(
            "advisory",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "questions",
        sa.Column(
            "weight",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("1"),
        ),
    )


def downgrade() -> None:
    op.drop_column("questions", "weight")
    op.drop_column("checklist_items", "advisory")
