"""f1a2b3c4d5e6 on a real migration chain: a bank whose rubric cites an SOP is bound to that SOP's
library, a bank that cites none stays unbound, and the downgrade is clean."""

import sqlite3

import pytest

from tests.test_migrations_sop_libraries import BACKEND, DEFAULT_LIBRARY_ID, _alembic


@pytest.mark.skipif(
    not (BACKEND / "alembic.ini").exists(), reason="alembic.ini missing (not a source checkout)"
)
def test_banks_that_cite_an_sop_are_bound_to_its_library(tmp_path):
    db = tmp_path / "mig.db"
    _alembic(db, "upgrade", "e0f1a2b3c4d5")
    conn = sqlite3.connect(db)
    now = "CURRENT_TIMESTAMP"
    conn.executescript(
        f"""
        INSERT INTO sop_documents (id, name, blob_path, content_type, size, status, version,
            markdown, markdown_source, markdown_error, markdown_converter_version, summary,
            summary_status, summary_error, library_id)
            VALUES ('d1', 'a.pdf', '', '', 0, 'chunked', 1, '', '', '', 0, '', '', '',
                    '{DEFAULT_LIBRARY_ID}');
        INSERT INTO question_banks (id, name, description, language, is_default, enabled,
            created_at, updated_at) VALUES
            ('cited', 'Cited', '', 'en-US', 0, 1, {now}, {now}),
            ('plain', 'Plain', '', 'en-US', 0, 1, {now}, {now});
        INSERT INTO questions (id, bank_id, text, language, weight, expected_points,
            max_follow_ups, follow_up_prompt, enabled, order_index, created_at, updated_at)
            VALUES ('q1', 'cited', 'Q?', 'en-US', 1, '[]', 0, '', 1, 0, {now}, {now}),
                   ('q2', 'plain', 'Q?', 'en-US', 1, '[]', 0, '', 1, 0, {now}, {now});
        INSERT INTO checklists (id, question_id, prompt_version, is_default, created_at, updated_at)
            VALUES ('c1', 'q1', 'v1', 1, {now}, {now}), ('c2', 'q2', 'v1', 1, {now}, {now});
        """
    )
    cols = [r[1] for r in conn.execute("PRAGMA table_info(checklist_items)")]
    base = {
        "checklist_id": None,
        "kind": "required",
        "text": "x",
        "weight": 100,
        "source_quote": "",
        "order_index": 0,
    }
    for item_id, checklist, doc in (("i1", "c1", "d1"), ("i2", "c2", None)):
        row = {**base, "id": item_id, "checklist_id": checklist, "source_document_id": doc}
        for optional, value in (
            ("advisory", 0),
            ("source_refs", "[]"),
            ("created_at", "2026-10-09 00:00:00"),
            ("updated_at", "2026-10-09 00:00:00"),
        ):
            if optional in cols:
                row[optional] = value
        row = {k: v for k, v in row.items() if k in cols}
        conn.execute(
            f"INSERT INTO checklist_items ({', '.join(row)}) VALUES ({', '.join('?' * len(row))})",
            list(row.values()),
        )
    conn.commit()
    conn.close()

    _alembic(db, "upgrade", "f1a2b3c4d5e6")
    conn = sqlite3.connect(db)
    bound = dict(conn.execute("SELECT id, sop_library_id FROM question_banks").fetchall())
    assert bound == {"cited": DEFAULT_LIBRARY_ID, "plain": None}
    conn.close()

    _alembic(db, "downgrade", "e0f1a2b3c4d5")
    conn = sqlite3.connect(db)
    assert "sop_library_id" not in [r[1] for r in conn.execute("PRAGMA table_info(question_banks)")]
    conn.close()
