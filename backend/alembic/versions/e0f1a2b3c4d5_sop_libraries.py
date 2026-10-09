"""SOP libraries (spec-sop-libraries): ``sop_libraries``, and every document in exactly one.

The existing documents all go into one library with a fixed id (``DEFAULT_LIBRARY_ID``), named
generically here; the live one is renamed in the admin page (the public repo carries no client
names).

Revision ID: e0f1a2b3c4d5
Revises: d9e0f1a2b3c4
Create Date: 2026-10-09 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e0f1a2b3c4d5"
down_revision: str | None = "d9e0f1a2b3c4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Kept literal: a migration must not change when the model module does.
DEFAULT_LIBRARY_ID = "00000000-0000-4000-8000-000000000001"
DEFAULT_LIBRARY_NAME = "SOP library"


def upgrade() -> None:
    op.create_table(
        "sop_libraries",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("name", sa.String(length=255), nullable=False, unique=True),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.execute(
        sa.text(
            "INSERT INTO sop_libraries (id, name, description) VALUES (:id, :name, '')"
        ).bindparams(id=DEFAULT_LIBRARY_ID, name=DEFAULT_LIBRARY_NAME)
    )
    # The server default fills every existing row; the foreign key then holds from the start.
    column = sa.Column(
        "library_id", sa.String(length=36), nullable=False, server_default=DEFAULT_LIBRARY_ID
    )
    if op.get_bind().dialect.name == "sqlite":
        # SQLite cannot add a REFERENCES column with a non-NULL default, and a batch "move and
        # copy" of sop_documents fails as soon as a chunk points at a document (foreign keys
        # are on). So on SQLite (dev, tests run on create_all) the column is added plain; the
        # upload route checks the library exists and a library with documents is not deleted.
        op.add_column("sop_documents", column)
    else:
        op.add_column("sop_documents", column)
        op.create_foreign_key(
            "fk_sop_documents_library_id",
            "sop_documents",
            "sop_libraries",
            ["library_id"],
            ["id"],
        )
    op.create_index("ix_sop_documents_library_id", "sop_documents", ["library_id"])


def downgrade() -> None:
    op.drop_index("ix_sop_documents_library_id", table_name="sop_documents")
    if op.get_bind().dialect.name == "sqlite":
        op.drop_column("sop_documents", "library_id")
    else:
        op.drop_constraint("fk_sop_documents_library_id", "sop_documents", type_="foreignkey")
        op.drop_column("sop_documents", "library_id")
    op.drop_table("sop_libraries")
