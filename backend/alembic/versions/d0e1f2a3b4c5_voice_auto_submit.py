"""persona voice auto-submit: admin-controlled silence window, one independent pair per engine

Adds four columns to ``interviewer_personas`` — an (enabled, silence_seconds) pair for each
interview engine:

* ``bank_auto_submit_enabled`` (bool, default 0) / ``bank_auto_submit_silence_seconds`` (int, 3)
* ``external_auto_submit_enabled`` (bool, default 1) / ``external_auto_submit_silence_seconds`` (3)

Before this the frontend hardcoded a 3s silence auto-commit for external-brain voice sessions and
bank sessions had none. Owner directives (2026-09-23): the window fired while candidates were still
THINKING, so bank mode ships OFF by default (the turn advances only on the explicit "I'm done"
click) while the external interview API keeps its hands-free default (ON, 3s); both the switch and
the window are admin-controlled per persona; and the two engines are SEPARATE config items that
never share or overwrite each other (same rule as prompt_fragment vs external_reader_prompt).
Existing personas get exactly today's behaviour via the server defaults.

Revision ID: d0e1f2a3b4c5
Revises: c9d0e1f2a3b4
Create Date: 2026-09-23 18:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d0e1f2a3b4c5"
down_revision: str | None = "c9d0e1f2a3b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_COLUMNS = (
    ("bank_auto_submit_enabled", sa.Boolean(), "0"),
    ("bank_auto_submit_silence_seconds", sa.Integer(), "3"),
    ("external_auto_submit_enabled", sa.Boolean(), "1"),
    ("external_auto_submit_silence_seconds", sa.Integer(), "3"),
)


def upgrade() -> None:
    with op.batch_alter_table("interviewer_personas") as batch:
        for name, type_, default in _COLUMNS:
            batch.add_column(
                sa.Column(name, type_, nullable=False, server_default=sa.text(default))
            )


def downgrade() -> None:
    with op.batch_alter_table("interviewer_personas") as batch:
        for name, _type, _default in reversed(_COLUMNS):
            batch.drop_column(name)
