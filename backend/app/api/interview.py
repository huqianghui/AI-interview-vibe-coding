"""Interview thin-slice endpoints (SPEC F6/F9 spine, Step 0).

All routes require a valid anonymous candidate session (X-Anon-Session). Interview ownership is
enforced: a candidate can only drive an interview whose candidate_session_id matches their own
session (defense against IDOR — a decoded token for session A must not touch session B's data).

Step 0 exposes just enough to prove ask → answer → placeholder report over the text channel.
Voice sources (voice / verbal_cue) share the same answer_finalized event and are accepted here.
"""

import json
from dataclasses import asdict
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db, get_session_factory
from app.dependencies import get_anonymous_session
from app.interview import state_machine
from app.interview.state_machine import ANSWER_SOURCES, InterviewStateError
from app.models.anonymous_session import AnonymousCandidateSession
from app.models.interview import InterviewSession
from app.models.sop import SopDocument
from app.services import question_service, voice_broker
from app.services.storage import get_storage
from app.services.voice_broker import DEFAULT_LOCALE, VoiceAgentNotSynced, VoiceUnavailable

router = APIRouter(prefix="/candidate/interview", tags=["interview"])


class QuestionOut(BaseModel):
    question_id: str
    prompt: str
    index: int
    total: int
    # True when ``prompt`` is a pending follow-up (cites the prior answer), not the base question.
    # Voice uses this to NOT verbatim-read follow-ups: the agent's own server-VAD auto-response
    # already voices a clarification, so reading the backend follow-up too speaks it twice (and
    # renders two transcript bubbles). Text channel ignores it and shows the authoritative prompt.
    is_follow_up: bool = False


class BankQuestionOut(BaseModel):
    """Candidate-safe question projection (SPEC F2 AC #2). NO expected_points/rubric (P3)."""

    question_id: str
    text: str
    order_index: int
    language: str


class QuestionListOut(BaseModel):
    bank_id: str | None
    language: str | None
    questions: list[BankQuestionOut]


class InterviewOut(BaseModel):
    interview_session_id: str
    status: str
    current_question: QuestionOut | None


class AnswerIn(BaseModel):
    text: str
    source: str = "text"

    @field_validator("text")
    @classmethod
    def _text_not_blank(cls, v: str) -> str:
        # Requirement 3: every question must be answered — an empty (or whitespace-only) answer
        # cannot pass. Reject at the edge with a 422 so a blank voice/text submission never reaches
        # the state machine or the report as an "unanswered" gap. The state machine keeps a
        # defensive check for the verbal-cue path (a cue that strips to empty).
        if not v.strip():
            raise ValueError("Answer text must not be empty")
        return v


class ReportOut(BaseModel):
    interview_session_id: str
    status: str
    coverage_pct: float
    per_question: list[dict]
    is_stub: bool
    # F4 scored-report fields (present once questions are graded against a checklist; None/empty
    # for the stub path). Per-item judgments + SOP/answer quotes live inside per_question entries.
    total_score: float | None = None
    grade: str | None = None
    # Classification rating: Meets Expectations / Needs Improvement / Does Not Meet.
    # ``capped`` is True when a confirmed critical error forced the outcome to Needs Improvement
    # (per-question ``outcome``/``capped`` ride in per_question entries). None for the stub path.
    outcome: str | None = None
    capped: bool = False
    warnings: list[str] = []
    # F8 executive-headline narrative (1-2 sentences, strengths + main gap). Empty for stub path.
    narrative: str = ""
    # Feature D (opt-in): reference-only "SOP points the rubric may not cover", per question. None
    # when the check wasn't requested or found nothing. Advisory — never affects any score above.
    sop_coverage: list[dict] | None = None


class ReportOptionsIn(BaseModel):
    """Optional scoring options for the report route. Body is optional; defaults preserve today's
    behaviour (no coverage check, no extra LLM calls)."""

    # Feature D: run the SOP original-text coverage check. Default off.
    sop_coverage_check: bool = False


class AnsweredQuestionOut(BaseModel):
    """One question + the candidate's finalized answer, for the pre-scoring review screen.

    Candidate-safe (P3): prompt + the answer the candidate gave, in bank order. Deliberately
    carries NO checklist / score / rubric — review happens before scoring, and scoring stays
    interviewer-internal until the report.
    """

    question_id: str
    prompt: str
    index: int
    answer_text: str


