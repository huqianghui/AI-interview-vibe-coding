"""Interview thin-slice endpoints (SPEC F6/F9 spine, Step 0).

All routes require a valid anonymous candidate session (X-Anon-Session). Interview ownership is
enforced: a candidate can only drive an interview whose candidate_session_id matches their own
session (defense against IDOR — a decoded token for session A must not touch session B's data).

Step 0 exposes just enough to prove ask → answer → placeholder report over the text channel.
Voice sources (voice / verbal_cue) share the same answer_finalized event and are accepted here.
"""

import json
import logging
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db, get_session_factory
from app.dependencies import get_anonymous_session
from app.interview import external_runner, judge_flow, state_machine
from app.interview.external_runner import ExternalTurnConflict
from app.interview.state_machine import ANSWER_SOURCES, InterviewStateError
from app.models.anonymous_session import AnonymousCandidateSession
from app.models.interview import InterviewSession
from app.models.judge_event import JUDGE_TRIGGERS
from app.services import (
    assignment_service,
    persona_service,
    recording_service,
    sop_document_service,
)
from app.services.agents.voice_live_metadata import has_configured_voice

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/candidate/interview", tags=["interview"])


class CurrentQuestionOut(BaseModel):
    question_id: str
    prompt: str
    index: int
    total: int
    # True when ``prompt`` is a pending follow-up (cites the prior answer), not the base question.
    # Voice uses this to NOT verbatim-read follow-ups: the agent's own server-VAD auto-response
    # already voices a clarification, so reading the backend follow-up too speaks it twice (and
    # renders two transcript bubbles). Text channel ignores it and shows the authoritative prompt.
    is_follow_up: bool = False
    # How many follow-ups have been asked on this question so far (judged mode sends it back with
    # each ``/judge`` request so the server can drop stale requests — issue #114).
    follow_ups_asked: int = 0


class InterviewOut(BaseModel):
    interview_session_id: str
    status: str
    current_question: CurrentQuestionOut | None
    # --- Phase 2 external-brain fields (None for bank sessions) --------------------------------
    # The external sub-state ("idle" | "awaiting" | "recovery_required"), so the UI can show the
    # "面试官思考中…" (awaiting) or "恢复" (recovery_required) affordance. None ⇒ bank session.
    external_phase: str | None = None
    # The current external question's speech text (for TTS/voice reading), candidate-safe. The
    # display text rides in ``current_question.prompt``. None for bank sessions / no pending Q.
    speech_text: str | None = None
    # True when the default interviewer persona has a configured voice — the UI then defaults the
    # candidate to the voice + digital-human channel instead of text (issue 3). Best-effort intent
    # only: a failed voice connect still degrades to text exactly as before. Populated on the two
    # entry points (start / GET-resume); the mutation routes leave it False (the UI reads it once).
    voice_default: bool = False
    # Voice answer auto-submit window from the default persona's pair for THIS session's engine
    # (admin-controlled per engine; bank defaults OFF, external defaults ON): ``0`` ⇒ disabled (the
    # turn advances only on the "I'm done" click); ``N > 0`` ⇒ the page auto-submits the buffered
    # voice answer after N seconds of silence. ``None`` ⇒ "not reported on this response" — like
    # ``voice_default`` it is populated only on the two entry points (start / GET-resume) and the
    # UI latches it per session, so a mutation response never turns the feature off mid-interview.
    voice_auto_submit_seconds: int | None = None
    # LINEAR TURNS for THIS session's voice channel: ``True`` ⇒ the model gets no generative turn of
    # its own between questions (the digital human only reads what the backend hands it; the page
    # never nudges a bare ``response.create``); ``False`` ⇒ the model keeps its turn and the prompt
    # governs it. External sessions are always ``True``; bank sessions follow the default persona's
    # admin-set ``bank_turn_mode``. Same reporting contract as ``voice_auto_submit_seconds``: set on
    # the two entry points (start / GET-resume), ``None`` on mutation responses, latched by the UI.
    voice_linear_turns: bool | None = None
    # Voice answers are recorded (the microphone only, kept ``recording_retention_days``): the page
    # tells the candidate before the voice interview starts. False = nothing is recorded.
    audio_recorded: bool = False
    recording_retention_days: int = 0
    # JUDGED sessions (issue #114): seconds of silence (voice) / idle (text) after which the page
    # asks the judge (``POST /{id}/judge``). ``0`` ⇒ the session is not judged (never ask). Same
    # reporting contract as the two flags above: entry points only, ``None`` on mutations, latched.
    voice_judge_silence_seconds: int | None = None
    # The default persona's avatar character id (e.g. ``"amira"``), so the page can paint the stage
    # in that photo's own backdrop colour (editor parity, 2026-09-24). Candidate-safe: it is the
    # same public id the avatar picker shows. Same reporting contract: entry points only, ``None``
    # on mutations, latched by the UI. ``""`` when the persona has no avatar (voice-only / none).
    voice_avatar_character: str | None = None


