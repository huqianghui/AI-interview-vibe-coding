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
            "SELECT created_at, updated_at, applied FROM judge_events WHERE id='e1'"
        ).fetchone()
        assert row[0] is not None and row[1] is not None
        assert row[2] == 0  # applied defaults to false (speculative prefetch, D17)
        # The other PR-2 columns exist with their server defaults.
        cols = {r[1]: r for r in conn.execute("PRAGMA table_info(interviewer_personas)")}
        assert cols["judge_silence_seconds"][4] == "2"
        assert cols["judge_max_calls_per_question"][4] == "2"
        scols = {r[1]: r for r in conn.execute("PRAGMA table_info(interview_sessions)")}
        assert scols["turn_mode"][4].strip("'") == "linear"

        # The voice-model split (b5c6d7e8f9a0): three NOT NULL columns with server defaults, so the
        # add succeeds on existing rows, plus the backfill that keeps an upgraded install on exactly
        # the model it was already using for voice. conftest builds the suite's schema with
        # create_all, so this subprocess run is the ONLY place a wrong migration would show up.
        ccols = {r[1]: r for r in conn.execute("PRAGMA table_info(service_configs)")}
        for name in ("voice_model", "voice_model_mode", "voice_byom_profile"):
            assert name in ccols, f"{name} missing from the migrated schema"
            assert ccols[name][3] == 1, f"{name} must be NOT NULL like every other column here"
        assert ccols["voice_model_mode"][4].strip("'") == "native"
        conn.execute(
            "INSERT INTO service_configs (id, service_name, display_name, endpoint,"
            " api_key_encrypted, model_or_deployment, default_project, knowledge_base,"
            " knowledge_source, is_master, is_active, updated_by, created_at, updated_at)"
            " VALUES ('c1', 'ai_foundry', 'Azure AI Foundry', 'https://x.services.ai.azure.com',"
            " '', 'my-own-deployment', 'p', '', '', 1, 1, 'admin', CURRENT_TIMESTAMP,"
            " CURRENT_TIMESTAMP)"
        )
        srow = conn.execute(
            "SELECT voice_model, voice_model_mode, voice_byom_profile FROM service_configs"
            " WHERE id='c1'"
        ).fetchone()
        assert srow == ("", "native", "")
    finally:
        conn.close()


def _has_columns(conn: sqlite3.Connection, table: str, names: set[str]) -> bool:
    have = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
    return names <= have


@pytest.mark.skipif(
    not (BACKEND / "alembic.ini").exists(), reason="alembic.ini missing (not a source checkout)"
)
def test_concurrency_constraints_migration_resolves_existing_duplicates(tmp_path):
    """d8e9f0a1b2c3 adds three unique indexes; old data that already breaks them (possible while
    the app only checked in Python) must be resolved first, or the upgrade fails on a client DB."""
    db = tmp_path / "dup.db"
    env = dict(os.environ)
    env.update(
        {
            "DATABASE_URL": f"sqlite+aiosqlite:///{db}",
            "SECRET_KEY": "test-secret-key-do-not-use-in-prod",
            "ENCRYPTION_KEY": "v_ftieq-S7JwF27OzZw7kUFzULt1FF_rY2vn0jEkfYQ=",
        }
    )

    def alembic(*args):
        run = subprocess.run(
            [sys.executable, "-m", "alembic", *args],
            cwd=BACKEND,
            env=env,
            capture_output=True,
            text=True,
            timeout=180,
        )
        assert run.returncode == 0, run.stderr[-2000:]

    alembic("upgrade", "c7d8e9f0a1b2")  # the revision before the constraints
    conn = sqlite3.connect(db)

    def insert(table: str, **values) -> None:
        """Insert ``values``; every other NOT NULL column without a default gets a filler (0 or
        ''), so the test survives columns added by later migrations."""
        for _cid, col, ctype, notnull, default, _pk in conn.execute(f"PRAGMA table_info({table})"):
            if col not in values and notnull and default is None:
                numeric = any(t in ctype.upper() for t in ("INT", "BOOL", "FLOAT"))
                values[col] = 0 if numeric else ""
        cols = ", ".join(values)
        marks = ", ".join("?" for _ in values)
        conn.execute(f"INSERT INTO {table} ({cols}) VALUES ({marks})", tuple(values.values()))

    try:
        insert("interviewer_personas", id="p1", name="interview02", created_at="2026-10-01")
        insert("interviewer_personas", id="p2", name=" Interview02 ", created_at="2026-10-02")
        for sid, ts in (("old", "2026-10-01"), ("new", "2026-10-02")):
            insert(
                "interview_sessions",
                id=sid,
                candidate_session_id="c1",
                status="in_progress",
                created_at=ts,
            )
        insert("question_banks", id="b1", name="B")
        insert("questions", id="q1", bank_id="b1", text="Q?")
        for cid, ts in (("cl_old", "2026-10-01"), ("cl_new", "2026-10-02")):
            insert("checklists", id=cid, question_id="q1", is_default=1, created_at=ts)
        conn.commit()
    finally:
        conn.close()

    alembic("upgrade", "head")

    conn = sqlite3.connect(db)
    try:
        names = dict(conn.execute("SELECT id, name FROM interviewer_personas").fetchall())
        assert names["p1"] == "interview02"  # the older one keeps its name
        assert names["p2"] == "Interview02 (2)"
        status = dict(conn.execute("SELECT id, status FROM interview_sessions").fetchall())
        assert status == {"new": "in_progress", "old": "abandoned"}
        default = dict(conn.execute("SELECT id, is_default FROM checklists").fetchall())
        assert default == {"cl_new": 1, "cl_old": 0}
    finally:
        conn.close()
