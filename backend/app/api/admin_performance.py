"""Admin Performance tab: an operation id's interview and its links into Application Insights.

docs/planning/spec-admin-performance-tab.md. Every interview runs under one fixed operation id (its
own id without the dashes), so the lookup is a computation plus one database read. The end-to-end
transaction link needs the operation's first telemetry item, which only the Logs query API knows, so
it has a route of its own and the page asks for it on demand.
"""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_db
from app.dependencies import require_role
from app.schemas.history import InterviewResultItem
from app.services import interview_history_service, performance_service

router = APIRouter(
    prefix="/admin/performance",
    tags=["admin-performance"],
    dependencies=[Depends(require_role("admin"))],
)


class PerformanceLinks(BaseModel):
    """What this deployment can link to (an empty setting hides the link that needs it)."""

    workbook_url: str | None
    logs: bool
    transaction: bool


class OperationLookup(BaseModel):
    operation_id: str
    # The interview this operation id is, or None (another page's operation, or not an interview).
    interview: InterviewResultItem | None
    logs_url: str | None
    workbook_url: str | None


class TransactionLink(BaseModel):
    # found: ``url`` opens the end-to-end view; not_found: no telemetry for it (yet: ingestion takes
    # minutes); unavailable: the Logs query API cannot be asked, ``reason`` says why.
    status: Literal["found", "not_found", "unavailable"]
    url: str | None = None
    reason: str | None = None


def _operation_or_422(raw: str) -> str:
    operation_id = performance_service.normalize(raw)
    if operation_id is None:
        raise HTTPException(status_code=422, detail="An operation id is 32 hex characters")
    return operation_id


@router.get("/links", response_model=PerformanceLinks)
async def links() -> PerformanceLinks:
    settings = get_settings()
    probe = "0" * 31 + "1"
    return PerformanceLinks(
        workbook_url=performance_service.workbook_url(settings),
        logs=performance_service.logs_url(probe, settings) is not None,
        transaction=bool(settings.log_analytics_workspace_id)
        and performance_service.end_to_end_url("x", "x", settings) is not None,
    )


@router.get("/operations/{operation_id}", response_model=OperationLookup)
async def lookup(operation_id: str, db: AsyncSession = Depends(get_db)) -> OperationLookup:
    """The interview an operation id belongs to, and its Logs and workbook links. 422 when the id
    is not 32 hex (an interview id with its dashes is accepted too)."""
    operation_id = _operation_or_422(operation_id)
    settings = get_settings()
    page = await interview_history_service.search_results(
        db,
        interview_history_service.ResultFilters(
            interview_id=performance_service.interview_id_for(operation_id)
        ),
        limit=1,
    )
    return OperationLookup(
        operation_id=operation_id,
        interview=page.items[0] if page.items else None,
        logs_url=performance_service.logs_url(operation_id, settings),
        workbook_url=performance_service.workbook_url(settings),
    )


@router.get("/operations/{operation_id}/transaction", response_model=TransactionLink)
async def transaction(operation_id: str) -> TransactionLink:
    """The end-to-end transaction link, found through the Logs query API (a few seconds)."""
    operation_id = _operation_or_422(operation_id)
    settings = get_settings()
    try:
        item = await performance_service.first_item(operation_id, settings)
    except performance_service.LookupUnavailable as exc:
        return TransactionLink(status="unavailable", reason=str(exc))
    if item is None:
        return TransactionLink(status="not_found")
    url = performance_service.end_to_end_url(item.item_id, item.timestamp, settings)
    if url is None:
        return TransactionLink(status="unavailable", reason="App Insights is not configured")
    return TransactionLink(status="found", url=url)
