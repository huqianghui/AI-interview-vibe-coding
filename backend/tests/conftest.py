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
from app.db import Base, get_db  # noqa: E402
from app.main import app  # noqa: E402


@pytest_asyncio.fixture
async def db_session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")

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
        yield session
    await engine.dispose()


@pytest_asyncio.fixture
async def client(db_session):
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
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