class JudgeIn(BaseModel):
    """Pre-submit judge request (issue #114). The ids let the server drop STALE requests (a timer
    that fired after the question advanced) without spending an LLM call."""

    question_id: str
    follow_ups_asked: int = 0
    draft_text: str = ""
    trigger: str = "voice_silence"
    # Speculative prefetch (D17): decide now, write nothing; the page calls ``/judge/apply`` with
    # the returned ``event_id`` once the pause has actually lasted the configured window.
    dry_run: bool = False

    @field_validator("trigger")
    @classmethod
    def _trigger_known(cls, v: str) -> str:
        if v not in JUDGE_TRIGGERS:
            raise ValueError(f"trigger must be one of {JUDGE_TRIGGERS}")
        return v


class JudgeApplyIn(BaseModel):
    event_id: str
    question_id: str
    follow_ups_asked: int = 0


class JudgeOut(BaseModel):
    verdict: str  # wait | nudge (follow_up / redirect retired 2026-09-28 — never returned)
    speech_text: str = ""
    # The ``judge_events`` row behind this verdict (dry runs hand it back so the page can apply
    # it).
    event_id: str | None = None
    # Always ``None`` since 2026-09-28: the judge never writes a turn, so there is no refreshed
    # interview to hand back. Kept in the schema so older clients keep parsing the response.
    interview: InterviewOut | None = None


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
    # Questions whose grading failed outright, so a partially-scored report can say so instead of
    # quietly averaging fewer questions than the candidate answered. They are excluded from
    # ``total_score`` rather than scored zero: nobody judged those answers, so there is no basis for
    # calling them bad (P7). None when everything graded. Declared here as well as in the streamed
    # dict because test_report_stream asserts the two report shapes stay identical — the batch
    # endpoint filters through this model, so a field missing here silently disappears from it.
    unscored_question_ids: list[str] | None = None


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


def _to_interview_out(
    session: InterviewSession,
    question: dict | None,
    *,
    voice_default: bool = False,
    voice_auto_submit_seconds: int | None = None,
    voice_linear_turns: bool | None = None,
    voice_judge_silence_seconds: int | None = None,
    voice_avatar_character: str | None = None,
) -> InterviewOut:
    is_external = session.brain_mode == "external"
    return InterviewOut(
        audio_recorded=recording_service.recording_enabled(),
        recording_retention_days=recording_service.retention_days(),
        interview_session_id=session.id,
        status=session.status,
        current_question=CurrentQuestionOut(**question) if question else None,
        external_phase=session.external_phase if is_external else None,
        speech_text=external_runner.speech_text_for(session) if is_external else None,
        voice_default=voice_default,
        voice_auto_submit_seconds=voice_auto_submit_seconds,
        voice_linear_turns=voice_linear_turns,
        voice_judge_silence_seconds=voice_judge_silence_seconds,
        voice_avatar_character=voice_avatar_character,
    )


async def _persona_voice_flags(db: AsyncSession, session: InterviewSession) -> dict:
    """The default persona's candidate-facing voice intent, for the start / resume entry points.

    ``voice_default`` (issue 3): True iff the enabled default persona has an operator-configured
    voice. Deliberately NOT "would voice work" (agent sync, Azure reachability…) — those failures
    already degrade to text at connect time; this only encodes the operator's intent.

    ``voice_auto_submit_seconds``: the admin-controlled silence auto-submit window for the engine
    THIS session runs on (``session.brain_mode`` — the per-session snapshot, so a persona flipped
    mid-interview never re-interprets a live session): ``0`` when that engine's pair is OFF or
    there is no persona, else its configured seconds.

    ``voice_linear_turns``: whether the voice channel runs LINEAR TURNS for this session's engine —
    always ``True`` for external sessions (no brain of their own); for bank sessions the persona's
    admin-set ``bank_turn_mode`` (default linear). With no persona the engine alone decides.
    """
    persona = await persona_service.get_session_persona(db, session)
    judged = session.turn_mode == "judged"
    if persona is None:
        return {
            "voice_default": False,
            "voice_auto_submit_seconds": 0,
            "voice_linear_turns": True,
            "voice_judge_silence_seconds": 0,
            "voice_avatar_character": "",
        }
    return {
        "voice_default": has_configured_voice(persona.voice_map),
        "voice_auto_submit_seconds": persona.voice_auto_submit_seconds_for(session.brain_mode),
        "voice_linear_turns": persona.linear_turns_for(session.brain_mode),
        # The judge is a per-session snapshot decision (turn_mode); only its SECONDS are live-read.
        "voice_judge_silence_seconds": persona.judge_silence_seconds if judged else 0,
        "voice_avatar_character": ((persona.character or "").strip().lower()),
    }


