"""Shared test fixtures.

In-memory SQLite + get_db override so tests never touch a real DB or live Azure.
This is the seam the test-double strategy (SPEC P2) hooks into.

A developer's local ``backend/.env`` may point the default providers at real Azure
(``DEFAULT_LLM_PROVIDER=azure_openai`` etc.) and carry live endpoints/keys. Tests must be immune
to that so local runs match CI (where no ``.env`` exists) — SPEC P2. We pin the provider selection
to ``mock`` and blank the Azure creds in ``os.environ`` BEFORE any ``app`` import, because
``get_settings()`` is import-time cached (via ``app.main`` / the agent registry) and env vars take
precedence over the ``.env`` file in pydantic-settings.
"""

import os

# Must run before the `app.*` imports below — see module docstring.
os.environ.update(
    {
        "DEFAULT_LLM_PROVIDER": "mock",
        "DEFAULT_RETRIEVAL_PROVIDER": "mock",
        "DEFAULT_AGENT_SYNC_PROVIDER": "mock",
        "DEFAULT_VOICE_PROVIDER": "mock",
        "AZURE_SEARCH_ENDPOINT": "",
        "AZURE_FOUNDRY_ENDPOINT": "",
        "AZURE_FOUNDRY_API_KEY": "",
        "FOUNDRY_PROJECT_ENDPOINT": "",
        # A fixed test Fernet key so at-rest encryption works deterministically in CI (which has no
        # .env and defaults debug=off, where encryption now fails closed without a key). Not a real
        # secret — a throwaway key used only by the test suite.
        "ENCRYPTION_KEY": "v_ftieq-S7JwF27OzZw7kUFzULt1FF_rY2vn0jEkfYQ=",
        # #102: SECRET_KEY is required (no code default) — a fixed test key keeps derived
        # candidate passwords deterministic across the suite.
        "SECRET_KEY": "test-secret-key-do-not-use-in-prod",
    }
)

# Azure SDK stub shim (SPEC P2): CI installs only ``.[dev]`` (no ``azure`` extra), so the real
# ``azure.identity`` / ``azure.core`` / ``openai`` modules are absent there. The azure_auth /
# foundry_client unit tests ``patch("azure.identity.aio.DefaultAzureCredential", ...)`` and the
# code-under-test lazily ``from azure.core.credentials import AccessToken`` — both need those
# module *paths* to be importable for the patch target / import to resolve. When the real SDK is
# present (a dev box set up for live-Azure testing) we use it; when it's absent we register light
# stub modules so the same tests run identically in CI. Runs before any ``app`` import below.
import sys  # noqa: E402
from unittest.mock import MagicMock  # noqa: E402


def _ensure_stub_module(name: str) -> None:
    """Put a MagicMock in ``sys.modules`` for ``name`` (+ parents) if the real one can't import.

    A MagicMock auto-creates any attribute on access, so both ``from azure.core.credentials import
    AccessToken`` and ``patch("azure.identity.aio.DefaultAzureCredential", ...)`` resolve against it
    (patch does getattr+setattr on the module object). When the real SDK is installed the import
    succeeds and we leave it alone.
    """
    try:
        __import__(name)
        return  # real module present — use it
    except Exception:  # noqa: BLE001 — any import failure → supply a stub
        pass
    parts = name.split(".")
    for i in range(1, len(parts) + 1):
        sub = ".".join(parts[:i])
        if sub not in sys.modules:
            stub = MagicMock(name=sub)
            stub.__spec__ = MagicMock()  # importlib treats it as a real, already-imported module
            sys.modules[sub] = stub
            if i > 1:
                setattr(sys.modules[".".join(parts[: i - 1])], parts[i - 1], stub)


for _azure_mod in (
    "azure.identity",
    "azure.identity.aio",
    "openai",
):
    _ensure_stub_module(_azure_mod)
# NOTE: azure.core.credentials is deliberately NOT stubbed — the only tests touching it
# (test_foundry_client) assert the REAL AccessToken's value/expiry, so they importorskip when the
# SDK is absent. Stubbing it would defeat that skip and yield MagicMock assertion failures.

