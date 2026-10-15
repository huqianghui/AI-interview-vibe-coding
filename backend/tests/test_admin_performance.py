"""The admin Performance tab (spec-admin-performance-tab): one fixed operation id per interview, the
interview <-> operation mapping, the portal links, the end-to-end lookup, and the WS probe."""

import base64
import gzip
import json
import os
import re
import uuid
from pathlib import Path
from urllib.parse import unquote

import httpx
import pytest

from app.config import Settings
from app.services import performance_service
from tests.candidate_helpers import mint_candidate_headers

pytestmark = pytest.mark.asyncio

TRACE = "4bf92f3577b34da6a3ce929d0e0e4736"
# The page's avatar code, for checking the outcome names the network query counts.
_AVATAR_STREAM_SOURCE = (
    Path(__file__).resolve().parents[2] / "frontend/src/hooks/useAvatarStream.ts"
).read_text()
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


async def test_an_external_interview_takes_the_pages_operation_id(client, db_session):
    from app.services import persona_service as psvc

    await psvc.create_persona(
        db_session, name="Interviewer", is_default=True, interview_brain="external"
    )
    headers = await mint_candidate_headers(client)
    body = (
        await client.post(
            "/candidate/interview/start", headers={**headers, "traceparent": TRACEPARENT}
        )
    ).json()
    assert body["external_phase"] is not None
    assert body["interview_session_id"] == performance_service.interview_id_for(TRACE)


async def test_an_adopted_id_taken_at_insert_falls_back_to_a_random_one(client, monkeypatch):
    """Another candidate's interview took the id between the check and the insert."""
    other = await mint_candidate_headers(client)
    taken = (
        await client.post(
            "/candidate/interview/start", headers={**other, "traceparent": TRACEPARENT}
        )
    ).json()["interview_session_id"]

    async def _stale_check(db, traceparent):
        return taken  # what a check that ran before the other insert would have said

    monkeypatch.setattr(performance_service, "adoptable_id", _stale_check)
    headers = await mint_candidate_headers(client)
    resp = await client.post(
        "/candidate/interview/start", headers={**headers, "traceparent": TRACEPARENT}
    )
    assert resp.status_code == 200
    fresh = resp.json()["interview_session_id"]
    assert fresh != taken
    assert uuid.UUID(fresh).version == 4


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


async def test_queries_take_only_a_normalized_id():
    with pytest.raises(ValueError):
        performance_service.logs_query('x" | union *')
    with pytest.raises(ValueError):
        performance_service._first_item_query(TRACE.upper())


@pytest.mark.parametrize(
    ("missing", "workbook", "transaction"),
    [
        ("monitor_tenant_id", False, True),
        ("monitor_subscription_id", False, False),
        ("monitor_resource_group", False, False),
        ("app_insights_name", True, False),
        ("log_analytics_workspace_id", True, False),
    ],
)
async def test_each_setting_hides_only_what_needs_it(missing, workbook, transaction):
    settings = _settings(**{missing: ""})
    assert (performance_service.workbook_url(settings) is not None) is workbook
    assert performance_service.transaction_configured(settings) is transaction


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
    for path in (
        "/admin/performance/links",
        f"/admin/performance/operations/{TRACE}",
        f"/admin/performance/operations/{TRACE}/transaction",
    ):
        assert (await client.get(path)).status_code == 401
        assert (await client.get(path, headers=headers)).status_code in (401, 403)


