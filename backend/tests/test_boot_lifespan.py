"""App boot (``app.main.lifespan``): the seeds run, a failing one is logged and skipped, and the
background warm-ups are cancelled on shutdown.

The server's SQLite is ephemeral, so boot is when banks, accounts and the default persona come to
exist at all. These run the REAL seeds against an in-memory DB (only the three network-bound
background tasks are stubbed), because the failure that matters — a seed quietly not running — is
invisible to a test that mocks the seeds out.
"""

import asyncio
import logging

import pytest
from sqlalchemy import func, select

from app import main
from app.models.persona import InterviewerPersona
from app.models.question import QuestionBank
from app.models.user import User
from app.services.persona_seed import DEFAULT_PERSONA_ID
from app.services.user_seed import CANDIDATE_USERNAMES


@pytest.fixture
def boot(db_session, monkeypatch):
    """Run the lifespan against the test DB with the background warm-ups stubbed out."""
    import app.db
    import app.interview.judge

    monkeypatch.setattr(app.db, "async_session_factory", db_session._test_factory)
    started: list[asyncio.Event] = []

    def _forever(*_a, **_kw):
        async def _wait():
            event = asyncio.Event()
            started.append(event)
            await event.wait()  # never set: only shutdown's cancel ends it

        return _wait()

    monkeypatch.setattr(main, "_prewarm_azure_credential", _forever)
    monkeypatch.setattr(main, "_sync_default_persona", _forever)
    monkeypatch.setattr(app.interview.judge, "warm_adapter", _forever)
    return started


async def _count(db, stmt) -> int:
    return (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()


async def test_boot_seeds_banks_accounts_and_the_default_persona(db_session, boot, monkeypatch):
    monkeypatch.setattr(main.settings, "seed_admin_password", "boot-pw")
    async with main.lifespan(main.app):
        pass

    banks = (await db_session.execute(select(QuestionBank))).scalars().all()
    assert sum(b.is_default for b in banks) == 1, "exactly one default bank after boot"
    assert len(banks) > 1, "the committed bundled banks are seeded alongside the default"

    usernames = set((await db_session.execute(select(User.username))).scalars())
    assert set(CANDIDATE_USERNAMES) <= usernames
    assert await _count(db_session, select(User).where(User.role == "admin")) == 1

    persona = await db_session.get(InterviewerPersona, DEFAULT_PERSONA_ID)
    assert persona is not None and persona.is_default


async def test_boot_is_idempotent(db_session, boot):
    async with main.lifespan(main.app):
        pass
    first = await _count(db_session, select(QuestionBank))
    async with main.lifespan(main.app):
        pass
    assert await _count(db_session, select(QuestionBank)) == first
    assert await _count(db_session, select(InterviewerPersona)) == 1


async def test_no_admin_is_seeded_without_a_configured_password(db_session, boot, monkeypatch):
    # A known-credential admin must never appear just because the env forgot the password.
    monkeypatch.setattr(main.settings, "seed_admin_password", "")
    async with main.lifespan(main.app):
        pass
    assert await _count(db_session, select(User).where(User.role == "admin")) == 0


async def test_a_failing_seed_is_logged_and_the_rest_still_run(
    db_session, boot, monkeypatch, caplog
):
    import app.services.question_seed

    async def _broken(_db):
        raise RuntimeError("bundle is corrupt")

    monkeypatch.setattr(app.services.question_seed, "seed_bundled_banks", _broken)
    with caplog.at_level(logging.ERROR, logger="app.main"):
        async with main.lifespan(main.app):
            pass

    assert "Boot step failed: bundled banks" in caplog.text
    assert "bundle is corrupt" in caplog.text
    # Steps after the broken one still ran.
    assert await db_session.get(InterviewerPersona, DEFAULT_PERSONA_ID) is not None
    usernames = set((await db_session.execute(select(User.username))).scalars())
    assert set(CANDIDATE_USERNAMES) <= usernames


async def test_shutdown_cancels_the_background_warmups(db_session, boot):
    async with main.lifespan(main.app):
        await asyncio.sleep(0)  # let the three tasks start
        assert len(boot) == 3
        tasks = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
    await asyncio.sleep(0)
    warmups = [t for t in tasks if "_wait" in repr(t.get_coro())]
    assert len(warmups) == 3
    assert all(t.cancelled() for t in warmups)


async def test_best_effort_returns_normally_when_the_step_raises(caplog):
    class _Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    async def _step(_session):
        raise ValueError("no such table")

    with caplog.at_level(logging.ERROR, logger="app.main"):
        await main._best_effort("probe", _step, _Session)
    assert "Boot step failed: probe" in caplog.text


async def test_credential_prewarm_swallows_a_failing_credential(monkeypatch):
    import app.services.azure_auth as azure_auth

    class _Cred:
        async def get_token(self, _scope):
            raise RuntimeError("no az login")

    monkeypatch.setattr(azure_auth, "get_azure_credential_cached", lambda: _Cred())
    await main._prewarm_azure_credential()  # must not raise


async def test_credential_prewarm_probes_the_cognitive_scope(monkeypatch):
    import app.services.azure_auth as azure_auth

    scopes: list[str] = []

    class _Cred:
        async def get_token(self, scope):
            scopes.append(scope)

    monkeypatch.setattr(azure_auth, "get_azure_credential_cached", lambda: _Cred())
    await main._prewarm_azure_credential()
    assert scopes == [azure_auth.COGNITIVE_SERVICES_SCOPE]


async def test_background_persona_sync_swallows_a_failure(db_session, monkeypatch):
    import app.db
    import app.services.persona_seed as persona_seed

    async def _down(_db):
        raise ConnectionError("Foundry unreachable")

    monkeypatch.setattr(app.db, "async_session_factory", db_session._test_factory)
    monkeypatch.setattr(persona_seed, "sync_default_persona", _down)
    await main._sync_default_persona()  # must not raise


async def test_boot_steps_run_in_dependency_order(db_session, boot, monkeypatch):
    """The overlay reads the master config row, so it must run after that row is seeded; the
    default persona needs the banks and accounts seeded before it. Pin the order, since the
    data-driven step list makes a reordering a one-line, silent change."""
    order: list[str] = []
    real = main._best_effort

    async def _recording(label, step, factory):
        order.append(label)
        await real(label, step, factory)

    monkeypatch.setattr(main, "_best_effort", _recording)
    async with main.lifespan(main.app):
        pass

    assert order == [
        "default bank",
        "bundled banks",
        "client banks",
        "default admin",
        "candidate accounts",
        "default persona",
        "master AI Foundry config",
        "master config overlay",
        "external interviewer config",
    ]
