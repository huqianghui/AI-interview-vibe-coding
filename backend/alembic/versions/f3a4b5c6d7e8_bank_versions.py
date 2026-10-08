"""bank versions: a version is the whole bank (questions + rubric), not the rubric alone.

Spec: docs/planning/spec-bank-versioning.md (supersedes spec-rubric-versioning, v0.52.0.0).

- ``rubric_versions`` → ``bank_versions``; ``users.assigned_rubric_version_id`` →
  ``assigned_bank_version_id``; ``interview_sessions.rubric_version_id`` → ``bank_version_id``.
- New ``bank_versions.bank_name`` (a version reads on its own once its bank is logically deleted).
- The bank foreign key becomes RESTRICT (was CASCADE): banks are only ever logically deleted.
- Every existing version is rewritten in the new shape. A bank's LATEST version is rebuilt from
  the bank's current questions + rubric: v0.52.0.0 minted a version on every rubric change, so the
  latest one's rubric IS the current rubric, and the question rows were never versioned, so the
  current ones are the only record of them. Older versions keep their own frozen rubric and take
  the current question rows where those still exist.

The content and hash built here must match ``bank_version_service.draft_content`` / ``_hash``, so
the first publish after the upgrade, of an unchanged bank, mints no version.

Revision ID: f3a4b5c6d7e8
Revises: e2f3a4b5c6d7
Create Date: 2026-10-08 18:00:00.000000
"""

import hashlib
import json
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f3a4b5c6d7e8"
down_revision: str | None = "e2f3a4b5c6d7"
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

_RENAMES = (
    ("users", "assigned_rubric_version_id", "assigned_bank_version_id"),
    ("interview_sessions", "rubric_version_id", "bank_version_id"),
)


def _points(raw) -> list[str]:
    try:
        parsed = json.loads(raw) if raw else []
    except (ValueError, TypeError):
        return []
    return [str(p) for p in parsed] if isinstance(parsed, list) else []


def _question_dict(row, bank_language: str, rubric: list[dict]) -> dict:
    return {
        "id": row["id"],
        "text": row["text"],
        "language": row["language"] or bank_language,
        "order_index": int(row["order_index"]),
        "enabled": bool(row["enabled"]),
        "weight": int(row["weight"]),
        "expected_points": _points(row["expected_points"]),
        "max_follow_ups": int(row["max_follow_ups"]),
        "follow_up_prompt": row["follow_up_prompt"],
        "rubric": rubric,
    }


def _doc_names(bind) -> dict[str, str]:
    return {r[0]: r[1] for r in bind.execute(sa.text("SELECT id, name FROM sop_documents"))}


def _item(row, names: dict[str, str]) -> dict:
    item = {f: row[f] for f in _ITEM_FIELDS}
    item.update(
        weight=int(row["weight"]),
        advisory=bool(row["advisory"]),
        order_index=int(row["order_index"]),
        source_document_name=names.get(row["source_document_id"] or ""),
    )
    return item


def _draft_content(bind, bank_id: str, bank_language: str, names: dict[str, str]) -> dict:
    questions = bind.execute(
        sa.text("SELECT * FROM questions WHERE bank_id = :b ORDER BY order_index, id"),
        {"b": bank_id},
    ).mappings()
    out = []
    for q in list(questions):
        checklist_id = bind.execute(
            sa.text(
                "SELECT id FROM checklists WHERE question_id = :q AND is_default = :t "
                "ORDER BY created_at DESC LIMIT 1"
            ),
            {"q": q["id"], "t": True},
        ).scalar()
        rubric = []
        if checklist_id is not None:
            rows = bind.execute(
                sa.text(
                    f"SELECT {', '.join(_ITEM_FIELDS)} FROM checklist_items "
                    "WHERE checklist_id = :c ORDER BY order_index, id"
                ),
                {"c": checklist_id},
            ).mappings()
            rubric = [_item(r, names) for r in rows]
        out.append(_question_dict(q, bank_language, rubric))
    return {"questions": out}


