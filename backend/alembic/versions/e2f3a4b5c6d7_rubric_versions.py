"""rubric versions: immutable copies of a bank's rubric, pinned per user and per interview.

Spec: docs/planning/spec-rubric-versioning.md.

- ``rubric_versions``: one row per frozen copy of a bank's whole rubric (``content_json``).
- ``users.assigned_rubric_version_id`` and ``interview_sessions.rubric_version_id``: SET NULL FKs.
- Backfill: every bank gets version 1 (``reason='initial'``), and every user
  assigned that bank is assigned it. Existing interviews stay unpinned on purpose: they were scored
  against whatever the rubric was then, which is not recorded anywhere, so they keep reading the
  current default checklist exactly as before.

The content and hash built here must match ``rubric_version_service`` (``_bank_content`` and
``_content_key``), so the first editor save after the upgrade with no change mints no version.

Revision ID: e2f3a4b5c6d7
Revises: d8e9f0a1b2c3
Create Date: 2026-10-08 12:00:00.000000
"""

import hashlib
import json
import uuid
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e2f3a4b5c6d7"
down_revision: str | None = "d8e9f0a1b2c3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_ITEM_FIELDS = (
    "id",
    "kind",
    "text",
    "weight",
    "advisory",
    "source_quote",
    "source_document_id",
    "source_page",
    "order_index",
)

_FKS = (
    ("users", "assigned_rubric_version_id"),
    ("interview_sessions", "rubric_version_id"),
)


def _bank_content(bind, bank_id: str) -> dict:
    questions: dict[str, list[dict]] = {}
    qids = bind.execute(
        sa.text("SELECT id FROM questions WHERE bank_id = :b ORDER BY id"), {"b": bank_id}
    ).scalars()
    for qid in list(qids):
        checklist_id = bind.execute(
            sa.text(
                "SELECT id FROM checklists WHERE question_id = :q AND is_default = :t "
                "ORDER BY created_at DESC LIMIT 1"
            ),
            {"q": qid, "t": True},
        ).scalar()
        if checklist_id is None:
            continue
        rows = bind.execute(
            sa.text(
                f"SELECT {', '.join(_ITEM_FIELDS)} FROM checklist_items "
                "WHERE checklist_id = :c ORDER BY order_index"
            ),
            {"c": checklist_id},
        ).mappings()
        items = [
            {
                **{f: r[f] for f in _ITEM_FIELDS},
                "weight": int(r["weight"]),
                "advisory": bool(r["advisory"]),
                "order_index": int(r["order_index"]),
            }
            for r in rows
        ]
        if items:
            questions[qid] = items
    return {"questions": questions}


def _content_hash(content: dict) -> str:
    stripped = {
        qid: [{k: v for k, v in it.items() if k != "id"} for it in items]
        for qid, items in content["questions"].items()
    }
    key = json.dumps(stripped, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def upgrade() -> None:
    op.create_table(
        "rubric_versions",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "bank_id",
            sa.String(length=36),
            sa.ForeignKey("question_banks.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("version_no", sa.Integer(), nullable=False),
        sa.Column("content_json", sa.Text(), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("reason", sa.String(length=16), nullable=False, server_default="edit"),
        sa.Column("created_by", sa.String(length=36), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
        sa.UniqueConstraint("bank_id", "version_no", name="uq_rubric_version_bank_no"),
    )
    op.create_index("ix_rubric_versions_bank_id", "rubric_versions", ["bank_id"])
    bind = op.get_bind()
    sqlite = bind.dialect.name == "sqlite"
    for table, column in _FKS:
        op.add_column(table, sa.Column(column, sa.String(length=36), nullable=True))
        # SQLite (dev only) cannot add a constraint without rebuilding the table, and rebuilding
        # interview_sessions with foreign keys enforced fails because interview_turns references
        # it. The column is enough there; PostgreSQL gets the real SET NULL foreign key.
        if not sqlite:
            op.create_foreign_key(
                f"fk_{table}_{column}",
                table,
                "rubric_versions",
                [column],
                ["id"],
                ondelete="SET NULL",
            )

    versions = sa.table(
        "rubric_versions",
        sa.column("id", sa.String),
        sa.column("bank_id", sa.String),
        sa.column("version_no", sa.Integer),
        sa.column("content_json", sa.Text),
        sa.column("content_hash", sa.String),
        sa.column("reason", sa.String),
    )
    for bank_id in list(bind.execute(sa.text("SELECT id FROM question_banks")).scalars()):
        content = _bank_content(bind, bank_id)
        version_id = str(uuid.uuid4())
        bind.execute(
            versions.insert().values(
                id=version_id,
                bank_id=bank_id,
                version_no=1,
                content_json=json.dumps(content, ensure_ascii=False, default=str),
                content_hash=_content_hash(content),
                reason="initial",
            )
        )
        bind.execute(
            sa.text(
                "UPDATE users SET assigned_rubric_version_id = :v WHERE assigned_bank_id = :b"
            ),
            {"v": version_id, "b": bank_id},
        )


def downgrade() -> None:
    sqlite = op.get_bind().dialect.name == "sqlite"
    for table, column in reversed(_FKS):
        if not sqlite:
            op.drop_constraint(f"fk_{table}_{column}", table, type_="foreignkey")
        op.drop_column(table, column)
    op.drop_index("ix_rubric_versions_bank_id", table_name="rubric_versions")
    op.drop_table("rubric_versions")
