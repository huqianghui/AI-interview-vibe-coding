"""default language en-US (persona/user/bank/question) + backfill existing rows

Flip the app-wide default interview language from zh-CN to en-US. The ORM/Pydantic defaults are
changed in the models; this migration (a) moves the one column that carries a DB-level
``server_default`` — ``interviewer_personas.default_locale`` — to ``en-US`` so bare INSERTs also
default to English, and (b) backfills every existing row that still holds the old ``zh-CN`` default
across personas, users, question banks, and questions so stored data matches the new default.

Backfill is intentionally scoped to rows equal to the OLD default (``WHERE ... = 'zh-CN'``): a row
an operator deliberately set to some other locale is left untouched, and a row already ``en-US`` is
a no-op. The demo question bank's content was already English prose mis-tagged ``zh-CN``, so this
also corrects that language/content mismatch.

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-09-01 10:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "d4e5f6a7b8c9"
down_revision: str | None = "c3d4e5f6a7b8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # (a) DB-level default for the only column that has a server_default. SQLite has no
    # ``ALTER COLUMN ... SET DEFAULT``, so this goes through Alembic's batch mode (table copy).
    with op.batch_alter_table("interviewer_personas") as batch_op:
        batch_op.alter_column("default_locale", server_default="en-US")
    # (b) Backfill existing rows still on the old zh-CN default → en-US. Scoped to = old default so
    # a deliberately-chosen non-zh-CN locale is preserved; already-en-US rows are a no-op.
    op.execute(
        "UPDATE interviewer_personas SET default_locale = 'en-US' WHERE default_locale = 'zh-CN'"
    )
    op.execute("UPDATE users SET preferred_language = 'en-US' WHERE preferred_language = 'zh-CN'")
    op.execute("UPDATE question_banks SET language = 'en-US' WHERE language = 'zh-CN'")
    op.execute("UPDATE questions SET language = 'en-US' WHERE language = 'zh-CN'")


def downgrade() -> None:
    # Restore only the DB-level default; the data backfill is not reversed (there's no record of
    # which rows were zh-CN before, and en-US is the desired end state either way).
    with op.batch_alter_table("interviewer_personas") as batch_op:
        batch_op.alter_column("default_locale", server_default="zh-CN")
