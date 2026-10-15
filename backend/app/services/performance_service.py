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
import re
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


async def first_item(operation_id: str, settings: Settings) -> FirstItem | None:
    """The operation's earliest page view, request or dependency; None when there is none (yet:
    telemetry reaches the workspace minutes after it happened).

    Raises :class:`LookupUnavailable` when the workspace is not configured, the managed identity
    has no token, or the query is refused (most likely: no Log Analytics Data Reader role)."""
    if not settings.log_analytics_workspace_id:
        raise LookupUnavailable("The Log Analytics workspace is not configured")
    token = await azure_auth.get_bearer_token(azure_auth.LOG_ANALYTICS_SCOPE)
    if token is None:
        raise LookupUnavailable("No Azure credential for the Logs query API")
    try:
        async with httpx.AsyncClient(timeout=LOOKUP_TIMEOUT_S) as client:
            response = await client.post(
                LOGS_QUERY_URL.format(workspace=settings.log_analytics_workspace_id),
                headers={"Authorization": f"Bearer {token}"},
                json={"query": _first_item_query(operation_id), "timespan": LOOKUP_TIMESPAN},
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
        rows = tables[0].get("rows") if tables else None
        if not rows:
            return None
        columns = [c["name"] for c in tables[0]["columns"]]
        row = dict(zip(columns, rows[0], strict=False))
    except (ValueError, KeyError, TypeError, AttributeError, IndexError) as exc:
        reason = f"The Logs query API answered something unexpected ({type(exc).__name__})"
        raise LookupUnavailable(reason) from exc
    item_id, timestamp = row.get("_ItemId"), row.get("TimeGenerated")
    if not item_id or not timestamp:
        return None
    return FirstItem(item_id=str(item_id), timestamp=str(timestamp))
