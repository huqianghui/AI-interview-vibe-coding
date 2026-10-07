"""Pin the interviewer + bank on each interview; per-user assignment; keep the report (#187).

``interview_sessions.persona_id`` / ``bank_id`` record what an interview started with, so a later
change of the default (or of a user's assignment) cannot repoint a live interview's questions.
``users.assigned_persona_id`` / ``assigned_bank_id`` are the user's assignment. All four are
nullable with ``ON DELETE SET NULL`` and NULL means "the current default", so existing rows keep
their pre-#187 behaviour and nothing is backfilled. ``report_json`` / ``total_score`` / ``outcome``
keep the last scoring run, so the interview history shows a report without re-scoring.

Revision ID: c7d8e9f0a1b2
Revises: b5c6d7e8f9a0
Create Date: 2026-10-07 10:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c7d8e9f0a1b2"
down_revision: str | None = "b5c6d7e8f9a0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_COLUMNS = (
    ("interview_sessions", "persona_id", "interviewer_personas"),
    ("interview_sessions", "bank_id", "question_banks"),
    ("users", "assigned_persona_id", "interviewer_personas"),
    ("users", "assigned_bank_id", "question_banks"),
)


def upgrade() -> None:
    with op.batch_alter_table("interview_sessions") as batch:
        batch.add_column(sa.Column("report_json", sa.Text(), nullable=True))
        batch.add_column(sa.Column("total_score", sa.Float(), nullable=True))
        batch.add_column(sa.Column("outcome", sa.String(length=32), nullable=True))
    # batch mode so SQLite (dev / tests) can add the FK constraints too.
    for table, column, target in _COLUMNS:
        with op.batch_alter_table(table) as batch:
            batch.add_column(sa.Column(column, sa.String(length=36), nullable=True))
            batch.create_foreign_key(
                f"fk_{table}_{column}", target, [column], ["id"], ondelete="SET NULL"
            )


def downgrade() -> None:
    for table, column, _target in reversed(_COLUMNS):
        with op.batch_alter_table(table) as batch:
            batch.drop_constraint(f"fk_{table}_{column}", type_="foreignkey")
            batch.drop_column(column)
    with op.batch_alter_table("interview_sessions") as batch:
        batch.drop_column("outcome")
        batch.drop_column("total_score")
        batch.drop_column("report_json")