import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy import event  # noqa: E402
from sqlalchemy.ext.asyncio import (  # noqa: E402
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

import app.models  # noqa: F401,E402 — registers all ORM classes on Base.metadata
from app.db import Base, get_db, get_session_factory  # noqa: E402
from app.main import app  # noqa: E402


@pytest_asyncio.fixture
async def db_session():
    # StaticPool: every checkout reuses ONE sqlite connection, so the streaming endpoints' second
    # session (opened via get_session_factory inside the response generator) sees the same
    # :memory: database — a fresh connection would get a brand-new EMPTY one.
    from sqlalchemy.pool import StaticPool

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", poolclass=StaticPool)

    # Mirror app.db: SQLite needs PRAGMA foreign_keys=ON per-connection for ON DELETE CASCADE to
    # fire. Without this the cascade tests would pass vacuously (FKs unenforced in the test DB).
    @event.listens_for(engine.sync_engine, "connect")
    def _fk_on(dbapi_connection, _record):  # noqa: ANN001
        cur = dbapi_connection.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        # Streaming endpoints open their own session via the get_session_factory dependency (their
        # generator outlives the request-scoped get_db session) — hang the factory off the session
        # so the client fixture can override that dependency onto the SAME in-memory engine.
        session._test_factory = factory
        yield session
    await engine.dispose()


@pytest_asyncio.fixture
async def client(db_session):
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_session_factory] = lambda: db_session._test_factory
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        ac._db_session = db_session  # for tests.candidate_helpers.mint_candidate_headers (#102)
        yield ac
    app.dependency_overrides.clear()


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest_asyncio.fixture
async def admin_auth(db_session):
    """Create an admin user in the test DB and return a real JWT auth header.

    Replaces the old shared-token admin auth for routes now gated by require_role("admin").
    """
    from app.models.user import User
    from app.services.auth_service import create_access_token, get_password_hash

    admin = User(
        username="test-admin",
        email="test-admin@local",
        hashed_password=get_password_hash("pw"),
        role="admin",
    )
    db_session.add(admin)
    await db_session.commit()
    await db_session.refresh(admin)
    return {"Authorization": f"Bearer {create_access_token(data={'sub': admin.id})}"}


@pytest_asyncio.fixture
async def candidate_auth(db_session):
    """Create a role=user candidate in the test DB and return a real JWT auth header (#102).

    Mirrors ``admin_auth``: minting an anonymous candidate session now requires this bearer.
    """
    from tests.candidate_helpers import new_candidate_bearer

    return await new_candidate_bearer(db_session, username="test-candidate")


# --- Judge LLM fixtures (issue #114) -----------------------------------------------------------
# Owner rule: GitHub CI never calls the real model; LOCAL runs MUST. ``judge_llm`` injects the real
# Foundry adapter when Foundry credentials exist in backend/.env and ``CI`` is unset, otherwise the
# deterministic scripted fake. ``scripted_judge`` is ALWAYS the fake — for tests of OUR code paths
# (parsing, guards, budgets, staleness) whose assertions need exact LLM output.
import pytest  # noqa: E402

from app.interview import judge as _judge  # noqa: E402


class ScriptedJudgeAdapter:
    """LLMAdapter stand-in: returns queued raw strings (or raises) in order; records prompts."""

    name = "scripted-judge"
    _model = "scripted"

    def __init__(self, *responses):
        self.responses = list(responses)
        self.prompts: list[str] = []

    async def complete(self, prompt: str, *, json_mode: bool = False, fast: bool = False) -> str:
        self.prompts.append(prompt)
        if not self.responses:
            return '{"verdict": "wait", "speech_text": "", "reason": "default"}'
        nxt = self.responses.pop(0)
        if isinstance(nxt, BaseException):
            raise nxt
        if callable(nxt):
            return await nxt(prompt)
        return nxt

    async def stream(self, prompt: str):  # pragma: no cover — protocol completeness
        yield await self.complete(prompt)


@pytest.fixture
def scripted_judge():
    """Always the fake. Use ``scripted_judge.responses.extend([...])`` to queue outputs."""
    adapter = ScriptedJudgeAdapter()
    _judge.set_adapter_override(adapter)
    yield adapter
    _judge.set_adapter_override(None)


def _real_judge_adapter():
    """The real Foundry LLM adapter built from backend/.env — or None when unavailable."""
    if os.environ.get("CI"):
        return None
    try:
        from dotenv import dotenv_values
    except ImportError:  # pragma: no cover
        return None
    env_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")
    vals = dotenv_values(env_path) if os.path.exists(env_path) else {}
    endpoint = vals.get("AZURE_FOUNDRY_ENDPOINT") or ""
    if not endpoint:
        return None
    try:
        from app.services.agents.adapters.foundry_llm import FoundryLLMAdapter
    except Exception:  # pragma: no cover — azure extra missing
        return None
    return FoundryLLMAdapter(
        endpoint=endpoint,
        project=vals.get("AZURE_FOUNDRY_DEFAULT_PROJECT") or "",
        api_key=vals.get("AZURE_FOUNDRY_API_KEY") or "",
        model=vals.get("FOUNDRY_AGENT_MODEL") or "gpt-5-mini",
    )


@pytest.fixture
def judge_llm():
    """Real model locally, scripted fake under CI. ``judge_llm.is_real`` tells tests which."""
    real = _real_judge_adapter()
    adapter = real if real is not None else ScriptedJudgeAdapter()
    adapter.is_real = real is not None  # type: ignore[attr-defined]
    _judge.set_adapter_override(adapter)
    yield adapter
    _judge.set_adapter_override(None)
