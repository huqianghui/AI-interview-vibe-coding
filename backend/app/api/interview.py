"""Interview thin-slice endpoints (SPEC F6/F9 spine, Step 0).

All routes require a valid anonymous candidate session (X-Anon-Session). Interview ownership is
enforced: a candidate can only drive an interview whose candidate_session_id matches their own
session (defense against IDOR — a decoded token for session A must not touch session B's data).

Step 0 exposes just enough to prove ask → answer → placeholder report over the text channel.
Voice sources (voice / verbal_cue) share the same answer_finalized event and are accepted here.
"""

from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.dependencies import get_anonymous_session
from app.interview import state_machine
from app.interview.state_machine import ANSWER_SOURCES, InterviewStateError
from app.models.anonymous_session import AnonymousCandidateSession
from app.models.interview import InterviewSession
from app.services import voice_broker
from app.services.voice_broker import DEFAULT_LOCALE, VoiceAgentNotSynced, VoiceUnavailable

router = APIRouter(prefix="/candidate/interview", tags=["interview"])


class QuestionOut(BaseModel):
    question_id: str
    prompt: str
    index: int
    total: int


class InterviewOut(BaseModel):
    interview_session_id: str
    status: str
    current_question: QuestionOut | None


class AnswerIn(BaseModel):
    text: str
    source: str = "text"


class ReportOut(BaseModel):
    interview_session_id: str
    status: str
    coverage_pct: float
    per_question: list[dict]
    is_stub: bool


class VoiceSessionOut(BaseModel):
    """WebRTC connection info the candidate's browser needs to reach Azure Voice Live directly.

    Deliberately excludes any checklist/rubric/SOP content (P3/P12): a voice session is transport
    setup, not scoring data. ``session_config`` is the snake_case Voice Live config (voice, VAD,
    avatar) — never candidate-facing citations.
    """

    interview_session_id: str
    signaling_url: str
    auth_token: str
    auth_type: str
    mode: str
    model: str
    session_config: dict
    persona_id: str
    character: str
    style: str
    greeting: str | None = None


def _to_interview_out(session: InterviewSession, question: dict | None) -> InterviewOut:
    return InterviewOut(
        interview_session_id=session.id,
        status=session.status,
        current_question=QuestionOut(**question) if question else None,
    )


async def _owned_interview(
    db: AsyncSession, interview_id: str, candidate: AnonymousCandidateSession
) -> InterviewSession:
    session = (
        await db.execute(select(InterviewSession).where(InterviewSession.id == interview_id))
    ).scalar_one_or_none()
    # Same 404 whether missing or not-owned: don't leak existence of others' interviews.
    if session is None or session.candidate_session_id != candidate.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")
    return session


@router.post("/start", response_model=InterviewOut)
async def start(
    candidate: AnonymousCandidateSession = Depends(get_anonymous_session),
    db: AsyncSession = Depends(get_db),
) -> InterviewOut:
    session = await state_machine.start_interview(db, candidate.id)
    question = await state_machine.get_current_question(session)
    return _to_interview_out(session, question)


@router.post("/{interview_id}/answer", response_model=InterviewOut)
async def answer(
    interview_id: str,
    body: AnswerIn,
    candidate: AnonymousCandidateSession = Depends(get_anonymous_session),
    db: AsyncSession = Depends(get_db),
) -> InterviewOut:
    if body.source not in ANSWER_SOURCES:
        # 422 literal, not status.HTTP_422_* — the constant name differs across Starlette
        # versions (ENTITY vs CONTENT); the number is stable and warning-free.
        raise HTTPException(
            status_code=422,
            detail=f"source must be one of {ANSWER_SOURCES}",
        )
    session = await _owned_interview(db, interview_id, candidate)
    try:
        session = await state_machine.answer_finalized(db, session, body.text, body.source)
    except InterviewStateError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    question = await state_machine.get_current_question(session)
    return _to_interview_out(session, question)


@router.post("/{interview_id}/report", response_model=ReportOut)
async def report(
    interview_id: str,
    candidate: AnonymousCandidateSession = Depends(get_anonymous_session),
    db: AsyncSession = Depends(get_db),
) -> ReportOut:
    session = await _owned_interview(db, interview_id, candidate)
    try:
        result = await state_machine.score_and_finalize(db, session)
    except InterviewStateError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return ReportOut(**result)


class VoiceSessionIn(BaseModel):
    locale: str = DEFAULT_LOCALE


@router.post("/{interview_id}/voice/session", response_model=VoiceSessionOut)
async def voice_session(
    interview_id: str,
    body: VoiceSessionIn | None = None,
    candidate: AnonymousCandidateSession = Depends(get_anonymous_session),
    db: AsyncSession = Depends(get_db),
) -> VoiceSessionOut:
    """Broker a direct-to-Azure WebRTC voice session for an in-progress interview (SPEC F9).

    Ownership-guarded like every other candidate route. Voice is only meaningful while the
    interview is live, so a non-``in_progress`` interview is a 409 (the candidate should be on the
    report screen, not connecting a mic). P5: a persona whose Foundry agent is not synced yields a
    409 (``VOICE_AGENT_NOT_SYNCED``) so the frontend falls back to text-only continuation (P6b)
    instead of connecting to an ungrounded model-mode session.
    """
    session = await _owned_interview(db, interview_id, candidate)
    if session.status != "in_progress":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot start voice in status {session.status!r}",
        )
    locale = (body.locale if body else None) or DEFAULT_LOCALE
    try:
        vs = await voice_broker.create_voice_session(db, locale=locale)
    except VoiceAgentNotSynced as exc:
        # 409 (not 5xx): a recorded not-ready state, surfaced so the UI can offer text fallback.
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except VoiceUnavailable as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc
    return VoiceSessionOut(interview_session_id=session.id, **asdict(vs))
