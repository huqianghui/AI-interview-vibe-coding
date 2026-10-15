"""The admin Performance tab (spec-admin-performance-tab): one fixed operation id per interview, the
interview <-> operation mapping, the portal links, the end-to-end lookup, and the WS probe."""

import base64
import gzip
import os
import re
import uuid
from urllib.parse import unquote

import httpx
import pytest

from app.config import Settings
from app.services import performance_service
from tests.candidate_helpers import mint_candidate_headers

pytestmark = pytest.mark.asyncio

TRACE = "4bf92f3577b34da6a3ce929d0e0e4736"
TRACEPARENT = f"00-{TRACE}-00f067aa0ba902b7-01"


def _settings(**overrides) -> Settings:
    values = {
        "monitor_tenant_id": "tenant-1",
        "monitor_subscription_id": "sub-1",
        "monitor_resource_group": "rg-1",
        "app_insights_name": "appi-1",
        "log_analytics_workspace_id": "ws-1",
        "perf_workbook_id": "wb-1",
    }
    values.update(overrides)
    return Settings(secret_key="test").model_copy(update=values)


@pytest.fixture
def configured(monkeypatch):
    settings = _settings()
    monkeypatch.setattr("app.api.admin_performance.get_settings", lambda: settings)
    return settings


# --- ids -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (TRACE, TRACE),
        (f"  {TRACE.upper()} ", TRACE),
        ("4bf92f35-77b3-4da6-a3ce-929d0e0e4736", TRACE),  # an interview id, dashes and all
        ("0" * 32, None),
        ("xyz", None),
        (TRACE[:-1], None),
    ],
)
async def test_normalize(raw, expected):
    assert performance_service.normalize(raw) == expected


async def test_interview_and_operation_ids_round_trip():
    interview_id = str(uuid.uuid4())
    operation_id = performance_service.operation_id_for(interview_id)
    assert re.fullmatch(r"[0-9a-f]{32}", operation_id)
    assert performance_service.interview_id_for(operation_id) == interview_id


# --- the interview adopts the page's operation id ---------------------------------------------


async def test_a_fresh_interview_takes_the_pages_operation_id(client):
    headers = await mint_candidate_headers(client)
    resp = await client.post(
        "/candidate/interview/start", headers={**headers, "traceparent": TRACEPARENT}
    )
    assert resp.status_code == 200
    assert resp.json()["interview_session_id"] == performance_service.interview_id_for(TRACE)


async def test_without_a_traceparent_the_interview_gets_a_random_id(client):
    headers = await mint_candidate_headers(client)
    body = (await client.post("/candidate/interview/start", headers=headers)).json()
    assert uuid.UUID(body["interview_session_id"]).version == 4


async def test_a_malformed_traceparent_is_ignored(client):
    headers = await mint_candidate_headers(client)
    body = (
        await client.post(
            "/candidate/interview/start", headers={**headers, "traceparent": "00-zz-yy-01"}
        )
    ).json()
    assert uuid.UUID(body["interview_session_id"]).version == 4


async def test_restart_takes_the_new_operation_id(client):
    headers = await mint_candidate_headers(client)
    first = (
        await client.post(
            "/candidate/interview/start", headers={**headers, "traceparent": TRACEPARENT}
        )
    ).json()["interview_session_id"]
    renewed = "a" * 32
    resp = await client.post(
        f"/candidate/interview/{first}/restart",
        headers={**headers, "traceparent": f"00-{renewed}-00f067aa0ba902b7-01"},
    )
    assert resp.status_code == 200
    assert resp.json()["interview_session_id"] == performance_service.interview_id_for(renewed)


async def test_an_operation_id_already_an_interviews_is_not_reused(client):
    """A Restart on a page that did not renew its operation: the old interview owns that id."""
    headers = await mint_candidate_headers(client)
    with_trace = {**headers, "traceparent": TRACEPARENT}
    first = (await client.post("/candidate/interview/start", headers=with_trace)).json()[
        "interview_session_id"
    ]
    resp = await client.post(f"/candidate/interview/{first}/restart", headers=with_trace)
    fresh = resp.json()["interview_session_id"]
    assert fresh != first
    assert uuid.UUID(fresh).version == 4


