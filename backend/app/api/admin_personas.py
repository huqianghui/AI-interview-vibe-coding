"""Admin persona management (SPEC F5). All routes require the admin bearer token.

These endpoints configure the interviewer digital human — identity, voice knobs, and the Foundry
agent binding. They are strictly admin-only (``require_admin``): a candidate's anonymous session
must never reach persona config (SPEC P3/P4 boundary — persona prompt fragments are interviewer
internals).

Agent sync runs inline through the configured agent-sync adapter (mock in dev/CI, Azure with a
Foundry endpoint). A sync failure is captured as ``agent_sync_status=failed`` + error and returned
in the persona payload — it never 500s the create/update (F5 AC #4).
"""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.dependencies import require_admin
from app.models.persona import InterviewerPersona
from app.services import persona_service as svc
from app.services.agents.registry import get_agent_sync_adapter

router = APIRouter(
    prefix="/admin/personas", tags=["admin-personas"], dependencies=[Depends(require_admin)]
)


class VoiceKnobs(BaseModel):
    turn_detection: str = "azure_semantic_vad"
    eou_detection: bool = True
    noise_suppression: bool = True
    echo_cancellation: bool = True
    interim_response: bool = True
    proactive_engagement: bool = False
    voice_temperature: float = 0.8
    playback_speed: float = 1.0


class PersonaCreate(VoiceKnobs):
    name: str = Field(min_length=1, max_length=120)
    character: str = ""
    style: str = ""
    prompt_fragment: str = ""
    voice_map: str = "{}"
    greeting_map: str = "{}"
    enabled: bool = True
    is_default: bool = False


class PersonaUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    character: str | None = None
    style: str | None = None
    prompt_fragment: str | None = None
    voice_map: str | None = None
    greeting_map: str | None = None
    enabled: bool | None = None
    is_default: bool | None = None
    turn_detection: str | None = None
    eou_detection: bool | None = None
    noise_suppression: bool | None = None
    echo_cancellation: bool | None = None
    interim_response: bool | None = None
    proactive_engagement: bool | None = None
    voice_temperature: float | None = None
    playback_speed: float | None = None


class PersonaOut(BaseModel):
    id: str
    name: str
    character: str
    style: str
    prompt_fragment: str
    voice_map: str
    greeting_map: str
    enabled: bool
    is_default: bool
    turn_detection: str
    eou_detection: bool
    noise_suppression: bool
    echo_cancellation: bool
    interim_response: bool
    proactive_engagement: bool
    voice_temperature: float
    playback_speed: float
    agent_id: str | None
    agent_version: str | None
    agent_sync_status: str
    agent_sync_error: str | None

    @classmethod
    def of(cls, p: InterviewerPersona) -> "PersonaOut":
        return cls(**{f: getattr(p, f) for f in cls.model_fields})


async def _sync(db: AsyncSession, persona: InterviewerPersona) -> None:
    """Sync a persona to its Foundry agent, recording status either way (never raises)."""
    await svc.mark_sync_pending(db, persona)
    try:
        result = await get_agent_sync_adapter().sync_persona(persona)
    except Exception as exc:  # noqa: BLE001 — a sync failure is a recorded state, not a 500
        await svc.mark_sync_failed(db, persona, error=str(exc))
        return
    await svc.mark_sync_succeeded(
        db, persona, agent_id=result["agent_id"], agent_version=result["agent_version"]
    )


@router.get("", response_model=list[PersonaOut])
async def list_all(db: AsyncSession = Depends(get_db)) -> list[PersonaOut]:
    return [PersonaOut.of(p) for p in await svc.list_personas(db)]


@router.post("", response_model=PersonaOut, status_code=status.HTTP_201_CREATED)
async def create(body: PersonaCreate, db: AsyncSession = Depends(get_db)) -> PersonaOut:
    try:
        persona = await svc.create_persona(db, **body.model_dump())
    except svc.PersonaConflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    await _sync(db, persona)
    return PersonaOut.of(persona)


@router.get("/{persona_id}", response_model=PersonaOut)
async def get_one(persona_id: str, db: AsyncSession = Depends(get_db)) -> PersonaOut:
    try:
        return PersonaOut.of(await svc.get_persona(db, persona_id))
    except svc.PersonaNotFound as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Persona not found"
        ) from exc


@router.put("/{persona_id}", response_model=PersonaOut)
async def update(
    persona_id: str, body: PersonaUpdate, db: AsyncSession = Depends(get_db)
) -> PersonaOut:
    changes = body.model_dump(exclude_unset=True)
    try:
        persona = await svc.update_persona(db, persona_id, **changes)
    except svc.PersonaNotFound as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Persona not found"
        ) from exc
    except svc.PersonaConflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    # Config that affects the agent changed → re-sync.
    await _sync(db, persona)
    return PersonaOut.of(persona)


@router.post("/{persona_id}/set-default", response_model=PersonaOut)
async def set_default(persona_id: str, db: AsyncSession = Depends(get_db)) -> PersonaOut:
    try:
        return PersonaOut.of(await svc.set_default(db, persona_id))
    except svc.PersonaNotFound as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Persona not found"
        ) from exc


@router.post("/{persona_id}/retry-sync", response_model=PersonaOut)
async def retry_sync(persona_id: str, db: AsyncSession = Depends(get_db)) -> PersonaOut:
    try:
        persona = await svc.get_persona(db, persona_id)
    except svc.PersonaNotFound as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Persona not found"
        ) from exc
    await _sync(db, persona)
    return PersonaOut.of(persona)
