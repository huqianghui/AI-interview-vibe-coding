"""Background jobs: ``jobs``, and the judge lease on ``interview_sessions``.

docs/planning/spec-jobs-and-scale-out.md. A new table plus one nullable column: nothing existing is
rebuilt, so it is safe on SQLite with foreign keys on and on PostgreSQL.

Revision ID: df3db2c7bf4d
Revises: c1d2e3f4a5b6
Create Date: 2026-10-11 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "df3db2c7bf4d"
down_revision: str | None = "c1d2e3f4a5b6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_LIVE = "status IN ('queued', 'running')"


def upgrade() -> None:
    op.create_table(
        "jobs",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("target_id", sa.String(length=64), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="queued"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="3"),
        sa.Column("progress", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("result", sa.Text(), nullable=False, server_default=""),
        sa.Column("error", sa.Text(), nullable=False, server_default=""),
        sa.Column("lease_owner", sa.String(length=128), nullable=False, server_default=""),
        sa.Column("lease_until", sa.DateTime(), nullable=True),
        sa.Column("cancel_requested", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.Column("created_by", sa.String(length=64), nullable=False, server_default="system"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index(
        "uq_jobs_live_target",
        "jobs",
        ["kind", "target_id"],
        unique=True,
        sqlite_where=sa.text(_LIVE),
        postgresql_where=sa.text(_LIVE),
    )
    op.create_index("ix_jobs_status_created_at", "jobs", ["status", "created_at"])
    op.add_column(
        "interview_sessions", sa.Column("judge_lease_until", sa.DateTime(), nullable=True)
    )


def downgrade() -> None:
    # SQLite cannot drop a column in place: batch mode rebuilds the table.
    with op.batch_alter_table("interview_sessions") as batch:
        batch.drop_column("judge_lease_until")
    op.drop_index("ix_jobs_status_created_at", table_name="jobs")
    op.drop_index("uq_jobs_live_target", table_name="jobs")
    op.drop_table("jobs")