def _hash(content: dict) -> str:
    stripped = [
        {**q, "rubric": [{k: v for k, v in it.items() if k != "id"} for it in q["rubric"]]}
        for q in content["questions"]
    ]
    key = json.dumps(stripped, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def _rewrite_versions(bind) -> None:
    names = _doc_names(bind)
    banks = bind.execute(sa.text("SELECT id, name, language FROM question_banks")).mappings()
    for bank in list(banks):
        language = bank["language"] or "en-US"
        versions = bind.execute(
            sa.text(
                "SELECT id, content_json FROM bank_versions WHERE bank_id = :b "
                "ORDER BY version_no DESC"
            ),
            {"b": bank["id"]},
        ).mappings()
        rows = {
            q["id"]: q
            for q in bind.execute(
                sa.text("SELECT * FROM questions WHERE bank_id = :b"), {"b": bank["id"]}
            ).mappings()
        }
        for i, version in enumerate(list(versions)):
            if i == 0:
                content = _draft_content(bind, bank["id"], language, names)
            else:
                # An older rubric-only version: keep its frozen rubric, take today's question row.
                frozen = json.loads(version["content_json"]).get("questions", {})
                content = {
                    "questions": sorted(
                        (
                            _question_dict(rows[qid], language, items)
                            if qid in rows
                            else {
                                "id": qid,
                                "text": "",
                                "language": language,
                                "order_index": 0,
                                "enabled": False,
                                "weight": 1,
                                "expected_points": [],
                                "max_follow_ups": 0,
                                "follow_up_prompt": "",
                                "rubric": items,
                            }
                            for qid, items in frozen.items()
                        ),
                        key=lambda q: (q["order_index"], q["id"]),
                    )
                }
            bind.execute(
                sa.text(
                    "UPDATE bank_versions SET content_json = :c, content_hash = :h, "
                    "bank_name = :n WHERE id = :v"
                ),
                {
                    "c": json.dumps(content, ensure_ascii=False, default=str),
                    "h": _hash(content),
                    "n": bank["name"],
                    "v": version["id"],
                },
            )


def upgrade() -> None:
    bind = op.get_bind()
    postgres = bind.dialect.name == "postgresql"
    op.rename_table("rubric_versions", "bank_versions")
    op.add_column(
        "bank_versions",
        sa.Column("bank_name", sa.String(length=255), nullable=False, server_default=""),
    )
    for table, old, new in _RENAMES:
        op.execute(f"ALTER TABLE {table} RENAME COLUMN {old} TO {new}")
    if postgres:
        op.execute("ALTER INDEX ix_rubric_versions_bank_id RENAME TO ix_bank_versions_bank_id")
        op.execute(
            "ALTER TABLE bank_versions RENAME CONSTRAINT uq_rubric_version_bank_no "
            "TO uq_bank_version_bank_no"
        )
        for table, old, new in _RENAMES:
            op.execute(
                f"ALTER TABLE {table} RENAME CONSTRAINT fk_{table}_{old} TO fk_{table}_{new}"
            )
        # The bank FK was created inline (auto-named) with ON DELETE CASCADE; make it RESTRICT.
        fk = bind.execute(
            sa.text(
                "SELECT conname FROM pg_constraint WHERE conrelid = 'bank_versions'::regclass "
                "AND contype = 'f' AND confrelid = 'question_banks'::regclass"
            )
        ).scalar()
        if fk:
            op.drop_constraint(fk, "bank_versions", type_="foreignkey")
        op.create_foreign_key(
            "fk_bank_versions_bank_id",
            "bank_versions",
            "question_banks",
            ["bank_id"],
            ["id"],
            ondelete="RESTRICT",
        )
    else:
        # SQLite (dev only): indexes rename by drop + create; the FK's ON DELETE cannot change
        # without a table rebuild, and nothing in the app deletes a bank.
        op.drop_index("ix_rubric_versions_bank_id", table_name="bank_versions")
        op.create_index("ix_bank_versions_bank_id", "bank_versions", ["bank_id"])
    _rewrite_versions(bind)


def downgrade() -> None:
    bind = op.get_bind()
    postgres = bind.dialect.name == "postgresql"
    # Back to the rubric-only shape: {"questions": {question_id: [item, ...]}}.
    for version in list(bind.execute(sa.text("SELECT id, content_json FROM bank_versions"))):
        questions = json.loads(version[1]).get("questions", [])
        rubric_only = {
            "questions": {
                q["id"]: [{f: it.get(f) for f in _ITEM_FIELDS} for it in q["rubric"]]
                for q in questions
                if q["rubric"]
            }
        }
        bind.execute(
            sa.text("UPDATE bank_versions SET content_json = :c WHERE id = :v"),
            {"c": json.dumps(rubric_only, ensure_ascii=False), "v": version[0]},
        )
    if postgres:
        op.drop_constraint("fk_bank_versions_bank_id", "bank_versions", type_="foreignkey")
        op.create_foreign_key(
            None, "bank_versions", "question_banks", ["bank_id"], ["id"], ondelete="CASCADE"
        )
        for table, old, new in _RENAMES:
            op.execute(
                f"ALTER TABLE {table} RENAME CONSTRAINT fk_{table}_{new} TO fk_{table}_{old}"
            )
        op.execute(
            "ALTER TABLE bank_versions RENAME CONSTRAINT uq_bank_version_bank_no "
            "TO uq_rubric_version_bank_no"
        )
        op.execute("ALTER INDEX ix_bank_versions_bank_id RENAME TO ix_rubric_versions_bank_id")
    else:
        op.drop_index("ix_bank_versions_bank_id", table_name="bank_versions")
        op.create_index("ix_rubric_versions_bank_id", "bank_versions", ["bank_id"])
    for table, old, new in _RENAMES:
        op.execute(f"ALTER TABLE {table} RENAME COLUMN {new} TO {old}")
    op.execute("ALTER TABLE bank_versions DROP COLUMN bank_name")
    op.rename_table("bank_versions", "rubric_versions")
