"""The version migrations on a real migration chain, not create_all.

e2f3a4b5c6d7 (rubric versions) then f3a4b5c6d7e8 (bank versions: questions + rubric). They run at
container boot against the live database, so the backfill is checked here: version 1 for the bank,
the assigned user pinned to it, the rewritten content carrying the questions, the hash matching
what the service computes (so publishing an unchanged bank after the upgrade mints nothing), and a
clean downgrade.
"""

import asyncio
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]


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
def test_upgrade_backfills_version_one_with_questions_and_downgrade_removes_it(tmp_path):
    db = tmp_path / "mig.db"
    _alembic(db, "upgrade", "d8e9f0a1b2c3")
    conn = sqlite3.connect(db)
    now = "CURRENT_TIMESTAMP"
    conn.executescript(
        f"""
        INSERT INTO question_banks (id, name, description, language, is_default, enabled,
            created_at, updated_at) VALUES ('b1', 'Bank', '', 'en-US', 1, 1, {now}, {now});
        INSERT INTO questions (id, bank_id, text, language, weight, expected_points,
            max_follow_ups, follow_up_prompt, enabled, order_index, created_at, updated_at)
            VALUES ('q1', 'b1', 'Q?', 'en-US', 1, '[]', 0, '', 1, 0, {now}, {now});
        INSERT INTO checklists (id, question_id, prompt_version, is_default, created_at, updated_at)
            VALUES ('c1', 'q1', 'v1', 1, {now}, {now});
        INSERT INTO checklist_items (id, checklist_id, kind, text, weight, advisory, source_quote,
            source_document_id, source_page, order_index, created_at, updated_at)
            VALUES ('i1', 'c1', 'required', 'Item', 100, 0, 'quote', NULL, '4.2', 0, {now}, {now}),
                   ('i2', 'c1', 'forbidden', 'Adv', 0, 1, '', NULL, NULL, 1, {now}, {now});
        INSERT INTO users (id, username, email, hashed_password, full_name, role, is_active,
            preferred_language, business_unit, assigned_bank_id, created_at, updated_at)
            VALUES ('u1', 'cand', 'c@local', 'x', '', 'user', 1, 'en-US', '', 'b1', {now}, {now});
        """
    )
    conn.commit()
    conn.close()

    _alembic(db, "upgrade", "f3a4b5c6d7e8")
    conn = sqlite3.connect(db)
    version_id, version_no, reason, content_hash, bank_name, content = conn.execute(
        "SELECT id, version_no, reason, content_hash, bank_name, content_json FROM bank_versions"
        " WHERE bank_id = 'b1'"
    ).fetchone()
    assert (version_no, reason, bank_name) == (1, "initial", "Bank")
    (question,) = json.loads(content)["questions"]
    assert (question["id"], question["text"], len(question["rubric"])) == ("q1", "Q?", 2)
    assigned = conn.execute("SELECT assigned_bank_version_id FROM users WHERE id='u1'").fetchone()
    assert assigned == (version_id,)
    conn.close()

    # The service must hash the same rubric to the same value, or the first save after the upgrade
    # would mint a version for a rubric nobody changed.
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.db import make_engine
    from app.services import bank_version_service

    async def _service_hash() -> str:
        engine = make_engine(f"sqlite+aiosqlite:///{db}")
        try:
            async with async_sessionmaker(engine, expire_on_commit=False)() as session:
                return bank_version_service._hash(
                    await bank_version_service.draft_content(session, "b1")
                )
        finally:
            await engine.dispose()

    assert asyncio.run(_service_hash()) == content_hash

    _alembic(db, "downgrade", "e2f3a4b5c6d7")
    conn = sqlite3.connect(db)
    (rubric_only,) = conn.execute("SELECT content_json FROM rubric_versions").fetchone()
    assert list(json.loads(rubric_only)["questions"]) == ["q1"]
    conn.close()
    _alembic(db, "downgrade", "d8e9f0a1b2c3")
    conn = sqlite3.connect(db)
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "rubric_versions" not in tables and "bank_versions" not in tables
    user_cols = {r[1] for r in conn.execute("PRAGMA table_info(users)")}
    assert "assigned_rubric_version_id" not in user_cols
    conn.close()
