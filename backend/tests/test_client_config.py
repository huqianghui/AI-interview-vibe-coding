"""The browser's runtime config (app/api/client_config.py): the App Insights connection string, for
a signed-in candidate or admin only."""

import pytest

PATH = "/client-config"


async def test_an_anonymous_caller_gets_nothing(client, monkeypatch):
    monkeypatch.setenv("APPLICATIONINSIGHTS_CONNECTION_STRING", "InstrumentationKey=abc")
    resp = await client.get(PATH)
    assert resp.status_code == 401
    assert "InstrumentationKey" not in resp.text


async def test_a_bad_token_gets_nothing(client, monkeypatch):
    monkeypatch.setenv("APPLICATIONINSIGHTS_CONNECTION_STRING", "InstrumentationKey=abc")
    resp = await client.get(PATH, headers={"Authorization": "Bearer not-a-jwt"})
    assert resp.status_code == 401


async def _connection_string_for(client, monkeypatch, headers):
    monkeypatch.setenv("APPLICATIONINSIGHTS_CONNECTION_STRING", "InstrumentationKey=abc;X=y")
    resp = await client.get(PATH, headers=headers)
    assert resp.status_code == 200
    return resp.json()


async def test_a_signed_in_admin_gets_the_connection_string(client, monkeypatch, admin_auth):
    body = await _connection_string_for(client, monkeypatch, admin_auth)
    assert body == {"app_insights_connection_string": "InstrumentationKey=abc;X=y"}


async def test_a_signed_in_candidate_gets_the_connection_string(
    client, monkeypatch, candidate_auth
):
    body = await _connection_string_for(client, monkeypatch, candidate_auth)
    assert body == {"app_insights_connection_string": "InstrumentationKey=abc;X=y"}


@pytest.mark.parametrize("value", [None, "  "])
async def test_without_app_insights_a_signed_in_user_gets_null(
    client, monkeypatch, admin_auth, value
):
    if value is None:
        monkeypatch.delenv("APPLICATIONINSIGHTS_CONNECTION_STRING", raising=False)
    else:
        monkeypatch.setenv("APPLICATIONINSIGHTS_CONNECTION_STRING", value)
    resp = await client.get(PATH, headers=admin_auth)
    assert resp.json() == {"app_insights_connection_string": None}
