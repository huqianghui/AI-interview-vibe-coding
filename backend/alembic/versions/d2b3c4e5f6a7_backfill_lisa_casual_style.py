"""backfill legacy lisa casual style to casual-sitting

Revision ID: d2b3c4e5f6a7
Revises: c1a2b3d4e5f6
Create Date: 2026-08-11 21:20:00.000000

The avatar-parity work changed Lisa's style slug from the old simplified "casual" to Azure's real
"casual-sitting" (the backend passes persona.style through to Voice Live verbatim, so the old value
now sends an invalid slug). Personas persisted before that change still hold style="casual" for
Lisa and would silently render the wrong/absent pose. Backfill them to the valid slug. Idempotent:
only rows with the exact legacy (character="lisa", style="casual") pair are touched.
"""

from collections.abc import Sequence

from alembic import op


revision: str = "d2b3c4e5f6a7"
down_revision: str | None = "c1a2b3d4e5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "UPDATE interviewer_personas SET style = 'casual-sitting' "
        "WHERE character = 'lisa' AND style = 'casual'"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE interviewer_personas SET style = 'casual' "
        "WHERE character = 'lisa' AND style = 'casual-sitting'"
    )
