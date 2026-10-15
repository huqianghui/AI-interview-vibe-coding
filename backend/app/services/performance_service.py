"""The admin Performance tab's links into Application Insights (spec-admin-performance-tab).

Every interview runs under ONE fixed operation id, its own id without the dashes. A fresh interview
ADOPTS the page's operation id (the trace id of the ``/start`` call's ``traceparent``) as its id, so
the sign-in page, ``/start`` and the whole interview are one operation; the page then pins it for
the rest of the interview (reloads, reconnects). With no usable trace id (telemetry off, or the id
already an interview's: a Restart on the same page) the interview gets a random UUID, and the page
pins that instead. Either way an interview and its trace map to each other with no lookup table.

The portal links are built from the deployment's settings (``monitor_*``, ``app_insights_name``,
``perf_workbook_id``), never hardcoded: a client deployment runs in its own tenant. A setting left
empty hides only the link that needs it.
"""

from __future__ import annotations

import base64
import gzip
import json
import logging
import math
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from urllib.parse import quote

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import telemetry
from app.config import Settings
from app.models.interview import InterviewSession
from app.services import azure_auth

logger = logging.getLogger(__name__)

_OPERATION_ID = re.compile(r"[0-9a-f]{32}")
LOGS_QUERY_URL = "https://api.loganalytics.io/v1/workspaces/{workspace}/query"
# App Insights keeps 90 days by default; an older operation is simply "not found".
LOOKUP_TIMESPAN = "P90D"
LOOKUP_TIMEOUT_S = 15
_PORTAL = "https://portal.azure.com/#@{tenant}"


def operation_id_for(interview_id: str) -> str:
    """The operation id an interview's telemetry is filed under."""
    return interview_id.replace("-", "").lower()


def normalize(raw: str) -> str | None:
    """A pasted operation id (or interview id, dashes and all) as 32 lowercase hex, or None."""
    value = raw.strip().lower().replace("-", "")
    if not _OPERATION_ID.fullmatch(value) or value == "0" * 32:
        return None
    return value


def interview_id_for(operation_id: str) -> str:
    """The interview id an operation id would be: the UUID with its dashes put back."""
    o = operation_id
    return f"{o[:8]}-{o[8:12]}-{o[12:16]}-{o[16:20]}-{o[20:]}"


async def adoptable_id(db: AsyncSession, traceparent: str | None) -> str | None:
    """The interview id a fresh interview takes from the page's ``traceparent``, or None (then it
    gets a random one). The browser chose the trace id, so it is used only when well formed and not
    already an interview's; it grants nothing either way (every route checks ownership)."""
    operation_id = telemetry.trace_id(traceparent)
    if operation_id is None:
        return None
    candidate = interview_id_for(operation_id)
    taken = await db.execute(select(InterviewSession.id).where(InterviewSession.id == candidate))
    return None if taken.first() is not None else candidate


def _app_insights_id(settings: Settings) -> str | None:
    if not (settings.monitor_subscription_id and settings.monitor_resource_group):
        return None
    if not settings.app_insights_name:
        return None
    return (
        f"/subscriptions/{settings.monitor_subscription_id}"
        f"/resourceGroups/{settings.monitor_resource_group}"
        f"/providers/Microsoft.Insights/components/{settings.app_insights_name}"
    )


def _checked(operation_id: str) -> str:
    """The id goes into KQL verbatim, so only ever 32 hex (what :func:`normalize` returns)."""
    if not _OPERATION_ID.fullmatch(operation_id):
        raise ValueError("not a normalized operation id")
    return operation_id


def logs_configured(settings: Settings) -> bool:
    """Whether the Logs link can be built (the tenant and the App Insights resource are set)."""
    return bool(settings.monitor_tenant_id) and _app_insights_id(settings) is not None


def transaction_configured(settings: Settings) -> bool:
    """Whether the end-to-end lookup can run (the workspace and the App Insights resource)."""
    return bool(settings.log_analytics_workspace_id) and _app_insights_id(settings) is not None


