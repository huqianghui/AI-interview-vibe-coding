"""Admin AI Foundry config API + the DB > .env > default overlay.

Covers: auth gate, PUT→GET masked round-trip, empty-key-preserves over HTTP, and the overlay that
makes a saved config mutate the settings singleton + register the azure agent-sync adapter.
"""

import pytest

from app.config import get_settings
from app.services import config_service
from app.services.config_overlay import apply_master_config_to_settings

ADMIN_TOKEN = "test-admin-token"
AUTH = {"Authorization": f"Bearer {ADMIN_TOKEN}"}


@pytest.fixture(autouse=True)
def _admin_token(monkeypatch):
    monkeypatch.setattr(get_settings(), "admin_api_token", ADMIN_TOKEN)
    yield


@pytest.fixture
def _restore_settings():
    """Snapshot/restore the settings fields the overlay mutates (shared singleton)."""
    s = get_settings()
    fields = [
        "foundry_project_endpoint",
        "foundry_api_key",
        "foundry_agent_model",
        "azure_foundry_endpoint",
        "azure_foundry_api_key",
        "azure_foundry_default_project",
        "voice_live_default_model",
        "default_voice_provider",
        "default_agent_sync_provider",
    ]
    saved = {f: getattr(s, f) for f in fields}
    yield
    for f, v in saved.items():
        setattr(s, f, v)


async def test_routes_require_a_token(client):
    assert (await client.get("/admin/config/ai-foundry")).status_code == 401
    assert (await client.put("/admin/config/ai-foundry", json={})).status_code == 401
    assert (await client.post("/admin/config/ai-foundry/test")).status_code == 401


async def test_get_unconfigured_returns_empty(client):
    resp = await client.get("/admin/config/ai-foundry", headers=AUTH)
    assert resp.status_code == 200
    body = resp.json()
    assert body["endpoint"] == ""
    assert body["masked_key"] == ""
    assert body["is_active"] is False


async def test_put_then_get_masks_key(client, _restore_settings):
    resp = await client.put(
        "/admin/config/ai-foundry",
        headers=AUTH,
        json={
            "endpoint": "https://demo.services.ai.azure.com",
            "api_key": "the-real-key-1234",
            "default_project": "demo-prj",
            "model_or_deployment": "gpt-4o-mini",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["is_active"] is True
    assert body["endpoint"] == "https://demo.services.ai.azure.com"
    # Response NEVER carries the raw key — only a masked form.
    assert body["masked_key"] == "****1234"
    assert "the-real-key-1234" not in resp.text

    got = (await client.get("/admin/config/ai-foundry", headers=AUTH)).json()
    assert got["masked_key"] == "****1234"
    assert got["model_or_deployment"] == "gpt-4o-mini"


async def test_put_empty_key_preserves_secret_over_http(client, _restore_settings):
    await client.put(
        "/admin/config/ai-foundry",
        headers=AUTH,
        json={
            "endpoint": "https://a.services.ai.azure.com",
            "api_key": "keep-me-5678",
            "default_project": "p",
            "model_or_deployment": "gpt-4o-mini",
        },
    )
    # Re-save with empty key (as the masked UI would) — secret must persist.
    resp = await client.put(
        "/admin/config/ai-foundry",
        headers=AUTH,
        json={
            "endpoint": "https://b.services.ai.azure.com",
            "api_key": "",
            "default_project": "p2",
            "model_or_deployment": "gpt-5.4-mini",
        },
    )
    assert resp.json()["masked_key"] == "****5678"


async def test_overlay_makes_db_win_over_default(db_session, _restore_settings):
    """DB > .env > code default: after save+overlay, settings + azure adapter reflect the DB row."""
    from app.services.agents import registry

    settings = get_settings()
    # Precondition: no azure agent-sync adapter registered on a mock-only boot.
    registry._AGENT_SYNC_ADAPTERS.pop("azure", None)

    await config_service.upsert_master_config(
        db_session,
        endpoint="https://demo.services.ai.azure.com",
        api_key="k",
        default_project="demo-prj",
        model_or_deployment="gpt-5.4",
        updated_by="admin",
    )
    applied = await apply_master_config_to_settings(db_session)
    assert applied is True

    # The singleton now carries the DB values (overlay won over the code default gpt-4o).
    assert settings.foundry_agent_model == "gpt-5.4"
    assert settings.voice_live_default_model == "gpt-5.4"
    assert settings.foundry_project_endpoint == "https://demo.services.ai.azure.com"
    assert settings.default_agent_sync_provider == "azure"
    # And the azure agent-sync adapter got (re)registered against the overlaid settings.
    assert "azure" in registry._AGENT_SYNC_ADAPTERS

    # Cleanup the adapter we caused to register so other tests see the mock-only baseline.
    registry._AGENT_SYNC_ADAPTERS.pop("azure", None)


async def test_overlay_noop_when_unconfigured(db_session):
    assert await apply_master_config_to_settings(db_session) is False


async def test_put_rejects_non_azure_endpoint_422(client, _restore_settings):
    # First save a valid config with a real key.
    await client.put(
        "/admin/config/ai-foundry",
        headers=AUTH,
        json={
            "endpoint": "https://good.services.ai.azure.com",
            "api_key": "secret-9999",
            "default_project": "p",
            "model_or_deployment": "gpt-4o-mini",
        },
    )
    # The exfil shape: point endpoint at an attacker host with an empty key (would preserve secret).
    resp = await client.put(
        "/admin/config/ai-foundry",
        headers=AUTH,
        json={
            "endpoint": "https://attacker.example.com",
            "api_key": "",
            "default_project": "p",
            "model_or_deployment": "gpt-4o-mini",
        },
    )
    assert resp.status_code == 422
    # Stored config unchanged — endpoint still the allowlisted host, key still the original.
    got = (await client.get("/admin/config/ai-foundry", headers=AUTH)).json()
    assert got["endpoint"] == "https://good.services.ai.azure.com"
    assert got["masked_key"] == "****9999"