async def _current_question(db: AsyncSession, session: InterviewSession) -> dict | None:
    """Dispatch the candidate-safe current-question projection to the right engine (Phase 2).

    An ``abandoned`` session (the candidate started over) has no question to answer any more — the
    bank projection would otherwise keep replaying the pending one, and the page's resume check
    keys on ``status`` + ``current_question`` (external's own projection already returns None for
    any non-live session).
    """
    if session.status == "abandoned":
        return None
    if session.brain_mode == "external":
        return await external_runner.current_question(db, session)
    return await state_machine.get_current_question(db, session)


def _external_report_stub(session: InterviewSession) -> ReportOut:
    """The candidate report for an external-brain session.

    The external provider owns scoring — the per-question scores/rubric live only in the opaque
    state blob, which is backend-only and MUST NOT reach the browser (SPEC P3/P12). So the candidate
    report is a completion acknowledgement, never the numbers. Vendor-neutral wording by owner
    directive (no product name).
    """
    return ReportOut(
        interview_session_id=session.id,
        status=session.status,
        coverage_pct=0.0,
        per_question=[],
        is_stub=True,
        total_score=None,
        grade=None,
        outcome=None,
        narrative=(
            "This interview was conducted by the external interview provider. "
            "Results are managed by that provider and are not shown here."
        ),
    )


async def _owned_interview(
    db: AsyncSession, interview_id: str, candidate: AnonymousCandidateSession
) -> InterviewSession:
    session = await state_machine.get_owned_interview(db, interview_id, candidate.id)
    # Same 404 whether missing or not-owned: don't leak existence of others' interviews.
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")
    return session


@router.post("/start", response_model=InterviewOut)
async def start(
    candidate: AnonymousCandidateSession = Depends(get_anonymous_session),
    db: AsyncSession = Depends(get_db),
) -> InterviewOut:
    # Resume takes precedence and PRESERVES the session's original engine: a persona flipped to a
    # different brain after an interview started must not re-interpret that live session (that's why
    # brain_mode is a per-session snapshot). Only a fresh start reads the default persona's engine.
    existing = await state_machine.find_resumable_interview(db, candidate.id)
    session = existing if existing is not None else await _start_fresh(db, candidate)
    question = await _current_question(db, session)
    return _to_interview_out(session, question, **(await _persona_voice_flags(db, session)))


async def _start_fresh(db: AsyncSession, candidate: AnonymousCandidateSession) -> InterviewSession:
    """Create a brand-new interview (never resumes) on the candidate's interviewer and bank.

    #187: the user's assignment, else the default, resolved once and pinned onto the session with
    the persona's CURRENT engine and turn contract (review D6): a later edit of the persona, the
    default, or the assignment never re-interprets this interview.
    """
    assigned = await assignment_service.resolve_for_candidate(db, candidate)
    persona = assigned.persona
    persona_id = persona.id if persona else None
    brain = persona.interview_brain if persona else "bank"
    if brain == "external":
        return await external_runner.start_interview(db, candidate.id, persona_id=persona_id)
    turn_mode = persona.bank_turn_mode if persona else "linear"
    return await state_machine.start_interview(
        db,
        candidate.id,
        turn_mode=turn_mode,
        persona_id=persona_id,
        bank_id=assigned.bank_id,
        bank_version_id=assigned.bank_version_id,
    )


