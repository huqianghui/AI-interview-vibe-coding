"""candidate login (#102): users.password_generation + anonymous_candidate_sessions.user_id

Two additive, nullable columns:
- ``users.password_generation``: non-NULL marks a system-derived password (the seeded candidate
  accounts, generation 1); NULL = self-set (the admin). Lets the admin Users tab show the derived
  password without storing plaintext.
- ``anonymous_candidate_sessions.user_id``: the logged-in candidate a session was minted for.
  Nullable so pre-existing rows stay valid; every new row carries it.

Revision ID: b8c9d0e1f2a3
Revises: f6a7b8c9d0e1
Create Date: 2026-09-22 21:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b8c9d0e1f2a3"
down_revision: str | None = "f6a7b8c9d0e1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("password_generation", sa.Integer(), nullable=True))
    with op.batch_alter_table("anonymous_candidate_sessions") as batch:
        batch.add_column(sa.Column("user_id", sa.String(length=36), nullable=True))
        batch.create_index("ix_anonymous_candidate_sessions_user_id", ["user_id"], unique=False)
        batch.create_foreign_key(
            "fk_anonymous_candidate_sessions_user_id_users", "users", ["user_id"], ["id"]
        )


def downgrade() -> None:
    with op.batch_alter_table("anonymous_candidate_sessions") as batch:
        batch.drop_constraint("fk_anonymous_candidate_sessions_user_id_users", type_="foreignkey")
        batch.drop_index("ix_anonymous_candidate_sessions_user_id")
        batch.drop_column("user_id")
    op.drop_column("users", "password_generation")