def logs_query(operation_id: str) -> str:
    """Every telemetry item of one operation, browser and backend, in time order."""
    operation_id = _checked(operation_id)
    return (
        "union requests, dependencies, customEvents, pageViews, traces, exceptions\n"
        f'| where operation_Id == "{operation_id}"\n'
        '| project timestamp, itemType, side = iff(client_Type == "Browser", "browser", '
        '"backend"), name, duration, success, resultCode, id, operation_ParentId\n'
        "| order by timestamp asc"
    )


def logs_url(operation_id: str, settings: Settings) -> str | None:
    """Logs, scoped to the App Insights resource, with :func:`logs_query` already in the editor.

    The portal's share-link format: the query gzipped, base64, then URL-encoded."""
    resource = _app_insights_id(settings)
    if resource is None or not logs_configured(settings):
        return None
    packed = base64.b64encode(gzip.compress(logs_query(operation_id).encode())).decode()
    return (
        _PORTAL.format(tenant=settings.monitor_tenant_id)
        + "/blade/Microsoft_OperationsManagementSuite_Workspace/Logs.ReactView/resourceId/"
        + quote(resource, safe="")
        + "/source/LogsBlade.AnalyticsShareLinkToQuery/q/"
        + quote(packed, safe="")
        + f"/timespan/{LOOKUP_TIMESPAN}"
    )


def workbook_url(settings: Settings) -> str | None:
    """The Voice performance workbook. The portal has no documented way to pre-fill a workbook
    parameter from a URL, so the page offers the id to copy into its Operation id box."""
    if not (settings.perf_workbook_id and settings.monitor_tenant_id):
        return None
    if not (settings.monitor_subscription_id and settings.monitor_resource_group):
        return None
    return (
        _PORTAL.format(tenant=settings.monitor_tenant_id)
        + f"/resource/subscriptions/{settings.monitor_subscription_id}"
        + f"/resourceGroups/{settings.monitor_resource_group}"
        + f"/providers/Microsoft.Insights/workbooks/{settings.perf_workbook_id}/workbook"
    )


def end_to_end_url(item_id: str, timestamp: str, settings: Settings) -> str | None:
    """App Insights' end-to-end transaction view, opened on one item of the operation."""
    if _app_insights_id(settings) is None:
        return None
    model = json.dumps({"eventId": item_id, "timestamp": timestamp}, separators=(",", ":"))
    component = json.dumps(
        {
            "Name": settings.app_insights_name,
            "ResourceGroup": settings.monitor_resource_group,
            "SubscriptionId": settings.monitor_subscription_id,
        },
        separators=(",", ":"),
    )
    return (
        "https://portal.azure.com/#view/AppInsightsExtension/DetailsV2Blade/DataModel~/"
        + quote(model, safe="")
        + "/ComponentId~/"
        + quote(component, safe="")
    )


class LookupUnavailable(Exception):
    """The Logs query API cannot be asked: not configured, no credential, or refused."""


@dataclass(frozen=True)
class FirstItem:
    item_id: str
    timestamp: str


def _first_item_query(operation_id: str) -> str:
    # isfuzzy: a workspace that has no rows of one kind yet has no such table, and a plain union
    # then fails the whole query (measured).
    operation_id = _checked(operation_id)
    return (
        "union isfuzzy=true AppPageViews, AppRequests, AppDependencies\n"
        f'| where OperationId == "{operation_id}"\n'
        "| summarize arg_min(TimeGenerated, _ItemId)\n"
        "| where isnotempty(_ItemId)"
    )


