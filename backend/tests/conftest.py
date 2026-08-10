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

import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
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
