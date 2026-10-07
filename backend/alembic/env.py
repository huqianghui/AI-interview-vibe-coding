"""Alembic environment — async engine, autogenerate against app metadata."""

import asyncio
from logging.config import fileConfig

from sqlalchemy.pool import NullPool

import app.models  # noqa: F401 — register all ORM classes on Base.metadata
from alembic import context
from app.config import get_settings
from app.db import Base, make_engine

config = context.config
config.set_main_option("sqlalchemy.url", get_settings().database_url)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def do_run_migrations(connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    # Same engine factory as the app, so an Entra-authenticated Postgres works for migrations too.
    connectable = make_engine(config.get_main_option("sqlalchemy.url"), poolclass=NullPool)
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
