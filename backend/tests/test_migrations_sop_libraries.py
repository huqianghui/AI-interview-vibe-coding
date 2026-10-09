"""The SOP-library migration (e0f1a2b3c4d5) on a real migration chain, not create_all.

It runs at container boot against databases that already hold documents, chunks and sections.
A first version rebuilt ``sop_documents`` on SQLite and failed as soon as one chunk pointed at a
document (foreign keys are on), leaving the schema half-migrated (adversarial review, 2026-10-09).
"""

import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
DEFAULT_LIBRARY_ID = "00000000-0000-4000-8000-000000000001"


def _alembic(db: Path, *args: str) -> None:
    env = dict(os.environ)
    env.update(
        {
            "DATABASE_URL": f"sqlite+aiosqlite:///{db}",
            "SECRET_KEY": "test-secret-key-do-not-use-in-prod",
            "ENCRYPTION_KEY": "v_ftieq-S7JwF27OzZw7kUFzULt1FF_rY2vn0jEkfYQ=",
        }
    )
    run = subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        cwd=BACKEND,
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert run.returncode == 0, run.stderr[-2000:]


@pytest.mark.skipif(
    not (BACKEND / "alembic.ini").exists(), reason="alembic.ini missing (not a source checkout)"
)
def test_existing_documents_with_chunks_join_the_default_library_and_downgrade_is_clean(tmp_path):
    db = tmp_path / "mig.db"
    _alembic(db, "upgrade", "d9e0f1a2b3c4")
    conn = sqlite3.connect(db)
    conn.executescript(
        """
        INSERT INTO sop_documents (id, name, blob_path, content_type, size, status, version,
            markdown, markdown_source, markdown_error, markdown_converter_version, summary,
            summary_status, summary_error)
            VALUES ('d1', 'a.pdf', '', '', 0, 'chunked', 1, '', '', '', 0, '', '', '');
        INSERT INTO sop_chunks (id, document_id, chunk_index, content, token_count)
            VALUES ('c1', 'd1', 0, 'x', 1);
        """
    )
    conn.commit()
    conn.close()

    _alembic(db, "upgrade", "e0f1a2b3c4d5")
    conn = sqlite3.connect(db)
    assert conn.execute("SELECT library_id FROM sop_documents").fetchall() == [
        (DEFAULT_LIBRARY_ID,)
    ]
    assert conn.execute("SELECT id, name FROM sop_libraries").fetchall() == [
        (DEFAULT_LIBRARY_ID, "SOP library")
    ]
    assert conn.execute("SELECT count(*) FROM sop_chunks").fetchone() == (1,)  # nothing lost
    conn.close()

    _alembic(db, "downgrade", "d9e0f1a2b3c4")
    conn = sqlite3.connect(db)
    columns = [r[1] for r in conn.execute("PRAGMA table_info(sop_documents)")]
    assert "library_id" not in columns
    assert conn.execute("SELECT count(*) FROM sop_chunks").fetchone() == (1,)
    tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    assert "sop_libraries" not in tables
    conn.close()