class _LogsSession:
    """One token and one HTTP client for the Logs queries of one lookup (a lookup runs up to three:
    a fresh credential and TLS client per query cost a token round trip each)."""

    def __init__(self, settings: Settings, token: str, client: httpx.AsyncClient):
        self._url = LOGS_QUERY_URL.format(workspace=settings.log_analytics_workspace_id)
        self._token = token
        self._client = client

    async def run(self, kql: str) -> list[dict]:
        """Rows of one query, as dicts (columns by name). Raises :class:`LookupUnavailable` when
        the query is refused (most likely: no Log Analytics Data Reader role), does not answer, or
        answers a shape the API does not document."""
        try:
            response = await self._client.post(
                self._url,
                headers={"Authorization": f"Bearer {self._token}"},
                json={"query": kql, "timespan": LOOKUP_TIMESPAN},
            )
        except httpx.HTTPError as exc:
            reason = f"The Logs query API did not answer ({type(exc).__name__})"
            raise LookupUnavailable(reason) from exc
        if response.status_code in (401, 403):
            raise LookupUnavailable(
                "The Logs query API refused the managed identity (needs Log Analytics Data Reader)"
            )
        if response.status_code >= 400:
            raise LookupUnavailable(f"The Logs query API answered {response.status_code}")
        try:
            tables = response.json().get("tables") or []
            if not tables:
                return []
            columns = [c["name"] for c in tables[0]["columns"]]
            return [dict(zip(columns, row, strict=False)) for row in tables[0].get("rows") or []]
        except (ValueError, KeyError, TypeError, AttributeError, IndexError) as exc:
            reason = f"The Logs query API answered something unexpected ({type(exc).__name__})"
            raise LookupUnavailable(reason) from exc


@asynccontextmanager
async def _logs_session(settings: Settings) -> AsyncIterator[_LogsSession]:
    """Raises :class:`LookupUnavailable` when the workspace is not configured or the managed
    identity has no token."""
    if not settings.log_analytics_workspace_id:
        raise LookupUnavailable("The Log Analytics workspace is not configured")
    token = await azure_auth.get_bearer_token(azure_auth.LOG_ANALYTICS_SCOPE)
    if token is None:
        raise LookupUnavailable("No Azure credential for the Logs query API")
    async with httpx.AsyncClient(timeout=LOOKUP_TIMEOUT_S) as client:
        yield _LogsSession(settings, token, client)


async def first_item(operation_id: str, settings: Settings) -> FirstItem | None:
    """The operation's earliest page view, request or dependency; None when there is none (yet:
    telemetry reaches the workspace minutes after it happened). Raises
    :class:`LookupUnavailable` (see :class:`_LogsSession`)."""
    async with _logs_session(settings) as logs:
        rows = await logs.run(_first_item_query(operation_id))
    if not rows:
        return None
    item_id, timestamp = rows[0].get("_ItemId"), rows[0].get("TimeGenerated")
    if not item_id or not timestamp:
        return None
    return FirstItem(item_id=str(item_id), timestamp=str(timestamp))


# --- the network an interview ran on --------------------------------------------------------

_INTERVIEW_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
# `voice.avatar` outcomes (frontend/src/hooks/useAvatarStream.ts): the handshake got media, or it
# failed on the network. The rest (closed, superseded, rebuilt) say nothing about the network.
AVATAR_CONNECTED = ("frame", "audio")
AVATAR_FAILED = ("ice_failed", "no_frame", "sdp_timeout", "handshake_failed")


def _kql_list(values: tuple[str, ...]) -> str:
    return ", ".join(f'"{v}"' for v in values)


# An interview that predates the fixed operation id ran under several page operations.
MAX_LEGACY_OPERATIONS = 20


@dataclass(frozen=True)
class MediaStats:
    """The avatar's WebRTC quality over the interview (`voice.media`, one sample per 15 s)."""

    samples: int
    rtt_p95_ms: float | None
    audio_loss_pct: float | None
    available_in_p50_kbps: float | None
    # The avatar's video size: 512x512 is a photo avatar, 1920x1080 a video avatar.
    resolution: str | None


@dataclass(frozen=True)
class AvatarOutcomes:
    """How the avatar's WebRTC handshakes went (`voice.avatar`, `voice.setup`)."""

    connected: int
    failed: int
    via_relay: int
    voice_over_ws: int


@dataclass(frozen=True)
class InterviewNetwork:
    # The operations its telemetry is filed under: [the interview's own] or, for an interview
    # from before the fixed operation id, the ones its voice events name.
    operations: list[tuple[str, str | None]]
    legacy: bool
    media: MediaStats
    avatar: AvatarOutcomes


def _number(value: object) -> float | None:
    """A query value as a number; None for empty, unparseable, and NaN (``avg`` over no samples
    answers NaN, measured)."""
    try:
        number = None if value in (None, "") else float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return None if number is None or math.isnan(number) else number


