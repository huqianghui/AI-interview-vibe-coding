"""Health endpoint smoke test."""

import asyncio

import pytest

from app.api import health
from app.db import DatabaseUnavailableError


@pytest.mark.asyncio
async def test_health_returns_ok(client):
    resp = await client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


async def test_health_db_answers_ok_with_latency(client):
    resp = await client.get("/health/db")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert isinstance(body["latency_ms"], int)


@pytest.mark.parametrize(
    ("error", "reason"),
    [
        (ConnectionRefusedError(), "ConnectionRefusedError"),
        # What the engine raises for an unreachable server: the cause's kind is reported, never the
        # message, which names the host.
        (
            DatabaseUnavailableError("TimeoutError connecting to pg.example"),
            "DatabaseUnavailableError",
        ),
    ],
)
async def test_health_db_is_503_with_a_reason_when_the_database_is_down(
    client, monkeypatch, error, reason
):
    async def _down():
        raise error

    monkeypatch.setattr(health, "_select_one", _down)
    resp = await client.get("/health/db")
    assert resp.status_code == 503
    assert resp.json() == {"status": "unavailable", "latency_ms": None, "reason": reason}
    assert "pg.example" not in resp.text


async def test_health_db_gives_up_after_its_timeout(client, monkeypatch):
    async def _hang():
        await asyncio.sleep(60)

    monkeypatch.setattr(health, "DB_HEALTH_TIMEOUT_S", 0.05)
    monkeypatch.setattr(health, "_select_one", _hang)
    resp = await client.get("/health/db")
    assert resp.status_code == 503
    assert resp.json()["reason"] == "no answer within 0.05s"


async def test_liveness_does_not_touch_the_database(client, monkeypatch):
    async def _down():
        raise ConnectionRefusedError

    monkeypatch.setattr(health, "_select_one", _down)
    assert (await client.get("/health")).status_code == 200
