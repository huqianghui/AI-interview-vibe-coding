"""persona external_reader_prompt: the EXTERNAL-mode reader prompt (independent of prompt_fragment)

Give the interviewer persona a second, independent prompt config item. ``prompt_fragment`` remains
the BANK-mode interviewer prompt (→ Foundry agent ``instructions``); this NEW column is the
EXTERNAL-mode reader prompt that shapes how the pure "mouth" reads each turn's injected
``speech_text`` (delivered as a connect-time system item — see
``app.services.voice_live_proxy.build_reader_prompt_item``).

Owner's decisive constraint: once both exist they are TWO independent config items, never one field
the ``interview_brain`` toggle swaps — switching brain back and forth must never destroy the other's
content. So this is a purely additive, dormant column.

NULLABLE with NO backfill on purpose: ``NULL`` is the intended "unset, use the generated default"
sentinel (``default_external_reader_prompt(name)``), surfaced as the editor placeholder. Unlike the
en-US language backfill (which changed existing behavior), this adds a dormant column that no
existing row needs a value for.

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
Create Date: 2026-09-11 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f6a7b8c9d0e1"
down_revision: str | None = "e5f6a7b8c9d0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Additive, dormant, nullable — NULL means "use default_external_reader_prompt(name)". No
    # server_default and no backfill: existing personas stay NULL and fall back to the default.
    op.add_column(
        "interviewer_personas",
        sa.Column("external_reader_prompt", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("interviewer_personas", "external_reader_prompt")