def _has_items_query(operation_id: str) -> str:
    operation_id = _checked(operation_id)
    return (
        "union isfuzzy=true AppPageViews, AppRequests, AppDependencies, AppEvents\n"
        f'| where OperationId == "{operation_id}"\n'
        "| summarize n = count()"
    )


def _legacy_operations_query(interview_id: str) -> str:
    if not _INTERVIEW_ID.fullmatch(interview_id):
        raise ValueError("not an interview id")
    # `seen`, not `first`: that is a reserved word in KQL (measured).
    return (
        "AppEvents\n"
        '| where Name startswith "voice."\n'
        f'| where tostring(Properties.interview_id) == "{interview_id}"\n'
        "| summarize seen = min(TimeGenerated) by OperationId\n"
        "| order by seen asc\n"
        f"| take {MAX_LEGACY_OPERATIONS}"
    )


def _network_query(operation_ids: list[str], interview_id: str) -> str:
    ids = ", ".join(f'"{_checked(o)}"' for o in operation_ids)
    if not _INTERVIEW_ID.fullmatch(interview_id):
        raise ValueError("not an interview id")
    # Two summaries joined on a constant: there is no percentileif in this dialect (measured). The
    # interview id narrows it: an old page operation can span several interviews.
    return f"""let ev = AppEvents
    | where OperationId in ({ids}) and Name in ("voice.media", "voice.avatar", "voice.setup")
    | where tostring(Properties.interview_id) == "{interview_id}";
let media = ev
    | where Name == "voice.media" and isnotnull(Measurements.rtt_ms)
    | summarize samples = count(), rtt_p95 = percentile(todouble(Measurements.rtt_ms), 95),
        loss_avg = avg(todouble(Measurements.audio_loss_pct)),
        down_p50 = percentile(todouble(Measurements.available_in_kbps), 50),
        resolution = take_any(tostring(Properties.resolution));
let rest = ev
    | summarize
        avatar_ok = countif(Name == "voice.avatar"
            and tostring(Properties.outcome) in ({_kql_list(AVATAR_CONNECTED)})),
        avatar_failed = countif(Name == "voice.avatar"
            and tostring(Properties.outcome) in ({_kql_list(AVATAR_FAILED)})),
        relay = countif(Name == "voice.avatar" and tostring(Properties.local_candidate) == "relay"),
        ws_audio = countif(Name == "voice.setup" and tostring(Properties.audio_path) == "ws"
            and tostring(Properties.avatar) == "true");
media | extend k = 1 | join kind=inner (rest | extend k = 1) on k | project-away k, k1"""


async def interview_network(
    operation_id: str, interview_id: str, settings: Settings
) -> InterviewNetwork | None:
    """The network the interview behind ``operation_id`` ran on, from its own telemetry; None
    when App Insights has nothing for it (yet). Raises :class:`LookupUnavailable`."""
    operations: list[tuple[str, str | None]] = [(operation_id, None)]
    legacy = False
    async with _logs_session(settings) as logs:
        counted = await logs.run(_has_items_query(operation_id))
        items = int(_number(counted[0].get("n")) or 0) if counted else 0
        if items == 0:
            found = await logs.run(_legacy_operations_query(interview_id))
            operations = []
            for r in found:
                normalized = normalize(str(r.get("OperationId") or ""))
                if normalized:
                    operations.append((normalized, str(r.get("seen") or "") or None))
            if not operations:
                return None
            legacy = True
        rows = await logs.run(_network_query([o for o, _ in operations], interview_id))
    row = rows[0] if rows else {}
    media = MediaStats(
        samples=int(_number(row.get("samples")) or 0),
        rtt_p95_ms=_number(row.get("rtt_p95")),
        audio_loss_pct=_number(row.get("loss_avg")),
        available_in_p50_kbps=_number(row.get("down_p50")),
        resolution=str(row.get("resolution") or "") or None,
    )
    avatar = AvatarOutcomes(
        connected=int(_number(row.get("avatar_ok")) or 0),
        failed=int(_number(row.get("avatar_failed")) or 0),
        via_relay=int(_number(row.get("relay")) or 0),
        voice_over_ws=int(_number(row.get("ws_audio")) or 0),
    )
    return InterviewNetwork(operations=operations, legacy=legacy, media=media, avatar=avatar)
