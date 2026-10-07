"""Admin read of any interview (#187): detail (saved report + transcript), and scoring one.

The per-user list lives on ``/admin/users/{user_id}/interviews``; this router is the single
interview, whoever it belongs to.
"""

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.interview import serve_cited_document
from app.db import get_db, get_session_factory
from app.dependencies import require_role
from app.interview import state_machine
from app.models.interview import InterviewSession
from app.schemas.history import InterviewDetail
from app.services import interview_history_service

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
