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
        cursor.close()


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_factory() as session:
        yield session
