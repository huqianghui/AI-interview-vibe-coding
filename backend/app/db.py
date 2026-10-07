"""Async SQLAlchemy engine, session factory, and declarative base."""

import asyncio
from collections.abc import AsyncGenerator
from typing import Any

from sqlalchemy import event, make_url
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.config import get_settings

# Microsoft Entra scope for Azure Database for PostgreSQL / MySQL access tokens.
POSTGRES_ENTRA_SCOPE = "https://ossrdbms-aad.database.windows.net/.default"

_settings = get_settings()


# One long-lived credential for the database alone. azure-identity caches each token until shortly
# before it expires, so most connections cost no network call; the shared credential in
# azure_auth is re-created every 30 min, which would throw that cache away.
_db_credential: Any = None


def _entra_token() -> str:
    """A current Entra access token for the database (blocking: run it off the event loop)."""
    global _db_credential
    if _db_credential is None:
        try:
            from azure.identity import DefaultAzureCredential
        except ImportError as exc:
            raise RuntimeError("DATABASE_AUTH=entra but no Azure credential is available") from exc
        # AZURE_CLIENT_ID (set on the Container App) selects the user-assigned managed identity.
        _db_credential = DefaultAzureCredential()
    return _db_credential.get_token(POSTGRES_ENTRA_SCOPE).token


def make_engine(url: str, **kwargs: Any) -> AsyncEngine:
    """The app's engine for ``url``; Alembic builds its migration engine through this too.

    SQLite gets its per-connection PRAGMAs. PostgreSQL with ``DATABASE_AUTH=entra`` opens each new
    connection itself (``async_creator``) with a fresh token as the password, over TLS, which Azure
    requires. A token expires in about an hour, so it cannot be baked into the URL at start-up; and
    fetching one can be a network call, so it runs in a worker thread rather than blocking the event
    loop that also carries the live voice WebSockets.
    """
    entra = _settings.database_auth == "entra"
    parsed = make_url(url)
    if entra and parsed.get_backend_name() == "postgresql":
        ssl = kwargs.pop("connect_args", {}).get("ssl", "require")

        async def _connect():
            import asyncpg

            token = await asyncio.to_thread(_entra_token)
            return await asyncpg.connect(
                host=parsed.host,
                port=parsed.port or 5432,
                user=parsed.username,
                database=parsed.database,
                password=token,
                ssl=ssl,
            )

        kwargs["async_creator"] = _connect
        # Recycle long-idle connections well inside the token lifetime, and check before reuse.
        kwargs.setdefault("pool_recycle", 1800)
        kwargs.setdefault("pool_pre_ping", True)
    if parsed.get_backend_name() == "postgresql" and kwargs.get("poolclass") is None:
        # Sized explicitly rather than SQLAlchemy's 5 + 10: concurrent interviews, voice sessions
        # and scoring all draw from it. 10 + 15 = 25 stays inside the Burstable B1ms server's ~40
        # usable connections (max_connections 50, 10 reserved), leaving room for Alembic and a
        # revision swap's second replica. Paths that wait on an LLM or the external brain end
        # their transaction first, so a connection is held only for the queries themselves.
        kwargs.setdefault("pool_size", 10)
        kwargs.setdefault("max_overflow", 15)
        kwargs.setdefault("pool_timeout", 30)
    built = create_async_engine(url, **kwargs)
    if built.url.get_backend_name() == "sqlite":
        event.listen(built.sync_engine, "connect", _sqlite_enable_foreign_keys)
    return built


# SQLite does NOT enforce foreign keys (incl. ON DELETE CASCADE) unless PRAGMA foreign_keys=ON is
# issued per-connection. Without this, deleting a persona would orphan its persona_knowledge_configs
# rows instead of cascading. Scoped to SQLite so a real Postgres/MySQL prod DB (which enforces FKs
# natively) is untouched.
def _sqlite_enable_foreign_keys(dbapi_connection, _connection_record):  # noqa: ANN001
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    # The external-brain turn lock (app.interview.external_runner) issues a guarded UPDATE that
    # can contend with a concurrent writer on the same session. SQLite serializes writers with a
    # single lock; without a busy_timeout a second writer that arrives mid-write fails instantly
    # with "database is locked" instead of waiting its turn. 5s lets the brief holder commit
    # so the loser blocks-then-proceeds (and is then caught by the version guard, not a raw
    # OperationalError). Scoped to SQLite; a real prod DB has its own row-level locking.
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()


engine = make_engine(_settings.database_url, echo=_settings.debug)
async_session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_factory() as session:
        yield session


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    """The session FACTORY as a dependency, for handlers that outlive their request session.

    FastAPI (≥0.106) tears down ``get_db``'s yielded session when the route function returns —
    BEFORE a StreamingResponse generator body runs — so streaming handlers must open their own
    session inside the generator. Injecting the factory (rather than importing it) keeps those
    handlers pointed at the same database the tests override ``get_db`` with.
    """
    return async_session_factory
