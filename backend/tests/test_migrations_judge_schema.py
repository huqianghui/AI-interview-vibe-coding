"""Migration-built schema guard (issue #114): the tables alembic creates must accept the ORM's
inserts — not just the create_all tables the rest of the suite runs on.

Live 2026-09-24 the first real ``POST /judge`` failed with ``NOT NULL constraint failed:
judge_events.created_at``: the ORM never sends the mixin's timestamp columns (it relies on the DB
default), create_all carries that default, the hand-written migration did not. This test runs the
real migration chain on a temp SQLite file in a subprocess (alembic reads ``DATABASE_URL`` via
settings) and inserts the way the app does."""

import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(
    not (BACKEND / "alembic.ini").exists(), reason="alembic.ini missing (not a source checkout)"
)
def test_alembic_head_schema_accepts_orm_style_inserts(tmp_path):
    db = tmp_path / "mig.db"
    env = dict(os.environ)
    env.update(
        {
            "DATABASE_URL": f"sqlite+aiosqlite:///{db}",
            "SECRET_KEY": "test-secret-key-do-not-use-in-prod",
            "ENCRYPTION_KEY": "v_ftieq-S7JwF27OzZw7kUFzULt1FF_rY2vn0jEkfYQ=",
        }
    )
    run = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=BACKEND,
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert run.returncode == 0, run.stderr[-2000:]

    conn = sqlite3.connect(db)
    try:
        # judge_events: the app inserts without created_at/updated_at — the DB must default them.
        conn.execute(
            "INSERT INTO interview_sessions (id, candidate_session_id, status, current_question_index,"  # noqa: E501
            " brain_mode, turn_mode, external_phase, turn_version, created_at, updated_at)"
            " VALUES ('s1', 'c1', 'in_progress', 0, 'bank', 'judged', NULL, 0,"
            " CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
        ) if _has_columns(
            conn, "interview_sessions", {"external_phase", "turn_version"}
        ) else conn.execute(
            "INSERT INTO interview_sessions (id, candidate_session_id, status, current_question_index,"  # noqa: E501
            " brain_mode, turn_mode, created_at, updated_at)"
            " VALUES ('s1', 'c1', 'in_progress', 0, 'bank', 'judged', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"  # noqa: E501
        )
        conn.execute(
            "INSERT INTO judge_events (id, interview_session_id, question_id, trigger, verdict,"
            " speech_text, reason, model, latency_ms) VALUES"
            " ('e1', 's1', 'q1', 'voice_silence', 'nudge', 'Please go on.', 'r', 'gpt', 1200)"
        )
        row = conn.execute(
            "SELECT created_at, updated_at FROM judge_events WHERE id='e1'"
        ).fetchone()
        assert row[0] is not None and row[1] is not None
        # The other PR-2 columns exist with their server defaults.
        cols = {r[1]: r for r in conn.execute("PRAGMA table_info(interviewer_personas)")}
        assert cols["judge_silence_seconds"][4] == "2"
        assert cols["judge_max_calls_per_question"][4] == "2"
        scols = {r[1]: r for r in conn.execute("PRAGMA table_info(interview_sessions)")}
        assert scols["turn_mode"][4].strip("'") == "linear"
    finally:
        conn.close()


def _has_columns(conn: sqlite3.Connection, table: str, names: set[str]) -> bool:
    have = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
    return names <= have
