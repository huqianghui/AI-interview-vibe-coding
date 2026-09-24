"""judged turn mode (issue #114): judge knobs, model→linear, session turn_mode snapshot, judge_events,
single persona prompt.

* ``interviewer_personas.judge_silence_seconds`` (int, 2) / ``judge_max_calls_per_question`` (int, 2)
* ``interviewer_personas.bank_turn_mode``: the retired ``model`` value becomes ``linear`` (owner: existing
  personas stay silent; ``judged`` is an explicit admin opt-in)
* ``interviewer_personas.prompt_fragment``: blank rows are backfilled with the generated default so
  there is exactly ONE prompt per persona and no hidden fallback (review D14)
* ``interview_sessions.turn_mode`` (varchar 16, 'linear'): per-session snapshot of the turn contract
  (review D6)
* ``judge_events``: one row per LLM judge call

Revision ID: f2a3b4c5d6e7
Revises: e1f2a3b4c5d6
Create Date: 2026-09-24 16:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f2a3b4c5d6e7"
down_revision: str | None = "e1f2a3b4c5d6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("interviewer_personas") as batch:
        batch.add_column(
            sa.Column(
                "judge_silence_seconds", sa.Integer(), nullable=False, server_default=sa.text("2")
            )
        )
        batch.add_column(
            sa.Column(
                "judge_max_calls_per_question",
                sa.Integer(),
                nullable=False,
                server_default=sa.text("2"),
            )
        )
    op.execute(
        "UPDATE interviewer_personas SET bank_turn_mode = 'linear' WHERE bank_turn_mode = 'model'"
    )

    # D14: one prompt per persona — backfill blank fragments with the generated default text.
    from app.models.persona import default_instructions

    conn = op.get_bind()
    rows = conn.execute(
        sa.text("SELECT id, name FROM interviewer_personas WHERE TRIM(prompt_fragment) = ''")
    ).fetchall()
    for row in rows:
        conn.execute(
            sa.text("UPDATE interviewer_personas SET prompt_fragment = :p WHERE id = :id"),
            {"p": default_instructions(row.name), "id": row.id},
        )

    with op.batch_alter_table("interview_sessions") as batch:
        batch.add_column(
            sa.Column(
                "turn_mode",
                sa.String(length=16),
                nullable=False,
                server_default=sa.text("'linear'"),
            )
        )

    op.create_table(
        "judge_events",
        sa.Column("id", sa.String(length=36), primary_key=True),
        # Server-side defaults are REQUIRED here: the ORM never sends these two columns (the mixin
        # relies on the DB default), and create_all-built test tables carry the default while a
        # migration-built table would not — live 2026-09-24 the first real insert failed NOT NULL.
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column(
            "interview_session_id",
            sa.String(length=36),
            sa.ForeignKey("interview_sessions.id"),
            nullable=False,
        ),
        sa.Column("question_id", sa.String(length=64), nullable=False),
        sa.Column("trigger", sa.String(length=16), nullable=False),
        sa.Column("verdict", sa.String(length=16), nullable=False),
        sa.Column("speech_text", sa.Text(), nullable=False, server_default=""),
        sa.Column("reason", sa.Text(), nullable=False, server_default=""),
        sa.Column("model", sa.String(length=100), nullable=False, server_default=""),
        sa.Column("latency_ms", sa.Integer(), nullable=False, server_default=sa.text("0")),
    )
    op.create_index("ix_judge_events_session", "judge_events", ["interview_session_id"])


def downgrade() -> None:
    op.drop_index("ix_judge_events_session", table_name="judge_events")
    op.drop_table("judge_events")
    with op.batch_alter_table("interview_sessions") as batch:
        batch.drop_column("turn_mode")
    op.execute(
        "UPDATE interviewer_personas SET bank_turn_mode = 'linear' WHERE bank_turn_mode = 'judged'"
    )
    with op.batch_alter_table("interviewer_personas") as batch:
        batch.drop_column("judge_max_calls_per_question")
        batch.drop_column("judge_silence_seconds")
