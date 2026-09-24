"""persona bank_turn_mode: admin-controlled turn contract for question-bank voice sessions

Adds ``interviewer_personas.bank_turn_mode`` (string, default ``"linear"``): whether a BANK voice
session gives the model a generative turn of its own between questions.

* ``"linear"`` — no model turn at all: the digital human only reads each backend question verbatim
  (Azure ``create_response=False`` + the page never nudges a bare ``response.create``), exactly the
  contract EXTERNAL sessions already run.
* ``"model"`` — the previous behaviour: server-VAD opens a model turn every time the candidate
  pauses and ``prompt_fragment`` governs what it says.

Owner reversal (2026-09-24) of the v0.38.1.1 "engine decides, no knob" decision: with the model
turn on, the interviewer said "Thank you." once per PAUSE (each pause is a full turn and the prompt
cannot make a single-boolean turn selective), so the default flips existing personas to the silent
linear contract and keeps the model turn as an explicit opt-in. External sessions never consult it.

Revision ID: e1f2a3b4c5d6
Revises: d0e1f2a3b4c5
Create Date: 2026-09-24 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e1f2a3b4c5d6"
down_revision: str | None = "d0e1f2a3b4c5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("interviewer_personas") as batch:
        batch.add_column(
            sa.Column(
                "bank_turn_mode",
                sa.String(length=16),
                nullable=False,
                server_default=sa.text("'linear'"),
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("interviewer_personas") as batch:
        batch.drop_column("bank_turn_mode")
