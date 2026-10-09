"""A question bank is scoped to one SOP library (spec-sop-libraries §3): ``question_banks.sop_library_id``.

Null = the bank uses no SOP (general evaluation). Every bank whose draft rubric already cites an
SOP is bound to the library those documents are in (§8; on live that is the one default library),
the others stay unbound.

Revision ID: f1a2b3c4d5e6
Revises: e0f1a2b3c4d5
Create Date: 2026-10-09 15:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f1a2b3c4d5e6"
down_revision: str | None = "e0f1a2b3c4d5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    column = sa.Column("sop_library_id", sa.String(length=36), nullable=True)
    # SQLite: a plain column, never a "move and copy" of question_banks (its children would block
    # the drop with foreign keys on; see e0f1a2b3c4d5). PostgreSQL gets the foreign key.
    op.add_column("question_banks", column)
    if op.get_bind().dialect.name != "sqlite":
        op.create_foreign_key(
            "fk_question_banks_sop_library_id",
            "question_banks",
            "sop_libraries",
            ["sop_library_id"],
            ["id"],
        )
    # Bind each bank to the library of the first document its current (draft) rubric cites.
    op.execute(
        sa.text(
            """
            UPDATE question_banks SET sop_library_id = (
                SELECT d.library_id
                FROM questions q
                JOIN checklists c ON c.question_id = q.id
                JOIN checklist_items i ON i.checklist_id = c.id
                JOIN sop_documents d ON d.id = i.source_document_id
                WHERE q.bank_id = question_banks.id AND c.is_default = :current
                ORDER BY q.order_index, i.order_index
                LIMIT 1
            )
            """
        ).bindparams(sa.bindparam("current", True, type_=sa.Boolean()))
    )


def downgrade() -> None:
    if op.get_bind().dialect.name != "sqlite":
        op.drop_constraint("fk_question_banks_sop_library_id", "question_banks", type_="foreignkey")
    op.drop_column("question_banks", "sop_library_id")