async def test_links(client, admin_auth, configured):
    body = (await client.get("/admin/performance/links", headers=admin_auth)).json()
    assert body == {
        "workbook_url": "https://portal.azure.com/#@tenant-1/resource/subscriptions/sub-1"
        "/resourceGroups/rg-1/providers/Microsoft.Insights/workbooks/wb-1/workbook",
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


@pytest.mark.parametrize(
    ("response", "reason"),
    [
        (httpx.Response(500, json={}), "answered 500"),
        (httpx.Response(401, json={}), "Log Analytics Data Reader"),
        (httpx.Response(200, content=b"<html>"), "unexpected"),
        (httpx.Response(200, json={"tables": [{"rows": [["x"]]}]}), "unexpected"),
        (httpx.Response(200, json={"tables": "nope"}), "unexpected"),
    ],
)
async def test_first_item_turns_every_bad_answer_into_unavailable(monkeypatch, response, reason):
    _logs_api(monkeypatch, lambda r: response)
    with pytest.raises(performance_service.LookupUnavailable, match=reason):
        await performance_service.first_item(TRACE, _settings())


async def test_first_item_when_the_api_does_not_answer(monkeypatch):
    def _down(request):
        raise httpx.ConnectTimeout("no route", request=request)

    _logs_api(monkeypatch, _down)
    with pytest.raises(performance_service.LookupUnavailable, match="ConnectTimeout"):
        await performance_service.first_item(TRACE, _settings())


async def test_first_item_without_a_credential(monkeypatch):
    async def _none(scope):
        return None

    monkeypatch.setattr(performance_service.azure_auth, "get_bearer_token", _none)
    with pytest.raises(performance_service.LookupUnavailable, match="No Azure credential"):
        await performance_service.first_item(TRACE, _settings())


async def test_first_item_row_without_an_item_id_is_not_found(monkeypatch):
    table = {"columns": [{"name": "TimeGenerated"}, {"name": "_ItemId"}], "rows": [["t", None]]}
    _logs_api(monkeypatch, lambda r: httpx.Response(200, json={"tables": [table]}))
    assert await performance_service.first_item(TRACE, _settings()) is None


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


# --- the network an interview ran on --------------------------------------------------------


def _table(**row):
    return {"tables": [{"columns": [{"name": k} for k in row], "rows": [list(row.values())]}]}


_STATS = _table(
    samples=5,
    rtt_p95=294,
    loss_avg=0,
    down_p50=846,
    resolution="512x512",
    avatar_ok=1,
    avatar_failed=0,
    relay=1,
    ws_audio=0,
)


def _logs_by_query(monkeypatch, *, items, legacy=None, stats=_STATS, seen=None):
    """A Logs API that answers each of the three network queries by its shape."""

    def handler(request):
        query = json.loads(request.content)["query"]
        if seen is not None:
            seen.append(query)
        if "summarize n = count()" in query:
            return httpx.Response(200, json=_table(n=items))
        if "summarize seen = min(TimeGenerated)" in query:
            rows = legacy or []
            return httpx.Response(
                200,
                json={
                    "tables": [
                        {
                            "columns": [{"name": "OperationId"}, {"name": "seen"}],
                            "rows": [[o, "2026-10-15T05:09:08Z"] for o in rows],
                        }
                    ]
                },
            )
        return httpx.Response(200, json=stats)

    _logs_api(monkeypatch, handler)


async def test_network_of_an_interview_with_the_fixed_id(monkeypatch):
    seen = []
    _logs_by_query(monkeypatch, items=186, seen=seen)
    interview_id = performance_service.interview_id_for(TRACE)
    found = await performance_service.interview_network(TRACE, interview_id, _settings())
    assert found.legacy is False
    assert found.operations == [(TRACE, None)]
    assert found.media == performance_service.MediaStats(
        samples=5, rtt_p95_ms=294, audio_loss_pct=0, available_in_p50_kbps=846, resolution="512x512"
    )
    assert found.avatar == performance_service.AvatarOutcomes(
        connected=1, failed=0, via_relay=1, voice_over_ws=0
    )
    assert f'OperationId in ("{TRACE}")' in seen[-1]
    # An old page operation can span several interviews: only this one's events count.
    assert f'tostring(Properties.interview_id) == "{interview_id}"' in seen[-1]
    # Voice over the WebSocket is a network failure only where an avatar was asked for.
    assert 'tostring(Properties.avatar) == "true"' in seen[-1]


async def test_an_old_interview_is_found_through_its_voice_events(monkeypatch):
    seen = []
    old = ["d92d8f1836be417cb9304fed0d0d78ca", "b5c703de6a28463bb8e115c4b4419c47"]
    _logs_by_query(monkeypatch, items=0, legacy=old, seen=seen)
    interview_id = "a64af22c-c52a-4cc3-9894-da87634b1695"
    found = await performance_service.interview_network(TRACE, interview_id, _settings())
    assert found.legacy is True
    assert [o for o, _ in found.operations] == old
    assert f'tostring(Properties.interview_id) == "{interview_id}"' in seen[1]
    assert all(f'"{o}"' in seen[2] for o in old)


@pytest.mark.parametrize("legacy", [[], ["not-an-operation-id"]])
async def test_no_telemetry_at_all_is_none(monkeypatch, legacy):
    _logs_by_query(monkeypatch, items=0, legacy=legacy)
    interview_id = "a64af22c-c52a-4cc3-9894-da87634b1695"
    assert await performance_service.interview_network(TRACE, interview_id, _settings()) is None


async def test_legacy_ids_are_normalized_before_they_reach_a_query(monkeypatch):
    seen = []
    _logs_by_query(monkeypatch, items=0, legacy=["D92D8F18-36BE-417C-B930-4FED0D0D78CA"], seen=seen)
    interview_id = "a64af22c-c52a-4cc3-9894-da87634b1695"
    found = await performance_service.interview_network(TRACE, interview_id, _settings())
    assert [o for o, _ in found.operations] == ["d92d8f1836be417cb9304fed0d0d78ca"]
    assert '"d92d8f1836be417cb9304fed0d0d78ca"' in seen[-1]


async def test_one_token_for_every_query_of_a_lookup(monkeypatch):
    tokens = []

    async def _token(scope):
        tokens.append(scope)
        return "token"

    _logs_by_query(monkeypatch, items=0, legacy=["c" * 32])
    monkeypatch.setattr(performance_service.azure_auth, "get_bearer_token", _token)
    interview_id = "a64af22c-c52a-4cc3-9894-da87634b1695"
    await performance_service.interview_network(TRACE, interview_id, _settings())
    assert len(tokens) == 1, "three queries, one credential"


async def test_the_outcome_lists_are_ones_the_page_sends():
    """The query counts `voice.avatar` outcomes by name; a name the page never sends counts
    nothing, silently."""
    sent = set(re.findall(r'finish\("([a-z_]+)"\)', _AVATAR_STREAM_SOURCE))
    for outcome in (*performance_service.AVATAR_CONNECTED, *performance_service.AVATAR_FAILED):
        assert outcome in sent, outcome


async def test_no_media_samples_reads_as_no_value_not_nan(monkeypatch):
    empty = _table(
        samples=0,
        rtt_p95=None,
        loss_avg="NaN",
        down_p50=None,
        resolution="",
        avatar_ok=0,
        avatar_failed=1,
        relay=0,
        ws_audio=1,
    )
    _logs_by_query(monkeypatch, items=3, stats=empty)
    found = await performance_service.interview_network(
        TRACE, performance_service.interview_id_for(TRACE), _settings()
    )
    assert found.media == performance_service.MediaStats(0, None, None, None, None)
    assert found.avatar.voice_over_ws == 1


async def test_the_legacy_query_takes_only_an_interview_id():
    with pytest.raises(ValueError):
        performance_service._legacy_operations_query('x" or 1==1')
    with pytest.raises(ValueError):
        performance_service._network_query([TRACE], 'x" or 1==1')


async def test_network_route(client, admin_auth, configured, monkeypatch):
    headers = await mint_candidate_headers(client)
    await client.post("/candidate/interview/start", headers={**headers, "traceparent": TRACEPARENT})
    _logs_by_query(monkeypatch, items=10)
    body = (
        await client.get(f"/admin/performance/operations/{TRACE}/network", headers=admin_auth)
    ).json()
    assert body["status"] == "found"
    assert body["legacy"] is False
    assert body["operations"] == [
        {
            "operation_id": TRACE,
            "seen": None,
            "logs_url": performance_service.logs_url(TRACE, configured),
        }
    ]
    assert body["media"]["rtt_p95_ms"] == 294
    assert body["avatar"]["via_relay"] == 1


async def test_network_route_not_found(client, admin_auth, monkeypatch):
    settings = _settings()
    monkeypatch.setattr("app.api.admin_performance.get_settings", lambda: settings)
    path = f"/admin/performance/operations/{TRACE}/network"
    _logs_by_query(monkeypatch, items=0)
    assert (await client.get(path, headers=admin_auth)).json()["status"] == "not_found"


async def test_network_route_unavailable(client, admin_auth, monkeypatch):
    settings = _settings()
    monkeypatch.setattr("app.api.admin_performance.get_settings", lambda: settings)
    path = f"/admin/performance/operations/{TRACE}/network"
    _logs_api(monkeypatch, lambda r: httpx.Response(403, json={}))
    body = (await client.get(path, headers=admin_auth)).json()
    assert body["status"] == "unavailable"
    assert "Log Analytics Data Reader" in body["reason"]


async def test_download(client, admin_auth):
    resp = await client.get("/admin/performance/download?kb=8", headers=admin_auth)
    assert resp.status_code == 200
    assert len(resp.content) == 8 * 1024
    assert resp.headers["cache-control"] == "no-store"
    again = await client.get("/admin/performance/download?kb=8", headers=admin_auth)
    assert again.content != resp.content, "random, so nothing in front of the app can compress it"


async def test_download_is_bounded_and_admin_only(client, admin_auth):
    assert (
        await client.get("/admin/performance/download?kb=4096", headers=admin_auth)
    ).status_code == 422
    assert (
        await client.get("/admin/performance/download?kb=0", headers=admin_auth)
    ).status_code == 422
    assert (await client.get("/admin/performance/download")).status_code == 401


@pytest.mark.skipif(
    bool(os.environ.get("CI"))
    or not os.environ.get("E2E_LOG_ANALYTICS_WORKSPACE_ID")
    or not os.environ.get("E2E_NETWORK_OPERATION_ID"),
    reason="needs a real Log Analytics workspace (local only)",
)
async def test_interview_network_against_the_real_workspace():
    settings = _settings(log_analytics_workspace_id=os.environ["E2E_LOG_ANALYTICS_WORKSPACE_ID"])
    operation_id = os.environ["E2E_NETWORK_OPERATION_ID"]
    found = await performance_service.interview_network(
        operation_id, performance_service.interview_id_for(operation_id), settings
    )
    assert found is not None
    assert found.media.samples > 0
    assert found.media.rtt_p95_ms and found.media.rtt_p95_ms > 0


async def test_network_route_finds_an_old_interview_without_its_row(
    client, admin_auth, configured, monkeypatch
):
    """The voice events carry the dashed interview id: no database row is needed to find them."""
    seen = []
    _logs_by_query(monkeypatch, items=0, legacy=["c" * 32], seen=seen)
    body = (
        await client.get(f"/admin/performance/operations/{TRACE}/network", headers=admin_auth)
    ).json()
    assert body["status"] == "found"
    assert body["legacy"] is True
    assert [o["operation_id"] for o in body["operations"]] == ["c" * 32]
    assert performance_service.interview_id_for(TRACE) in seen[1]


# --- the settings a grade is compared with --------------------------------------------------


async def test_config_without_an_interview_is_the_default_interviewer(
    client, admin_auth, db_session, monkeypatch
):
    from app.services import persona_service as psvc

    await psvc.create_persona(
        db_session, name="Ava", character="lisa", style="casual-sitting", is_default=True
    )
    settings = _settings(voice_live_avatar_video_bitrate=300000)
    monkeypatch.setattr("app.api.admin_performance.get_settings", lambda: settings)
    body = (await client.get("/admin/performance/config", headers=admin_auth)).json()
    assert body["source"] == "default"
    assert body["interviewer"]["name"] == "Ava"
    assert body["interviewer"]["avatar"] == "video"
    assert body["avatar_video_bitrate"] == 300000
    assert body["input_sampling_rate"] == 16000


async def test_config_for_an_interview_is_its_own_interviewer(client, admin_auth, db_session):
    from app.services import persona_service as psvc

    await psvc.create_persona(
        db_session, name="Default", character="lisa", style="casual-sitting", is_default=True
    )
    headers = await mint_candidate_headers(client)
    await client.post("/candidate/interview/start", headers={**headers, "traceparent": TRACEPARENT})
    # The default changes after the interview started: the interview keeps its own interviewer.
    await psvc.create_persona(db_session, name="Later", character="amara", is_default=True)
    body = (
        await client.get(f"/admin/performance/config?operation_id={TRACE}", headers=admin_auth)
    ).json()
    assert body["source"] == "interview"
    assert body["interviewer"]["name"] == "Default"


async def test_config_for_an_interview_without_a_pinned_interviewer(client, admin_auth, db_session):
    from app.services import persona_service as psvc

    headers = await mint_candidate_headers(client)
    await client.post("/candidate/interview/start", headers={**headers, "traceparent": TRACEPARENT})
    await psvc.create_persona(db_session, name="Photo", character="amara", is_default=True)
    body = (
        await client.get(f"/admin/performance/config?operation_id={TRACE}", headers=admin_auth)
    ).json()
    assert body["source"] == "default_fallback"
    assert body["interviewer"] == {
        "id": body["interviewer"]["id"],
        "name": "Photo",
        "avatar": "photo",
        "character": "amara",
    }


async def test_config_of_an_unknown_id_falls_back_to_the_default_and_a_bad_id_is_422(
    client, admin_auth, db_session
):
    from app.services import persona_service as psvc

    await psvc.create_persona(db_session, name="Voice only", is_default=True)
    body = (
        await client.get(f"/admin/performance/config?operation_id={'d' * 32}", headers=admin_auth)
    ).json()
    assert body["source"] == "default_fallback"
    assert body["interviewer"]["avatar"] == "none"
    bad = await client.get("/admin/performance/config?operation_id=nope", headers=admin_auth)
    assert bad.status_code == 422


async def test_config_with_no_interviewer_at_all(client, admin_auth):
    body = (await client.get("/admin/performance/config", headers=admin_auth)).json()
    assert body["interviewer"] is None
