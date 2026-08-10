"""Admin AI Foundry config API + the DB > .env > default overlay.

Covers: auth gate, PUT→GET masked round-trip, empty-key-preserves over HTTP, and the overlay that
makes a saved config mutate the settings singleton + register the azure agent-sync adapter.
"""

import pytest

from app.config import get_settings
from app.services import config_service
from app.services.config_overlay import apply_master_config_to_settings

# Populated with a real admin JWT by the autouse fixture below (Phase 1 require_role("admin") auth).
AUTH: dict[str, str] = {}


@pytest.fixture(autouse=True)
def _admin_token(admin_auth):
    """Populate AUTH with a real admin JWT header (see conftest.admin_auth)."""
    AUTH.clear()
    AUTH.update(admin_auth)


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
        "azure_openai_endpoint",
        "azure_openai_api_key",
        "azure_openai_deployment",
        "azure_search_endpoint",
        "azure_search_api_key",
        "azure_search_index",
        "azure_search_knowledge_source",
        "default_voice_provider",
        "default_agent_sync_provider",
        "default_llm_provider",
        "default_retrieval_provider",
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
    registry._RETRIEVAL_ADAPTERS.pop("azure", None)

    await config_service.upsert_master_config(
        db_session,
        endpoint="https://demo.services.ai.azure.com",
        api_key="k",
        default_project="demo-prj",
        model_or_deployment="gpt-5.4",
        knowledge_base="sop-kb",
        knowledge_source="sop-ks",
        updated_by="admin",
    )
    applied = await apply_master_config_to_settings(db_session)
    assert applied is True

    # The singleton now carries the DB values (overlay won over the code default gpt-4o).
    assert settings.foundry_agent_model == "gpt-5.4"
    assert settings.voice_live_default_model == "gpt-5.4"
    assert settings.foundry_project_endpoint == "https://demo.services.ai.azure.com"
    assert settings.default_agent_sync_provider == "azure"
    # Retrieval path flipped + kb/ks mapped to search settings → azure retrieval adapter registered.
    assert settings.default_retrieval_provider == "azure"
    assert settings.azure_search_index == "sop-kb"
    assert settings.azure_search_knowledge_source == "sop-ks"
    assert "azure" in registry._RETRIEVAL_ADAPTERS
    assert "azure" in registry._AGENT_SYNC_ADAPTERS

    # Cleanup adapters we caused to register so other tests see the mock-only baseline.
    registry._AGENT_SYNC_ADAPTERS.pop("azure", None)
    registry._RETRIEVAL_ADAPTERS.pop("azure", None)


async def test_overlay_skips_retrieval_without_kb(db_session, _restore_settings):
    """No kb/ks → retrieval provider stays unflipped (guards on all three search fields)."""
    from app.services.agents import registry

    settings = get_settings()
    registry._RETRIEVAL_ADAPTERS.pop("azure", None)
    await config_service.upsert_master_config(
        db_session,
        endpoint="https://demo.services.ai.azure.com",
        api_key="k",
        default_project="demo-prj",
        model_or_deployment="gpt-5.4",
        updated_by="admin",  # no kb/ks
    )
    await apply_master_config_to_settings(db_session)
    assert settings.default_retrieval_provider != "azure"
    assert "azure" not in registry._RETRIEVAL_ADAPTERS


async def test_kb_ks_persist_through_put_get(client, _restore_settings):
    await client.put(
        "/admin/config/ai-foundry",
        headers=AUTH,
        json={
            "endpoint": "https://demo.services.ai.azure.com",
            "api_key": "k",
            "default_project": "demo-prj",
            "model_or_deployment": "gpt-4o-mini",
            "knowledge_base": "sop-kb",
            "knowledge_source": "sop-ks",
        },
    )
    got = (await client.get("/admin/config/ai-foundry", headers=AUTH)).json()
    assert got["knowledge_base"] == "sop-kb"
    assert got["knowledge_source"] == "sop-ks"


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


# --- Dropdown endpoints (mocked httpx — no live Azure) ---------------------------------------


class _FakeResp:
    def __init__(self, status_code: int, payload: dict):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class _FakeAsyncClient:
    """Stub httpx.AsyncClient whose .get returns queued responses in order."""

    _responses: list = []

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get(self, *a, **k):
        return _FakeAsyncClient._responses.pop(0)


async def _seed(client, *, kb="", ks=""):
    await client.put(
        "/admin/config/ai-foundry",
        headers=AUTH,
        json={
            "endpoint": "https://demo.services.ai.azure.com",
            "api_key": "k",
            "default_project": "demo-prj",
            "model_or_deployment": "gpt-4o-mini",
            "knowledge_base": kb,
            "knowledge_source": ks,
        },
    )


async def test_model_deployments_from_project_api(client, _restore_settings, monkeypatch):
    await _seed(client)
    _FakeAsyncClient._responses = [
        _FakeResp(200, {"data": [{"name": "gpt-5.4-mini", "modelName": "gpt-5.4-mini"}]})
    ]
    monkeypatch.setattr("app.api.admin_config.httpx.AsyncClient", _FakeAsyncClient)
    resp = await client.get("/admin/config/ai-foundry/model-deployments", headers=AUTH)
    assert resp.status_code == 200
    body = resp.json()
    assert body[0]["value"] == "gpt-5.4-mini"


async def test_model_deployments_db_fallback_on_error(client, _restore_settings, monkeypatch):
    await _seed(client)
    # Both the project-scoped and legacy calls fail → fall back to the saved model.
    _FakeAsyncClient._responses = [_FakeResp(500, {}), _FakeResp(500, {})]
    monkeypatch.setattr("app.api.admin_config.httpx.AsyncClient", _FakeAsyncClient)
    body = (await client.get("/admin/config/ai-foundry/model-deployments", headers=AUTH)).json()
    assert body == [{"value": "gpt-4o-mini", "label": "gpt-4o-mini"}]


async def test_knowledge_bases_list(client, _restore_settings, monkeypatch):
    await _seed(client)

    # The endpoint delegates to foundry_connections.list_knowledge_bases (Phase 2.2); mock that
    # shared discovery function rather than the raw httpx call it makes internally.
    async def _fake_kbs(**_kwargs):
        return [{"name": "sop-kb", "description": "SOP KB"}]

    monkeypatch.setattr("app.api.admin_config.foundry_connections.list_knowledge_bases", _fake_kbs)
    body = (await client.get("/admin/config/ai-foundry/knowledge-bases", headers=AUTH)).json()
    assert body == [{"value": "sop-kb", "label": "SOP KB"}]


async def test_knowledge_bases_empty_on_error(client, _restore_settings, monkeypatch):
    await _seed(client)

    # Discovery is best-effort: foundry_connections.list_knowledge_bases returns [] on any failure.
    async def _empty_kbs(**_kwargs):
        return []

    monkeypatch.setattr("app.api.admin_config.foundry_connections.list_knowledge_bases", _empty_kbs)
    body = (await client.get("/admin/config/ai-foundry/knowledge-bases", headers=AUTH)).json()
    assert body == []


async def test_dropdowns_require_admin(client):
    assert (await client.get("/admin/config/ai-foundry/model-deployments")).status_code == 401
    assert (await client.get("/admin/config/ai-foundry/knowledge-bases")).status_code == 401
