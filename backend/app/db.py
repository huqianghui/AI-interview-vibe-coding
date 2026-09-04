"""Async SQLAlchemy engine, session factory, and declarative base."""

from collections.abc import AsyncGenerator

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import get_settings

_settings = get_settings()

engine = create_async_engine(_settings.database_url, echo=_settings.debug)
async_session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


# SQLite does NOT enforce foreign keys (incl. ON DELETE CASCADE) unless PRAGMA foreign_keys=ON is
# issued per-connection. Without this, deleting a persona would orphan its persona_knowledge_configs
# rows instead of cascading. Scoped to SQLite so a real Postgres/MySQL prod DB (which enforces FKs
# natively) is untouched.
if engine.url.get_backend_name() == "sqlite":

    @event.listens_for(engine.sync_engine, "connect")
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
