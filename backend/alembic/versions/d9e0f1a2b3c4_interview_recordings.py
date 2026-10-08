"""Candidate voice recordings: ``interview_recordings`` (one WAV per question, kept 90 days).

Revision ID: d9e0f1a2b3c4
Revises: c8d9e0f1a2b3
Create Date: 2026-10-09 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d9e0f1a2b3c4"
down_revision: str | None = "c8d9e0f1a2b3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "interview_recordings",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "interview_session_id",
            sa.String(length=36),
            sa.ForeignKey("interview_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("question_index", sa.Integer(), nullable=False),
        sa.Column("blob_path", sa.String(length=512), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("size_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index(
        "ix_interview_recordings_interview_session_id",
        "interview_recordings",
        ["interview_session_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_interview_recordings_interview_session_id", table_name="interview_recordings"
    )
    op.drop_table("interview_recordings")