class ReviewOut(BaseModel):
    interview_session_id: str
    status: str
    answers: list[AnsweredQuestionOut]


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
    avatar_enabled: bool = False


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


@router.get("/questions", response_model=QuestionListOut)
async def list_questions(
    candidate: AnonymousCandidateSession = Depends(get_anonymous_session),
    db: AsyncSession = Depends(get_db),
) -> QuestionListOut:
    """Candidate-facing ordered question list from the default bank (SPEC F2 AC #2).

    Projects each question to a candidate-safe shape — ``expected_points`` (which links to the
    scoring rubric) is never included (SPEC P3). An empty list when no bank is seeded.
    """
    bank = await question_service.get_default_bank(db)
    if bank is None:
        return QuestionListOut(bank_id=None, language=None, questions=[])
    rows = await question_service.list_questions_for_bank(db, bank.id, enabled_only=True)
    return QuestionListOut(
        bank_id=bank.id,
        language=bank.language,
        questions=[
            BankQuestionOut(
                question_id=q.id,
                text=q.text,
                order_index=q.order_index,
                language=q.language,
            )
            for q in rows
        ],
    )


@router.post("/start", response_model=InterviewOut)
async def start(
    candidate: AnonymousCandidateSession = Depends(get_anonymous_session),
    db: AsyncSession = Depends(get_db),
) -> InterviewOut:
    session = await state_machine.start_interview(db, candidate.id)
    question = await state_machine.get_current_question(db, session)
    return _to_interview_out(session, question)


@router.get("/{interview_id}", response_model=InterviewOut)
async def get_interview(
    interview_id: str,
    candidate: AnonymousCandidateSession = Depends(get_anonymous_session),
    db: AsyncSession = Depends(get_db),
) -> InterviewOut:
    """Read an interview's status + current question without mutating it (SPEC F6 edge b: resume).

    Ownership-guarded like every candidate route. Lets a reloaded browser replay the pending
    question (``get_current_question`` returns the pending follow-up when one is owed) instead of
    starting a brand-new session. ``current_question`` is None once completed/scored.
    """
    session = await _owned_interview(db, interview_id, candidate)
    question = await state_machine.get_current_question(db, session)
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
    question = await state_machine.get_current_question(db, session)
    return _to_interview_out(session, question)


@router.post("/{interview_id}/report", response_model=ReportOut)
async def report(
    interview_id: str,
    options: ReportOptionsIn | None = None,
    candidate: AnonymousCandidateSession = Depends(get_anonymous_session),
    db: AsyncSession = Depends(get_db),
) -> ReportOut:
    session = await _owned_interview(db, interview_id, candidate)
    sop_coverage_check = options.sop_coverage_check if options else False
    try:
        result = await state_machine.score_and_finalize(
            db, session, sop_coverage_check=sop_coverage_check
        )
    except InterviewStateError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return ReportOut(**result)


