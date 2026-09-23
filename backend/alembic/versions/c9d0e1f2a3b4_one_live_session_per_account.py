"""one live candidate session per account (#102 review R2)

Adds ``anonymous_candidate_sessions.active_user_id`` plus a UNIQUE index on it. The column mirrors
``user_id`` while the row is the account's live seat and is NULL once released (expired / revoked /
superseded). Because NULLs do not collide in a unique index, an account may accumulate any number of
historical sessions while the database guarantees at most ONE live one — which makes the
find-then-insert in ``anonymous_session_service.create_anonymous_session`` race-safe (the loser of a
concurrent first login hits the constraint and reuses the winner's session).

Backfill: existing rows that are still live (not revoked, not expired) claim the seat; anything else
gets NULL. Pre-#102 rows have ``user_id IS NULL`` and therefore stay NULL, so the constraint cannot
be violated by historical data.

Revision ID: c9d0e1f2a3b4
Revises: b8c9d0e1f2a3
Create Date: 2026-09-23 00:20:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c9d0e1f2a3b4"
down_revision: str | None = "b8c9d0e1f2a3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("anonymous_candidate_sessions") as batch:
        batch.add_column(sa.Column("active_user_id", sa.String(length=36), nullable=True))
    # Claim the seat for rows that are genuinely live right now; everything else stays NULL.
    op.execute(
        """
        UPDATE anonymous_candidate_sessions
           SET active_user_id = user_id
         WHERE user_id IS NOT NULL
           AND is_revoked = 0
           AND expires_at > CURRENT_TIMESTAMP
           AND id IN (
               SELECT id FROM (
                   SELECT id, ROW_NUMBER() OVER (
                       PARTITION BY user_id ORDER BY expires_at DESC
                   ) AS rn
                     FROM anonymous_candidate_sessions
                    WHERE user_id IS NOT NULL AND is_revoked = 0
                      AND expires_at > CURRENT_TIMESTAMP
               ) ranked
                WHERE rn = 1
           )
        """
    )
    op.create_index(
        "uq_anon_session_active_user",
        "anonymous_candidate_sessions",
        ["active_user_id"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("uq_anon_session_active_user", table_name="anonymous_candidate_sessions")
    with op.batch_alter_table("anonymous_candidate_sessions") as batch:
        batch.drop_column("active_user_id")
