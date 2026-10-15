"""Admin Performance tab: an operation id's interview and its links into Application Insights.

docs/planning/spec-admin-performance-tab.md. Every interview runs under one fixed operation id (its
own id without the dashes), so the lookup is a computation plus one database read. The end-to-end
transaction link needs the operation's first telemetry item, which only the Logs query API knows, so
it has a route of its own and the page asks for it on demand.
"""

import os
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_db
from app.dependencies import require_role
from app.models.interview import InterviewSession
from app.models.persona import InterviewerPersona
from app.schemas.history import InterviewResultItem
from app.services import interview_history_service, performance_service, persona_service
from app.services.agents.voice_live_metadata import is_photo_avatar

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


class OperationLink(BaseModel):
    operation_id: str
    # When it was first seen (an interview from before the fixed operation id only).
    seen: str | None = None
    logs_url: str | None


class MediaStatsOut(BaseModel):
    samples: int
    rtt_p95_ms: float | None
    audio_loss_pct: float | None
    available_in_p50_kbps: float | None
    resolution: str | None


class AvatarOutcomesOut(BaseModel):
    connected: int
    failed: int
    via_relay: int
    voice_over_ws: int


class InterviewNetworkOut(BaseModel):
    """The network one interview ran on, from its own telemetry; the page grades it (A to D)."""

    # found: the fields below are set; not_found: App Insights has nothing for it (yet);
    # unavailable: the Logs query API cannot be asked, ``reason`` says why.
    status: Literal["found", "not_found", "unavailable"]
    reason: str | None = None
    # True for an interview from before the fixed operation id: ``operations`` are the page
    # operations its voice events name, each with its own Logs link.
    legacy: bool = False
    operations: list[OperationLink] = []
    media: MediaStatsOut | None = None
    avatar: AvatarOutcomesOut | None = None


class InterviewerOut(BaseModel):
    id: str
    name: str
    # The digital human: a 1080p video avatar, a 512x512 photo avatar, or none (voice-only).
    avatar: Literal["video", "photo", "none"]
    character: str


class CurrentConfig(BaseModel):
    """The settings a grade's recommendation is compared with (docs/network-grades.md §2)."""

    # default: no interview chosen, so the default interviewer (what a new candidate gets unless
    # assigned another); interview: the interviewer that interview was pinned to; default_fallback:
    # an id was looked up but no interviewer is recorded for it (the interview predates the pin,
    # its interviewer was deleted, or it is not in this database), so the default stands in.
    source: Literal["default", "interview", "default_fallback"]
    interviewer: InterviewerOut | None
    # Deployment settings (the same for every interviewer). None = Azure's default (2 Mbps).
    avatar_video_bitrate: int | None
    input_sampling_rate: int


# The download check: enough to time over a slow link, small enough to repeat every two minutes.
MAX_DOWNLOAD_KB = 2048


def _operation_or_422(raw: str) -> str:
    operation_id = performance_service.normalize(raw)
    if operation_id is None:
        raise HTTPException(status_code=422, detail="An operation id is 32 hex characters")
    return operation_id


@router.get("/links", response_model=PerformanceLinks)
async def links() -> PerformanceLinks:
    settings = get_settings()
    return PerformanceLinks(
        workbook_url=performance_service.workbook_url(settings),
        logs=performance_service.logs_configured(settings),
        transaction=performance_service.transaction_configured(settings),
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


@router.get("/operations/{operation_id}/network", response_model=InterviewNetworkOut)
async def network(operation_id: str) -> InterviewNetworkOut:
    """The interview's RTT, loss, downlink and avatar outcomes, through the Logs query API (a few
    seconds). An interview from before the fixed operation id is found through its voice events."""
    operation_id = _operation_or_422(operation_id)
    settings = get_settings()
    # The id with its dashes back is the interview id the voice events carry, whether or not the
    # interview's row still exists (or is in this database at all).
    interview_id = performance_service.interview_id_for(operation_id)
    try:
        found = await performance_service.interview_network(operation_id, interview_id, settings)
    except performance_service.LookupUnavailable as exc:
        return InterviewNetworkOut(status="unavailable", reason=str(exc))
    if found is None:
        return InterviewNetworkOut(status="not_found")
    return InterviewNetworkOut(
        status="found",
        legacy=found.legacy,
        operations=[
            OperationLink(
                operation_id=op,
                seen=seen,
                logs_url=performance_service.logs_url(op, settings),
            )
            for op, seen in found.operations
        ],
        media=MediaStatsOut(**vars(found.media)),
        avatar=AvatarOutcomesOut(**vars(found.avatar)),
    )


@router.get("/download")
async def download(kb: Annotated[int, Query(ge=1, le=MAX_DOWNLOAD_KB)] = 256) -> Response:
    """``kb`` KiB of random bytes for the tab's downlink check: incompressible, so the response
    compression in front of the app cannot shrink what is timed, and never cached."""
    return Response(
        content=os.urandom(kb * 1024),
        media_type="application/octet-stream",
        headers={"Cache-Control": "no-store"},
    )


def _interviewer(persona: InterviewerPersona | None) -> InterviewerOut | None:
    if persona is None:
        return None
    character = (persona.character or "").strip()
    if not character:
        avatar = "none"
    elif is_photo_avatar(character, persona.style):
        avatar = "photo"
    else:
        avatar = "video"
    return InterviewerOut(id=persona.id, name=persona.name, avatar=avatar, character=character)


@router.get("/config", response_model=CurrentConfig)
async def current_config(
    operation_id: str | None = None, db: AsyncSession = Depends(get_db)
) -> CurrentConfig:
    """The interviewer and settings to compare a grade with: the interview's own interviewer when
    ``operation_id`` names an interview, else the default interviewer."""
    settings = get_settings()
    source: Literal["default", "interview", "default_fallback"] = "default"
    persona = None
    if operation_id is not None:
        interview_id = performance_service.interview_id_for(_operation_or_422(operation_id))
        session = await db.get(InterviewSession, interview_id)
        # An id that is no interview here: still a lookup, so not "no interview chosen".
        source = "default_fallback"
        if session is not None:
            pinned = None
            if session.persona_id:
                try:
                    pinned = await persona_service.get_persona(db, session.persona_id)
                except persona_service.PersonaNotFound:
                    pinned = None
            persona, source = (pinned, "interview") if pinned else (None, "default_fallback")
    if persona is None:
        persona = await persona_service.get_default_persona(db)
    return CurrentConfig(
        source=source,
        interviewer=_interviewer(persona),
        # 0 means unset, as in the proxy (``if settings.voice_live_avatar_video_bitrate``).
        avatar_video_bitrate=settings.voice_live_avatar_video_bitrate or None,
        input_sampling_rate=settings.voice_live_input_sampling_rate,
    )
