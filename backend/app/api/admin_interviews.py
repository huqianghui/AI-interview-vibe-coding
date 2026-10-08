"""Admin interview results: every candidate's interviews (filtered, sorted, paged), one
interview's detail (saved report + transcript), and scoring one (#187)."""

import asyncio
import logging
from datetime import date, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.interview import serve_cited_document
from app.db import get_db, get_session_factory
from app.dependencies import require_role
from app.interview import state_machine
from app.interview.scoring_engine import OUTCOMES
from app.models.interview import INTERVIEW_STATUSES, InterviewRecording, InterviewSession
from app.schemas.history import InterviewDetail, InterviewResultsPage
from app.services import interview_history_service, recording_service

logger = logging.getLogger(__name__)

# Interviews being scored right now by an admin request. Process-local, like the judge's in-flight
# guard: safe because the backend runs a single replica (see judge_flow._JUDGE_IN_FLIGHT).
_SCORING: set[str] = set()
_TASKS: set[asyncio.Task] = set()  # references, so a running task is not garbage-collected

router = APIRouter(
    prefix="/admin/interviews",
    tags=["admin-interviews"],
    dependencies=[Depends(require_role("admin"))],
)


# Every status a session can have (INTERVIEW_STATUSES predates "abandoned", v0.38.3.0).
_FILTER_STATUSES = (*INTERVIEW_STATUSES, "abandoned")


@router.get("", response_model=InterviewResultsPage)
async def list_results(
    user_id: str | None = None,
    status_in: Annotated[list[str] | None, Query(alias="status")] = None,
    persona_id: str | None = None,
    bank_id: str | None = None,
    started_from: date | None = None,
    started_to: date | None = None,
    outcome: str | None = None,
    score_min: Annotated[float | None, Query(ge=0, le=100)] = None,
    score_max: Annotated[float | None, Query(ge=0, le=100)] = None,
    sort: Annotated[str, Query(pattern="^(started_at|total_score)$")] = "started_at",
    order: Annotated[str, Query(pattern="^(asc|desc)$")] = "desc",
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
    db: AsyncSession = Depends(get_db),
) -> InterviewResultsPage:
    """Every candidate's interviews for the admin results table: filtered, sorted, one page.

    ``status`` may repeat (``?status=scored&status=completed``). 422 on an unknown status or
    outcome, a reversed date or score range, or a bad sort/order/page parameter.
    """
    statuses = tuple(status_in or ())
    bad = [s for s in statuses if s not in _FILTER_STATUSES]
    if bad:
        raise HTTPException(status_code=422, detail=f"Unknown status: {', '.join(bad)}")
    if outcome is not None and outcome not in OUTCOMES:
        raise HTTPException(status_code=422, detail=f"Unknown outcome: {outcome}")
    if started_from and started_to and started_from > started_to:
        raise HTTPException(status_code=422, detail="started_from is after started_to")
    if score_min is not None and score_max is not None and score_min > score_max:
        raise HTTPException(status_code=422, detail="score_min is above score_max")
    filters = interview_history_service.ResultFilters(
        user_id=user_id,
        statuses=statuses,
        persona_id=persona_id,
        bank_id=bank_id,
        started_from=started_from,
        started_to=started_to,
        outcome=outcome,
        score_min=score_min,
        score_max=score_max,
    )
    return await interview_history_service.search_results(
        db, filters, sort=sort, descending=order == "desc", limit=limit, offset=offset
    )


@router.get("/{interview_id}", response_model=InterviewDetail)
async def interview_detail(
    interview_id: str, db: AsyncSession = Depends(get_db)
) -> InterviewDetail:
    detail = await interview_history_service.get_detail(db, interview_id)
    if detail is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")
    return detail.model_copy(update={"scoring": interview_id in _SCORING})


async def _score_in_background(interview_id: str, session_factory) -> None:
    try:
        async with session_factory() as db:
            session = (
                await db.execute(
                    select(InterviewSession).where(InterviewSession.id == interview_id)
                )
            ).scalar_one_or_none()
            if session is not None:
                await state_machine.score_and_finalize(db, session)
    except Exception:
        logger.exception("Admin scoring failed for interview %s", interview_id)
    finally:
        _SCORING.discard(interview_id)


@router.post("/{interview_id}/report", status_code=status.HTTP_202_ACCEPTED)
async def generate_report(
    interview_id: str,
    db: AsyncSession = Depends(get_db),
    session_factory=Depends(get_session_factory),
) -> dict:
    """Start scoring a finished interview the candidate never submitted (or re-score one).

    Scoring takes ~18 s per question, longer than the ingress idle timeout for a whole interview,
    so this does not hold the request open: it starts the same scoring the candidate's submit runs
    in the background and returns 202. The page polls ``GET /{interview_id}`` until the saved
    report appears. 409 while not finished, while a scoring run for it is already going, and for an
    external-brain interview (its provider owns the results; nothing is scored here).
    """
    session = (
        await db.execute(select(InterviewSession).where(InterviewSession.id == interview_id))
    ).scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")
    if session.brain_mode == "external":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An external-brain interview is scored by its provider",
        )
    if session.status not in ("completed", "scored"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot score in status {session.status!r}",
        )
    if interview_id in _SCORING:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="This interview is already being scored"
        )
    _SCORING.add(interview_id)
    task = asyncio.create_task(_score_in_background(interview_id, session_factory))
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
    return {"status": "scoring"}


@router.get("/{interview_id}/sop/{document_id}")
async def interview_sop(
    interview_id: str, document_id: str, db: AsyncSession = Depends(get_db)
) -> Response:
    """A SOP document cited by this interview's report, so the admin's report links open."""
    session = await interview_history_service.find_session(db, interview_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    return await serve_cited_document(db, session, document_id)


class RecordingOut(BaseModel):
    recording_id: str
    question_index: int
    duration_ms: int
    size_bytes: int
    created_at: datetime | None


@router.get("/{interview_id}/recordings", response_model=list[RecordingOut])
async def interview_recordings(
    interview_id: str, db: AsyncSession = Depends(get_db)
) -> list[RecordingOut]:
    """The candidate's recorded answers, one per question (the microphone only, kept
    ``recording_retention_days``). Admin-only, like every route here."""
    if await interview_history_service.find_session(db, interview_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")
    return [
        RecordingOut(
            recording_id=r.id,
            question_index=r.question_index,
            duration_ms=r.duration_ms,
            size_bytes=r.size_bytes,
            created_at=r.created_at,
        )
        for r in await recording_service.list_recordings(db, interview_id)
    ]


@router.get("/{interview_id}/recordings/{recording_id}")
async def interview_recording_audio(
    interview_id: str, recording_id: str, db: AsyncSession = Depends(get_db)
) -> Response:
    """One recording's WAV, streamed through the backend (the container is private). 410 once the
    retention period has deleted it."""
    recording = await db.get(InterviewRecording, recording_id)
    if recording is None or recording.interview_session_id != interview_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recording not found")
    try:
        audio = await asyncio.to_thread(recording_service.load_audio, recording)
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_410_GONE, detail="The recording has expired"
        ) from exc
    return Response(
        content=audio,
        media_type="audio/wav",
        headers={"Cache-Control": "private, no-store"},
    )
