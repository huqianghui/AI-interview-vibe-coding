"""Split the voice-session model out of model_or_deployment (service_configs).

One ``model_or_deployment`` field fed four consumers whose legal values are NOT the same kind of
name: judge / scoring / the Foundry agent address models by DEPLOYMENT NAME in this resource, while
Voice Live MODEL mode accepts only models the service pre-deploys natively in the region. Saving an
own deployment therefore broke every voice session with "Model X is not supported in this region"
(measured: gpt-5.4-mini was a real agent chat deployment yet Voice Live rejected it).

``voice_model`` is backfilled from ``model_or_deployment`` so an upgraded install behaves EXACTLY as
before this migration; the admin page then flags the value if it is not in the region's probed list,
rather than silently switching the model under a running deployment.

Revision ID: b5c6d7e8f9a0
Revises: a3b4c5d6e7f8
Create Date: 2026-10-05 18:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b5c6d7e8f9a0"
down_revision: str | None = "a3b4c5d6e7f8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # server_default so the NOT NULL add succeeds on existing rows (same shape as the kb/ks add,
    # 562c9adccffb). "native" is the pre-split behaviour: path ① with a region-hosted model.
    op.add_column(
        "service_configs",
        sa.Column("voice_model", sa.String(length=100), nullable=False, server_default=""),
    )
    op.add_column(
        "service_configs",
        sa.Column(
            "voice_model_mode", sa.String(length=16), nullable=False, server_default="native"
        ),
    )
    op.add_column(
        "service_configs",
        sa.Column("voice_byom_profile", sa.String(length=64), nullable=False, server_default=""),
    )
    # Preserve the exact model every existing install was already using for voice.
    op.execute("UPDATE service_configs SET voice_model = model_or_deployment")


def downgrade() -> None:
    op.drop_column("service_configs", "voice_byom_profile")
    op.drop_column("service_configs", "voice_model_mode")
    op.drop_column("service_configs", "voice_model")