@router.post("/{interview_id}/restart", response_model=InterviewOut)
async def restart(
    interview_id: str,
    candidate: AnonymousCandidateSession = Depends(get_anonymous_session),
    db: AsyncSession = Depends(get_db),
) -> InterviewOut:
    """Abandon the candidate's LIVE interview and start a fresh one — the "重新开始" button.

    Why this exists: an in-progress session persists in the DB and ``/start`` (plus the page's
    resume-on-mount) always hands it back, so without this a candidate who wants to start over is
    stuck on the old session until every question is answered. The old session is marked
    ``abandoned`` (kept for the record, never resumed/scored — see
    :func:`state_machine.abandon_interview`); the new one is created exactly like a fresh ``/start``
    (default persona's current engine) and returned with the same entry-point voice flags.

    Only an ``in_progress`` interview can be restarted (409 otherwise — a completed/scored one is
    simply followed by a normal ``/start``). External sessions first send the brain its ``end``
    signal (best-effort: a transport failure still abandons locally; a turn in flight is a 409 like
    ``/end``) so the vendor conversation is closed rather than orphaned.
    """
    session = await _owned_interview(db, interview_id, candidate)
    if session.status != "in_progress":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Only an in-progress interview can be restarted (status: {session.status})",
        )
    if session.brain_mode == "external":
        try:
            session = await external_runner.end(db, session)
        except ExternalTurnConflict as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    try:
        await state_machine.abandon_interview(db, session)
    except state_machine.InterviewStateError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    fresh = await _start_fresh(db, candidate)
    question = await _current_question(db, fresh)
    return _to_interview_out(fresh, question, **(await _persona_voice_flags(db, fresh)))


def _judge_out(outcome: judge_flow.JudgeOutcome) -> JudgeOut:
    return JudgeOut(
        verdict=outcome.verdict, speech_text=outcome.speech_text, event_id=outcome.event_id
    )


@router.post("/{interview_id}/judge", response_model=JudgeOut)
async def judge(
    interview_id: str,
    body: JudgeIn,
    candidate: AnonymousCandidateSession = Depends(get_anonymous_session),
    db: AsyncSession = Depends(get_db),
) -> JudgeOut:
    """Ask the judge whether the interviewer should say something DURING the candidate's pause
    (issue #114). Never blocks or submits anything; "I'm done" is a separate, always-advancing
    route. Stale or over-budget requests are a silent ``wait``; an interview that is not live, or a
    judge already in flight for it, is a 409 (see :func:`judge_flow.judge`)."""
    session = await _owned_interview(db, interview_id, candidate)
    try:
        outcome = await judge_flow.judge(
            db,
            session,
            question_id=body.question_id,
            follow_ups_asked=body.follow_ups_asked,
            draft_text=body.draft_text,
            trigger=body.trigger,
            dry_run=body.dry_run,
        )
    except InterviewStateError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    # wait ⇒ nothing to say; nudge ⇒ text only. The judge never writes a turn, so the header never
    # switches because of it (``interview`` stays None).
    return _judge_out(outcome)


@router.post("/{interview_id}/judge/apply", response_model=JudgeOut)
async def judge_apply(
    interview_id: str,
    body: JudgeApplyIn,
    candidate: AnonymousCandidateSession = Depends(get_anonymous_session),
    db: AsyncSession = Depends(get_db),
) -> JudgeOut:
    """Deliver a dry-run verdict now that the pause has lasted (D17); stale-safe and idempotent
    (see :func:`judge_flow.apply`). An interview that is not live is a 409."""
    session = await _owned_interview(db, interview_id, candidate)
    try:
        outcome = await judge_flow.apply(
            db,
            session,
            event_id=body.event_id,
            question_id=body.question_id,
            follow_ups_asked=body.follow_ups_asked,
        )
    except InterviewStateError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return _judge_out(outcome)


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
    question = await _current_question(db, session)
    return _to_interview_out(session, question, **(await _persona_voice_flags(db, session)))


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
    if session.brain_mode == "external":
        # External engine: CAS-reserved turn + call the brain (with bounded retry). A lost race /
        # submit-while-busy is a 409; retry exhaustion is NOT an error — it returns the session in
        # recovery_required so the UI shows 恢复 (see external_runner.answer).
        try:
            session = await external_runner.answer(db, session, body.text, body.source)
        except ExternalTurnConflict as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
        question = await external_runner.current_question(db, session)
        return _to_interview_out(session, question)

    try:
        # A submit ALWAYS advances, in every turn mode (owner rule, v0.39.2.0): linear sessions
        # never follow up; judged sessions had the judge speak during pauses, before this submit.
        session = await state_machine.answer_finalized(db, session, body.text, body.source)
    except InterviewStateError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    question = await state_machine.get_current_question(db, session)
    return _to_interview_out(session, question)