# --- the Results column -----------------------------------------------------------------------


async def test_results_rows_carry_the_operation_id(client, admin_auth):
    headers = await mint_candidate_headers(client)
    await client.post("/candidate/interview/start", headers={**headers, "traceparent": TRACEPARENT})
    items = (await client.get("/admin/interviews", headers=admin_auth)).json()["items"]
    assert [i["operation_id"] for i in items] == [TRACE]


# --- links ------------------------------------------------------------------------------------


async def test_logs_url_carries_the_operation_query():
    url = performance_service.logs_url(TRACE, _settings())
    assert url.startswith("https://portal.azure.com/#@tenant-1/blade/")
    assert unquote(url.split("/resourceId/")[1].split("/source/")[0]) == (
        "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Insights/components/appi-1"
    )
    packed = unquote(url.split("/q/")[1].split("/timespan/")[0])
    query = gzip.decompress(base64.b64decode(packed)).decode()
    assert f'operation_Id == "{TRACE}"' in query


@pytest.mark.parametrize(
    "missing",
    ["monitor_tenant_id", "monitor_subscription_id", "monitor_resource_group", "app_insights_name"],
)
async def test_a_missing_setting_hides_the_logs_link(missing):
    assert performance_service.logs_url(TRACE, _settings(**{missing: ""})) is None


async def test_workbook_url():
    assert performance_service.workbook_url(_settings()) == (
        "https://portal.azure.com/#@tenant-1/resource/subscriptions/sub-1/resourceGroups/rg-1"
        "/providers/Microsoft.Insights/workbooks/wb-1/workbook"
    )
    assert performance_service.workbook_url(_settings(perf_workbook_id="")) is None


async def test_end_to_end_url():
    url = performance_service.end_to_end_url("item-1", "2026-10-10T08:11:51.052Z", _settings())
    assert unquote(url) == (
        "https://portal.azure.com/#view/AppInsightsExtension/DetailsV2Blade/DataModel~/"
        '{"eventId":"item-1","timestamp":"2026-10-10T08:11:51.052Z"}/ComponentId~/'
        '{"Name":"appi-1","ResourceGroup":"rg-1","SubscriptionId":"sub-1"}'
    )


# --- admin routes -----------------------------------------------------------------------------


async def test_the_routes_are_admin_only(client):
    headers = await mint_candidate_headers(client)
    for path in ("/admin/performance/links", f"/admin/performance/operations/{TRACE}"):
        assert (await client.get(path)).status_code == 401
        assert (await client.get(path, headers=headers)).status_code in (401, 403)


async def test_links(client, admin_auth, configured):
    body = (await client.get("/admin/performance/links", headers=admin_auth)).json()
    assert body == {
        "workbook_url": performance_service.workbook_url(configured),
        "logs": True,
        "transaction": True,
    }


async def test_links_without_config(client, admin_auth, monkeypatch):
    bare = Settings(secret_key="test")
    monkeypatch.setattr("app.api.admin_performance.get_settings", lambda: bare)
    body = (await client.get("/admin/performance/links", headers=admin_auth)).json()
    assert body == {"workbook_url": None, "logs": False, "transaction": False}


async def test_lookup_finds_the_interview(client, admin_auth, configured):
    headers = await mint_candidate_headers(client)
    await client.post("/candidate/interview/start", headers={**headers, "traceparent": TRACEPARENT})
    resp = await client.get(f"/admin/performance/operations/{TRACE}", headers=admin_auth)
    assert resp.status_code == 200
    body = resp.json()
    assert body["operation_id"] == TRACE
    assert body["interview"]["id"] == performance_service.interview_id_for(TRACE)
    assert body["logs_url"] == performance_service.logs_url(TRACE, configured)
    assert body["workbook_url"] == performance_service.workbook_url(configured)


