"""Admin persona API (SPEC F5): auth guard, CRUD, one-default, sync bookkeeping over HTTP."""

import pytest

AUTH: dict = {}


@pytest.fixture(autouse=True)
def _admin_token(admin_auth):
    """Populate AUTH with a real admin JWT header (see conftest.admin_auth)."""
    AUTH.clear()
    AUTH.update(admin_auth)
    yield


async def test_admin_routes_require_a_token(client):
    assert (await client.get("/admin/personas")).status_code == 401
    assert (
        await client.get("/admin/personas", headers={"Authorization": "Bearer wrong"})
    ).status_code == 401


async def test_create_persona_triggers_mock_sync(client):
    resp = await client.post(
        "/admin/personas", headers=AUTH, json={"name": "Ava", "prompt_fragment": "be fair"}
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "Ava"
    # Mock agent-sync ran inline and recorded a synced state (F5 AC #1 + #4 happy path).
    assert body["agent_sync_status"] == "synced"
    assert body["agent_id"].startswith("mock-agent-")
    assert body["agent_version"] == "1"


async def test_list_and_get(client):
    created = (await client.post("/admin/personas", headers=AUTH, json={"name": "P"})).json()
    listing = (await client.get("/admin/personas", headers=AUTH)).json()
    assert [p["id"] for p in listing] == [created["id"]]
    one = await client.get(f"/admin/personas/{created['id']}", headers=AUTH)
    assert one.status_code == 200 and one.json()["name"] == "P"


async def test_get_missing_is_404(client):
    assert (await client.get("/admin/personas/nope", headers=AUTH)).status_code == 404


async def test_set_default_switches_exactly_one(client):
    a = (
        await client.post("/admin/personas", headers=AUTH, json={"name": "a", "is_default": True})
    ).json()
    b = (await client.post("/admin/personas", headers=AUTH, json={"name": "b"})).json()
    resp = await client.post(f"/admin/personas/{b['id']}/set-default", headers=AUTH)
    assert resp.status_code == 200 and resp.json()["is_default"] is True
    # a is no longer the default
    a_now = (await client.get(f"/admin/personas/{a['id']}", headers=AUTH)).json()
    assert a_now["is_default"] is False


async def test_update_persona_resyncs(client):
    p = (await client.post("/admin/personas", headers=AUTH, json={"name": "p"})).json()
    resp = await client.put(
        f"/admin/personas/{p['id']}", headers=AUTH, json={"voice_temperature": 0.5}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["voice_temperature"] == 0.5
    assert body["agent_sync_status"] == "synced"


async def test_update_missing_is_404(client):
    assert (
        await client.put("/admin/personas/nope", headers=AUTH, json={"name": "x"})
    ).status_code == 404


async def test_retry_sync_on_existing(client):
    p = (await client.post("/admin/personas", headers=AUTH, json={"name": "p"})).json()
    resp = await client.post(f"/admin/personas/{p['id']}/retry-sync", headers=AUTH)
    assert resp.status_code == 200 and resp.json()["agent_sync_status"] == "synced"


async def test_create_rejects_blank_name(client):
    resp = await client.post("/admin/personas", headers=AUTH, json={"name": ""})
    assert resp.status_code == 422
