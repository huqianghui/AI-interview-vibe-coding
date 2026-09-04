"""external interview brain: session brain_mode + external state, persona interview_brain

Phase 2 — integrate the client's external interview API/server as a second, per-persona interview
mode beside the built-in question bank. Adds:

- ``interview_sessions``: ``brain_mode`` (which engine drives the session — a per-session snapshot
  of the persona's ``interview_brain``), the opaque round-tripped external state (``external_state``),
  its conversation label (``external_conversation_id``), the last committed public response for
  silent resume replay (``external_last_response``), the external sub-state (``external_phase``),
  and the CAS turn counter (``turn_version``).
- ``interviewer_personas``: ``interview_brain`` (the source-of-truth engine selector).

All additions are safe for bank mode: the two NOT NULL enum/counter columns carry a DB-level
``server_default`` so existing rows backfill to the bank default (``brain_mode='bank'``,
``interview_brain='bank'``, ``turn_version=0``); the external_* payload columns are nullable and
stay NULL for every bank session. Vendor-neutral by owner directive — the enum value is the neutral
token ``external``, never a product name.

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-09-04 14:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e5f6a7b8c9d0"
down_revision: str | None = "d4e5f6a7b8c9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # interview_sessions: engine selector + external-brain state. The two NOT NULL columns carry a
    # server_default so existing rows (all bank mode) backfill without a rewrite.
    op.add_column(
        "interview_sessions",
        sa.Column("brain_mode", sa.String(length=16), nullable=False, server_default="bank"),
    )
    op.add_column(
        "interview_sessions",
        sa.Column("external_conversation_id", sa.String(length=255), nullable=True),
    )
    op.add_column("interview_sessions", sa.Column("external_state", sa.Text(), nullable=True))
    op.add_column(
        "interview_sessions", sa.Column("external_last_response", sa.Text(), nullable=True)
    )
    op.add_column(
        "interview_sessions", sa.Column("external_phase", sa.String(length=32), nullable=True)
    )
    op.add_column(
        "interview_sessions",
        sa.Column("turn_version", sa.Integer(), nullable=False, server_default="0"),
    )

    # interviewer_personas: the source-of-truth engine selector.
    op.add_column(
        "interviewer_personas",
        sa.Column("interview_brain", sa.String(length=16), nullable=False, server_default="bank"),
    )


def downgrade() -> None:
    op.drop_column("interviewer_personas", "interview_brain")
    op.drop_column("interview_sessions", "turn_version")
    op.drop_column("interview_sessions", "external_phase")
    op.drop_column("interview_sessions", "external_last_response")
    op.drop_column("interview_sessions", "external_state")
    op.drop_column("interview_sessions", "external_conversation_id")
    op.drop_column("interview_sessions", "brain_mode")
