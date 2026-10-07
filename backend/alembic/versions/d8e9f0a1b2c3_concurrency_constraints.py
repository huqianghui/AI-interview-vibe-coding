"""Database-enforced invariants that SQLite's single writer used to hide (PostgreSQL switch).

On SQLite every write serialized behind one file lock, so a select-then-insert could not really
race. On PostgreSQL two requests run side by side under READ COMMITTED and each can pass the same
Python check. These invariants now live in the database:

- ``uq_one_live_interview_per_candidate``: at most one ``in_progress`` interview per candidate
  session (a double-clicked or reloaded /start created two, each with its own external
  conversation).
- ``uq_one_default_checklist_per_question``: at most one default rubric per question (two
  concurrent "generate" calls each demoted the old one and inserted a new default).
- ``uq_persona_name_ci``: interviewer names unique ignoring case and surrounding spaces (the
  app-level check is check-then-insert).

Existing duplicates are resolved first so the upgrade cannot fail on old data: the newest live
interview is kept and older ones become ``abandoned``; the newest default rubric is kept; a
duplicate persona name gets a " (2)", " (3)" suffix.

Revision ID: d8e9f0a1b2c3
Revises: c7d8e9f0a1b2
Create Date: 2026-10-07 18:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d8e9f0a1b2c3"
down_revision: str | None = "c7d8e9f0a1b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _dedupe_live_interviews(bind) -> None:
    rows = bind.execute(
        sa.text(
            "SELECT id, candidate_session_id FROM interview_sessions "
            "WHERE status = 'in_progress' ORDER BY candidate_session_id, created_at DESC, id DESC"
        )
    ).all()
    seen: set[str] = set()
    for interview_id, candidate in rows:
        if candidate in seen:
            bind.execute(
                sa.text("UPDATE interview_sessions SET status = 'abandoned' WHERE id = :id"),
                {"id": interview_id},
            )
        seen.add(candidate)


def _dedupe_default_checklists(bind) -> None:
    rows = bind.execute(
        sa.text(
            "SELECT id, question_id FROM checklists WHERE is_default = TRUE "
            "ORDER BY question_id, created_at DESC, id DESC"
        )
    ).all()
    seen: set[str] = set()
    for checklist_id, question in rows:
        if question in seen:
            bind.execute(
                sa.text("UPDATE checklists SET is_default = FALSE WHERE id = :id"),
                {"id": checklist_id},
            )
        seen.add(question)


def _dedupe_persona_names(bind) -> None:
    rows = bind.execute(
        sa.text("SELECT id, name FROM interviewer_personas ORDER BY created_at, id")
    ).all()
    taken = {str(name).strip().lower() for _, name in rows}
    seen: set[str] = set()
    for persona_id, name in rows:
        key = str(name).strip().lower()
        if key not in seen:
            seen.add(key)
            continue
        n = 2
        while f"{key} ({n})" in taken:
            n += 1
        new_name = f"{str(name).strip()} ({n})"
        taken.add(new_name.lower())
        seen.add(new_name.lower())
        bind.execute(
            sa.text("UPDATE interviewer_personas SET name = :name WHERE id = :id"),
            {"name": new_name, "id": persona_id},
        )


def upgrade() -> None:
    bind = op.get_bind()
    _dedupe_live_interviews(bind)
    _dedupe_default_checklists(bind)
    _dedupe_persona_names(bind)

    op.create_index(
        "uq_one_live_interview_per_candidate",
        "interview_sessions",
        ["candidate_session_id"],
        unique=True,
        sqlite_where=sa.text("status = 'in_progress'"),
        postgresql_where=sa.text("status = 'in_progress'"),
    )
    op.create_index(
        "uq_one_default_checklist_per_question",
        "checklists",
        ["question_id"],
        unique=True,
        sqlite_where=sa.text("is_default = 1"),
        postgresql_where=sa.text("is_default = true"),
    )
    # An expression index; trim() and lower() are spelled the same in SQLite and PostgreSQL.
    op.execute("CREATE UNIQUE INDEX uq_persona_name_ci ON interviewer_personas (lower(trim(name)))")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_persona_name_ci")
    op.drop_index("uq_one_default_checklist_per_question", table_name="checklists")
    op.drop_index("uq_one_live_interview_per_candidate", table_name="interview_sessions")