async def test_lookup_of_an_id_that_is_no_interview(client, admin_auth, configured):
    body = (
        await client.get(f"/admin/performance/operations/{'b' * 32}", headers=admin_auth)
    ).json()
    assert body["interview"] is None
    assert body["logs_url"] is not None, "any operation still gets its links"


async def test_lookup_rejects_a_malformed_id(client, admin_auth):
    resp = await client.get("/admin/performance/operations/nope", headers=admin_auth)
    assert resp.status_code == 422


# --- the end-to-end transaction lookup --------------------------------------------------------


def _logs_api(monkeypatch, handler):
    async def _token(scope):
        assert scope == "https://api.loganalytics.io/.default"
        return "token"

    monkeypatch.setattr(performance_service.azure_auth, "get_bearer_token", _token)
    real = httpx.AsyncClient

    def _client(**kwargs):
        return real(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(performance_service.httpx, "AsyncClient", _client)


async def test_transaction_found(client, admin_auth, configured, monkeypatch):
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["authorization"]
        return httpx.Response(
            200,
            json={
                "tables": [
                    {
                        "columns": [{"name": "TimeGenerated"}, {"name": "_ItemId"}],
                        "rows": [["2026-10-10T08:11:51.052Z", "item-1"]],
                    }
                ]
            },
        )

    _logs_api(monkeypatch, handler)
    body = (
        await client.get(f"/admin/performance/operations/{TRACE}/transaction", headers=admin_auth)
    ).json()
    assert body["status"] == "found"
    assert body["url"] == performance_service.end_to_end_url(
        "item-1", "2026-10-10T08:11:51.052Z", configured
    )
    assert seen["url"] == "https://api.loganalytics.io/v1/workspaces/ws-1/query"
    assert seen["auth"] == "Bearer token"


async def test_transaction_not_found_yet(client, admin_auth, configured, monkeypatch):
    _logs_api(
        monkeypatch, lambda r: httpx.Response(200, json={"tables": [{"columns": [], "rows": []}]})
    )
    body = (
        await client.get(f"/admin/performance/operations/{TRACE}/transaction", headers=admin_auth)
    ).json()
    assert body == {"status": "not_found", "url": None, "reason": None}


async def test_transaction_refused_names_the_role(client, admin_auth, configured, monkeypatch):
    _logs_api(monkeypatch, lambda r: httpx.Response(403, json={}))
    body = (
        await client.get(f"/admin/performance/operations/{TRACE}/transaction", headers=admin_auth)
    ).json()
    assert body["status"] == "unavailable"
    assert "Log Analytics Data Reader" in body["reason"]


async def test_transaction_without_a_workspace(client, admin_auth, monkeypatch):
    settings = _settings(log_analytics_workspace_id="")
    monkeypatch.setattr("app.api.admin_performance.get_settings", lambda: settings)
    body = (
        await client.get(f"/admin/performance/operations/{TRACE}/transaction", headers=admin_auth)
    ).json()
    assert body["status"] == "unavailable"


# Owner rule: local runs hit the real service, CI never does. Needs `az login` with read access to
# the workspace, plus E2E_LOG_ANALYTICS_WORKSPACE_ID and an E2E_OPERATION_ID that exists in it.
@pytest.mark.skipif(
    bool(os.environ.get("CI"))
    or not os.environ.get("E2E_LOG_ANALYTICS_WORKSPACE_ID")
    or not os.environ.get("E2E_OPERATION_ID"),
    reason="needs a real Log Analytics workspace (local only)",
)
async def test_first_item_against_the_real_workspace():
    settings = _settings(log_analytics_workspace_id=os.environ["E2E_LOG_ANALYTICS_WORKSPACE_ID"])
    item = await performance_service.first_item(os.environ["E2E_OPERATION_ID"], settings)
    assert item is not None
    assert re.fullmatch(r"[0-9a-f-]{36}", item.item_id)
    assert item.timestamp.startswith("20")
