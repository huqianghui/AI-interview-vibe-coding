"""Async SQLAlchemy engine, session factory, and declarative base."""

import asyncio
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager
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

# How long one PostgreSQL connect may take before the request gives up. asyncpg's own default is
# 60 s, so an unreachable server (stopped, network cut) held every request for a full minute and
# then surfaced as a bare 500.
CONNECT_TIMEOUT_S = 10


class DatabaseUnavailableError(Exception):
    """The database server could not be reached. ``app.main`` turns it into a 503 with a reason."""


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
            try:
                return await asyncpg.connect(
                    host=parsed.host,
                    port=parsed.port or 5432,
                    user=parsed.username,
                    database=parsed.database,
                    password=token,
                    ssl=ssl,
                    timeout=CONNECT_TIMEOUT_S,
                )
            except (TimeoutError, OSError) as exc:
                # Unreachable, not refused: a bad token or role is a PostgresError and stays a 500.
                raise DatabaseUnavailableError(
                    f"{type(exc).__name__} connecting to {parsed.host}"
                ) from exc

        kwargs["async_creator"] = _connect
        # Recycle long-idle connections well inside the token lifetime, and check before reuse.
        kwargs.setdefault("pool_recycle", 1800)
        kwargs.setdefault("pool_pre_ping", True)
    if parsed.get_backend_name() == "postgresql" and kwargs.get("poolclass") is None:
        # Sized by settings (DB_POOL_SIZE / DB_MAX_OVERFLOW), not SQLAlchemy's 5 + 10: concurrent
        # interviews, voice sessions and scoring all draw from it, and the server's limit is
        # shared by every process (see Settings.db_pool_size). Paths that wait on an LLM or the
        # external brain end their transaction first, so a connection is held only for the
        # queries themselves.
        kwargs.setdefault("pool_size", _settings.db_pool_size)
        kwargs.setdefault("max_overflow", _settings.db_max_overflow)
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


# Any fixed number, distinct from Alembic's migration lock (alembic/env.py).
_BOOT_LOCK_ID = 7_187_050_002


@asynccontextmanager
async def boot_lock(target: AsyncEngine | None = None) -> AsyncIterator[None]:
    """Hold a database-wide lock for boot work every process does (seeds, the client bank import).

    Each uvicorn worker of each replica runs the boot seeds; they are create-only, but two running
    at once can both see a row missing and both create it. On PostgreSQL this takes a session-level
    advisory lock on one dedicated connection for the duration, so the others wait and then find
    the work done; the server releases it if the process dies. A no-op on SQLite (one process).
    """
    target = target or engine
    if target.url.get_backend_name() != "postgresql":
        yield
        return
    async with target.connect() as conn:
        await conn.exec_driver_sql(f"SELECT pg_advisory_lock({_BOOT_LOCK_ID})")
        await conn.commit()
        try:
            yield
        finally:
            await conn.exec_driver_sql(f"SELECT pg_advisory_unlock({_BOOT_LOCK_ID})")
            await conn.commit()


def _scripts():  # noqa: ANN202 — alembic's ScriptDirectory
    from pathlib import Path

    from alembic.config import Config
    from alembic.script import ScriptDirectory

    backend = Path(__file__).resolve().parent.parent
    config = Config(str(backend / "alembic.ini"))
    config.set_main_option("script_location", str(backend / "alembic"))  # not relative to the cwd
    return ScriptDirectory.from_config(config)


def _migration_heads() -> set[str]:
    return set(_scripts().get_heads())


async def wait_for_schema(poll_seconds: float = 5.0) -> None:
    """Until the database is at the migrations' head: the job process starts beside the web
    container, which is the one that runs ``alembic upgrade head`` (entrypoint.sh)."""
    from sqlalchemy import text

    scripts = _scripts()
    heads = set(scripts.get_heads())
    known = {rev.revision for rev in scripts.walk_revisions()}
    while True:
        try:
            async with engine.connect() as conn:
                rows = await conn.execute(text("SELECT version_num FROM alembic_version"))
                versions = set(rows.scalars().all())
            # At head, or AHEAD of this image (a newer web container migrated; an older job image
            # rolled back to): either way there is nothing to wait for.
            if versions == heads or (versions and not versions <= known):
                return
        except Exception:  # noqa: BLE001 — no table yet, or the database is starting
            pass
        await asyncio.sleep(poll_seconds)
