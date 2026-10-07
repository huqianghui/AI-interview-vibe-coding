"""The engine factory: Entra token login for Azure PostgreSQL, SQLite PRAGMAs elsewhere.

CI has no PostgreSQL, so the connect path is driven with a fake ``asyncpg.connect``. By hand the
real path was checked against PostgreSQL 16: a role whose password is the "token" connects, a wrong
token is refused, and the full migration chain + E2E suite pass.
"""

import sys
import types

import pytest

from app import db


@pytest.fixture
def fake_asyncpg(monkeypatch):
    calls: list[dict] = []

    async def _connect(**kwargs):
        calls.append(kwargs)
        return object()

    monkeypatch.setitem(sys.modules, "asyncpg", types.SimpleNamespace(connect=_connect))
    return calls


async def test_entra_postgres_connects_with_a_fresh_token_each_time(monkeypatch, fake_asyncpg):
    monkeypatch.setattr(db._settings, "database_auth", "entra")
    tokens = iter(["token-1", "token-2"])
    monkeypatch.setattr(db, "_entra_token", lambda: next(tokens))
    captured: dict = {}
    real = db.create_async_engine

    def _capture(url, **kwargs):
        captured.update(kwargs)
        return real(url, **kwargs)

    monkeypatch.setattr(db, "create_async_engine", _capture)
    db.make_engine("postgresql+asyncpg://id-backend@pg.example:5432/ai_interview")

    connect = captured["async_creator"]
    await connect()
    await connect()
    assert [c["password"] for c in fake_asyncpg] == ["token-1", "token-2"]  # never cached
    first = fake_asyncpg[0]
    assert (first["host"], first["port"], first["user"], first["database"]) == (
        "pg.example",
        5432,
        "id-backend",
        "ai_interview",
    )
    assert first["ssl"] == "require"  # Azure requires TLS
    assert captured["pool_recycle"] == 1800
    assert captured["pool_pre_ping"] is True


async def test_an_explicit_ssl_setting_is_kept(monkeypatch, fake_asyncpg):
    monkeypatch.setattr(db._settings, "database_auth", "entra")
    monkeypatch.setattr(db, "_entra_token", lambda: "t")
    captured: dict = {}
    real = db.create_async_engine
    monkeypatch.setattr(
        db, "create_async_engine", lambda url, **kw: captured.update(kw) or real(url, **kw)
    )
    db.make_engine("postgresql+asyncpg://u@h/d", connect_args={"ssl": False})
    await captured["async_creator"]()
    assert fake_asyncpg[0]["ssl"] is False


def test_password_postgres_is_left_alone(monkeypatch):
    monkeypatch.setattr(db._settings, "database_auth", "password")
    engine = db.make_engine("postgresql+asyncpg://u:pw@localhost/ai_interview")
    assert engine.url.password == "pw"


def test_entra_token_uses_the_postgres_scope_and_one_credential(monkeypatch):
    made: list = []

    class _Cred:
        def __init__(self):
            made.append(self)

        def get_token(self, scope):
            assert scope == db.POSTGRES_ENTRA_SCOPE
            return types.SimpleNamespace(token="abc")

    monkeypatch.setattr(db, "_db_credential", None)
    monkeypatch.setitem(
        sys.modules, "azure.identity", types.SimpleNamespace(DefaultAzureCredential=_Cred)
    )
    assert db._entra_token() == "abc"
    assert db._entra_token() == "abc"
    assert len(made) == 1  # long-lived: its token cache is kept between connections