@router.post("/{interview_id}/report/stream")
async def report_stream(
    interview_id: str,
    options: ReportOptionsIn | None = None,
    candidate: AnonymousCandidateSession = Depends(get_anonymous_session),
    db: AsyncSession = Depends(get_db),
    session_factory=Depends(get_session_factory),
) -> StreamingResponse:
    """Streaming variant of ``/report``: NDJSON progress lines, then the full report.

    Each LLM grading call takes seconds, so a 10-question interview sat behind one long batch
    request while the scoring screen FAKED its progress numerator. This endpoint emits one
    ``{"type":"progress","done":i,"total":n,...}`` line per question as grading proceeds and ends
    with ``{"type":"report","report":{...}}`` — the same dict the batch endpoint returns.

    NDJSON over a POST fetch (not SSE): EventSource can't POST or send the X-Anon-Session header,
    and the frontend already talks fetch — the reader just splits on newlines. A scoring failure
    mid-stream surfaces as a final ``{"type":"error","detail":...}`` line (the 200 status is
    already on the wire; in-band error is the streaming contract, mirroring the WS proxy).
    Pre-stream state errors (wrong status) still 409 like the batch endpoint.
    """
    session = await _owned_interview(db, interview_id, candidate)
    if session.status not in ("completed", "scored"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot score in status {session.status!r}",
        )
    sop_coverage_check = options.sop_coverage_check if options else False

    async def event_lines():
        # FastAPI closes `Depends(get_db)`'s session when the route function RETURNS — before this
        # generator body runs (yield-dependency teardown precedes response streaming since FastAPI
        # 0.106). Scoring therefore opens its own session (from the injected factory, so tests that
        # override it hit the test DB) and re-loads the interview row; ownership was already
        # verified above with the request-scoped session.
        try:
            async with session_factory() as stream_db:
                stream_session = await stream_db.get(InterviewSession, session.id)
                if stream_session is None:  # deleted between the check and the stream
                    raise InterviewStateError("Interview session no longer exists")
                async for event in state_machine.score_and_finalize_events(
                    stream_db, stream_session, sop_coverage_check=sop_coverage_check
                ):
                    yield json.dumps(event, ensure_ascii=False) + "\n"
        except InterviewStateError as exc:
            yield json.dumps({"type": "error", "detail": str(exc)}) + "\n"

    return StreamingResponse(
        event_lines(),
        media_type="application/x-ndjson",
        # Belt-and-braces for proxies that buffer despite chunked encoding (nginx honors this).
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/{interview_id}/review", response_model=ReviewOut)
async def review(
    interview_id: str,
    candidate: AnonymousCandidateSession = Depends(get_anonymous_session),
    db: AsyncSession = Depends(get_db),
) -> ReviewOut:
    """Every question + the candidate's finalized answer, in bank order, for the pre-scoring
    review screen (requirement 4: the candidate reviews holistically, then explicitly submits).

    Ownership-guarded like every candidate route. Only meaningful once all questions are answered,
    so a still-``in_progress`` interview is a 409 — the same "not before completion" contract as
    ``/report``. Backend-sourced (not client-accumulated) so it survives a reload and can never
    disagree with what gets scored: it reuses the SAME question_id join that scoring uses.
    """
    session = await _owned_interview(db, interview_id, candidate)
    if session.status not in ("completed", "scored"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot review in status {session.status!r}",
        )
    answers = await state_machine.review_answers(db, session)
    return ReviewOut(
        interview_session_id=session.id,
        status=session.status,
        answers=[AnsweredQuestionOut(**a) for a in answers],
    )


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


@router.get("/{interview_id}/sop/{document_id}")
async def sop_document(
    interview_id: str,
    document_id: str,
    candidate: AnonymousCandidateSession = Depends(get_anonymous_session),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Serve one SOP source document so a candidate can open a report citation in the browser.

    This is a deliberate, tightly-scoped relaxation of the SOP-privacy boundary (SPEC P4/P12): a
    candidate may open ONLY the specific source documents cited by their OWN scored report, and only
    server-mediated — the raw ``blob_path`` is never exposed, and the frontend fetches these bytes
    with the ``X-Anon-Session`` header (not a naked URL), so the file previews inline without the
    token ever landing in a link. Two independent guards, both 404 (never leak existence):

    - **Ownership** — the interview must belong to this candidate's session (``_owned_interview``).
    - **Citation scope (IDOR guard)** — ``document_id`` must be cited by a default-checklist item of
      a question this interview actually answered (``cited_document_ids``). An arbitrary or uncited
      id is indistinguishable from a missing one.
    """
    session = await _owned_interview(db, interview_id, candidate)
    allowed = await state_machine.cited_document_ids(db, session)
    if document_id not in allowed:
        # Same 404 whether uncited, unknown, or not-owned: don't reveal which SOP documents exist.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    doc = (
        await db.execute(select(SopDocument).where(SopDocument.id == document_id))
    ).scalar_one_or_none()
    if doc is None or not doc.blob_path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    try:
        content = get_storage().load(doc.blob_path)
    except (FileNotFoundError, OSError) as exc:
        # The row exists but its bytes are gone (e.g. a pruned storage root) — 404, not a 500.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Document not found"
        ) from exc
    # Inline so the browser previews (PDF/text) rather than force-downloading; RFC 5987 filename*
    # carries a non-ASCII (e.g. Chinese) document name safely.
    disposition = f"inline; filename*=UTF-8''{quote(doc.name)}"
    return Response(
        content=content,
        media_type=doc.content_type or "application/octet-stream",
        headers={"Content-Disposition": disposition},
    )
