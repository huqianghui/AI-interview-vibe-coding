"""The unit-embeddings migration (c1d2e3f4a5b6) on a real migration chain, with data present."""

import sqlite3

import pytest

from tests.test_migrations_sop_libraries import BACKEND, _alembic


@pytest.mark.skipif(
    not (BACKEND / "alembic.ini").exists(), reason="alembic.ini missing (not a source checkout)"
)
def test_the_table_is_added_beside_existing_documents_and_removed_cleanly(tmp_path):
    db = tmp_path / "mig.db"
    _alembic(db, "upgrade", "f1a2b3c4d5e6")
    conn = sqlite3.connect(db)
    conn.execute(
        "INSERT INTO sop_documents (id, name, blob_path, content_type, size, status, version,"
        " markdown, markdown_source, markdown_error, markdown_converter_version, summary,"
        " summary_status, summary_error, library_id) VALUES ('d1', 'a.pdf', '', '', 0, 'chunked',"
        " 1, '', '', '', 0, '', '', '', '00000000-0000-4000-8000-000000000001')"
    )
    conn.commit()
    conn.close()
    _alembic(db, "upgrade", "c1d2e3f4a5b6")
    conn = sqlite3.connect(db)
    conn.execute(
        "INSERT INTO sop_unit_embeddings (id, document_id, unit_key, text_hash, model, vector)"
        " VALUES ('e1', 'd1', '1', 'h', 'm', '[0.1]')"
    )
    conn.commit()
    assert conn.execute("SELECT count(*) FROM sop_documents").fetchone() == (1,)
    conn.close()
    _alembic(db, "downgrade", "f1a2b3c4d5e6")
    conn = sqlite3.connect(db)
    tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    assert "sop_unit_embeddings" not in tables
    assert conn.execute("SELECT count(*) FROM sop_documents").fetchone() == (1,)
    conn.close()
