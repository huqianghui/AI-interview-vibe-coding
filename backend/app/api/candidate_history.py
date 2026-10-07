"""The candidate's own interview history (#187): every interview, with its saved report."""

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.interview import serve_cited_document
from app.db import get_db
from app.dependencies import get_anonymous_session
from app.models.anonymous_session import AnonymousCandidateSession
from app.schemas.history import InterviewDetail, InterviewHistoryItem
from app.services import interview_history_service

router = APIRouter(prefix="/candidate/interviews", tags=["interview-history"])


@router.get("", response_model=list[InterviewHistoryItem])
async def my_interviews(
    candidate: AnonymousCandidateSession = Depends(get_anonymous_session),
    db: AsyncSession = Depends(get_db),
) -> list[InterviewHistoryItem]:
    """The caller's interviews, newest first, every status."""
    return await interview_history_service.list_for_candidate(db, candidate)


@router.get("/{interview_id}", response_model=InterviewDetail)
async def my_interview(
    interview_id: str,
    candidate: AnonymousCandidateSession = Depends(get_anonymous_session),
    db: AsyncSession = Depends(get_db),
) -> InterviewDetail:
    """One of the caller's interviews with its saved report and transcript (404 when not theirs)."""
    detail = await interview_history_service.get_detail(db, interview_id, candidate=candidate)
    if detail is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")
    return detail


@router.get("/{interview_id}/sop/{document_id}")
async def my_interview_sop(
    interview_id: str,
    document_id: str,
    candidate: AnonymousCandidateSession = Depends(get_anonymous_session),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """A SOP document cited by one of the caller's past reports (the live-report rule, user-scoped:
    an interview from an earlier login's session is still theirs)."""
    session = await interview_history_service.find_session(db, interview_id, candidate=candidate)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    return await serve_cited_document(db, session, document_id)
