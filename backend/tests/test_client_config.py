"""The browser's runtime config (app/api/client_config.py): the App Insights connection string,
or nothing, with no login."""

from httpx import ASGITransport, AsyncClient

from app.main import app


async def _get() -> dict:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/public/client-config")
    assert resp.status_code == 200
    return resp.json()


async def test_without_app_insights_the_page_gets_nothing(monkeypatch):
    monkeypatch.delenv("APPLICATIONINSIGHTS_CONNECTION_STRING", raising=False)
    assert await _get() == {"app_insights_connection_string": None}


async def test_a_blank_value_counts_as_unset(monkeypatch):
    monkeypatch.setenv("APPLICATIONINSIGHTS_CONNECTION_STRING", "  ")
    assert await _get() == {"app_insights_connection_string": None}


async def test_the_deployment_connection_string_is_handed_over(monkeypatch):
    monkeypatch.setenv("APPLICATIONINSIGHTS_CONNECTION_STRING", "InstrumentationKey=abc;X=y")
    assert await _get() == {"app_insights_connection_string": "InstrumentationKey=abc;X=y"}