@router.post("/{interview_id}/recover", response_model=InterviewOut)
async def recover(
    interview_id: str,
    candidate: AnonymousCandidateSession = Depends(get_anonymous_session),
    db: AsyncSession = Depends(get_db),
) -> InterviewOut:
    """Clear a stalled external-brain turn (the candidate's 恢复 action) by re-driving it.

    Only meaningful for an external session whose ``external_phase`` is ``recovery_required`` (or an
    ``awaiting`` one stranded by a crash mid-turn); re-sends the same committed state + pending
    answer, so it can never double-advance (see external_runner.recover). A bank session, or an
    external session with nothing to recover, is a 409. Retry exhaustion again returns
    recovery_required (the candidate may 恢复 again) rather than erroring.
    """
    session = await _owned_interview(db, interview_id, candidate)
    if session.brain_mode != "external":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Not an external-brain interview"
        )
    try:
        session = await external_runner.recover(db, session)
    except ExternalTurnConflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    question = await external_runner.current_question(db, session)
    return _to_interview_out(session, question)


@router.post("/{interview_id}/end", response_model=InterviewOut)
async def end(
    interview_id: str,
    candidate: AnonymousCandidateSession = Depends(get_anonymous_session),
    db: AsyncSession = Depends(get_db),
) -> InterviewOut:
    """Signal an external-brain interview to finalize early and mark it completed (SPEC Phase 2).

    Bank sessions complete implicitly when their questions run out, so this is a no-op that simply
    returns the current state for them. External sessions send the brain an ``end`` turn; a
    transport failure still completes the session locally (the candidate asked to stop).
    """
    session = await _owned_interview(db, interview_id, candidate)
    if session.brain_mode != "external":
        question = await _current_question(db, session)
        return _to_interview_out(session, question)
    try:
        session = await external_runner.end(db, session)
    except ExternalTurnConflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    question = await external_runner.current_question(db, session)
    return _to_interview_out(session, question)


@router.post("/{interview_id}/report", response_model=ReportOut)
async def report(
    interview_id: str,
    options: ReportOptionsIn | None = None,
    candidate: AnonymousCandidateSession = Depends(get_anonymous_session),
    db: AsyncSession = Depends(get_db),
) -> ReportOut:
    session = await _owned_interview(db, interview_id, candidate)
    if session.brain_mode == "external":
        # No local scoring: the external provider owns results, and the scores live only in the
        # backend-only state blob (never surfaced to the candidate). Return the completion notice.
        if session.status not in ("completed", "scored"):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Cannot report in status {session.status!r}",
            )
        return _external_report_stub(session)
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
    if session.brain_mode == "external":
        # No local scoring for external sessions: emit the completion stub as a single report line
        # (the streaming contract's terminal frame) with no progress events. The scores live only in
        # the backend-only state blob and are never surfaced (SPEC P3/P12).
        stub = _external_report_stub(session)

        async def stub_line():
            line = json.dumps({"type": "report", "report": stub.model_dump()}, ensure_ascii=False)
            yield line + "\n"

        return StreamingResponse(
            stub_line(),
            media_type="application/x-ndjson",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
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
        except Exception as exc:  # noqa: BLE001
            # The 200 is already on the wire, so an exception escaping here does not become a 5xx:
            # it tears the connection down and the browser reports a bare network failure ("Failed
            # to fetch") with nothing to show the candidate. Only InterviewStateError was caught
            # before, so a scoring failure bypassed this endpoint's own documented in-band error
            # contract. Everything terminal now leaves as `{"type":"error"}`.
            logger.exception("Report stream failed for interview %s", interview_id)
            yield (
                json.dumps({"type": "error", "detail": f"Scoring failed: {type(exc).__name__}"})
                + "\n"
            )

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
    if session.brain_mode == "external":
        answers = await external_runner.review_answers(db, session)
    else:
        answers = await state_machine.review_answers(db, session)
    return ReviewOut(
        interview_session_id=session.id,
        status=session.status,
        answers=[AnsweredQuestionOut(**a) for a in answers],
    )


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
    return await serve_cited_document(db, session, document_id)


async def serve_cited_document(
    db: AsyncSession, session: InterviewSession, document_id: str
) -> Response:
    """The bytes of one SOP document cited by ``session``'s report, or a 404.

    Shared by the candidate's live report, their history (#187), and the admin's read of any
    interview; each caller has already checked who may read ``session``.
    """
    # Same 404 whether uncited, unknown, bytes gone or not-owned: don't reveal which SOP documents
    # exist.
    found = await sop_document_service.load_cited_document(db, session, document_id)
    if found is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    doc, content = found
    # Inline so the browser previews (PDF/text) rather than force-downloading; RFC 5987 filename*
    # carries a non-ASCII (e.g. Chinese) document name safely.
    disposition = f"inline; filename*=UTF-8''{quote(doc.name)}"
    return Response(
        content=content,
        media_type=doc.content_type or "application/octet-stream",
        headers={"Content-Disposition": disposition},
    )
