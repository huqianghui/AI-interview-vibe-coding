"""Admin persona management (SPEC F5). All routes require the admin bearer token.

These endpoints configure the interviewer digital human — identity, voice knobs, and the Foundry
agent binding. They are strictly admin-only (``require_admin``): a candidate's anonymous session
must never reach persona config (SPEC P3/P4 boundary — persona prompt fragments are interviewer
internals).

Agent sync runs inline through the configured agent-sync adapter (mock in dev/CI, Azure with a
Foundry endpoint). A sync failure is captured as ``agent_sync_status=failed`` + error and returned
in the persona payload — it never 500s the create/update (F5 AC #4).
"""

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.dependencies import require_role
from app.models.persona import InterviewerPersona
from app.models.persona_knowledge import PersonaKnowledgeConfig
from app.services import config_service
from app.services import persona_knowledge_service as kb_svc
from app.services import persona_service as svc
from app.services.agents import foundry_connections
from app.services.agents.registry import get_agent_sync_adapter

router = APIRouter(
    prefix="/admin/personas", tags=["admin-personas"], dependencies=[Depends(require_role("admin"))]
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
    tools_config: str = "[]"
    # Per-persona model deployment ("" → fall back to the global foundry_agent_model).
    model: str = ""


class PersonaUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    character: str | None = None
    style: str | None = None
    prompt_fragment: str | None = None
    voice_map: str | None = None
    greeting_map: str | None = None
    enabled: bool | None = None
    is_default: bool | None = None
    tools_config: str | None = None
    turn_detection: str | None = None
    eou_detection: bool | None = None
    noise_suppression: bool | None = None
    echo_cancellation: bool | None = None
    interim_response: bool | None = None
    proactive_engagement: bool | None = None
    voice_temperature: float | None = None
    playback_speed: float | None = None
    model: str | None = None


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
    tools_config: str
    turn_detection: str
    eou_detection: bool
    noise_suppression: bool
    echo_cancellation: bool
    interim_response: bool
    proactive_engagement: bool
    voice_temperature: float
    playback_speed: float
    model: str | None
    agent_id: str | None
    agent_version: str | None
    agent_sync_status: str
    agent_sync_error: str | None

    @classmethod
    def of(cls, p: InterviewerPersona) -> "PersonaOut":
        return cls(**{f: getattr(p, f) for f in cls.model_fields})


class PersonaKnowledgeOut(BaseModel):
    id: str
    persona_id: str
    connection_name: str
    connection_target: str
    index_name: str
    server_label: str
    is_enabled: bool

    @classmethod
    def of(cls, c: PersonaKnowledgeConfig) -> "PersonaKnowledgeOut":
        return cls(**{f: getattr(c, f) for f in cls.model_fields})


class PersonaKnowledgeCreate(BaseModel):
    connection_name: str = Field(min_length=1, max_length=255)
    connection_target: str = Field(default="", max_length=500)
    index_name: str = Field(min_length=1, max_length=255)


class Option(BaseModel):
    value: str
    label: str


class TestChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    previous_response_id: str | None = None


class TestChatOut(BaseModel):
    response_text: str
    response_id: str | None = None


class PlaygroundVoiceSessionOut(BaseModel):
    """WebRTC connection info for the editor Playground's voice/avatar test (mirrors the interview
    ``VoiceSessionOut`` minus the interview id — the Playground tests a persona directly)."""

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


class KbConnectionOut(BaseModel):
    """An Azure AI Search connection for the connect dialog. ``target`` (the Search endpoint URL)
    is carried so the client can persist it as ``connection_target`` without a second lookup."""

    name: str
    target: str
    is_default: bool


async def _sync(db: AsyncSession, persona: InterviewerPersona) -> None:
    """Sync a persona to its Foundry agent, recording status either way (never raises).

    Passes THIS persona's attached knowledge bases (per-persona grounding) into the adapter, which
    resolves each to an authenticated KB MCPTool. A KB that can't authenticate makes the sync fail —
    that surfaces as ``agent_sync_status=failed`` here, never a 500.
    """
    await svc.mark_sync_pending(db, persona)
    knowledge_configs = kb_svc.configs_as_dicts(await kb_svc.list_configs(db, persona.id))
    try:
        result = await get_agent_sync_adapter().sync_persona(
            persona, knowledge_configs=knowledge_configs
        )
    except Exception as exc:  # noqa: BLE001 — a sync failure is a recorded state, not a 500
        await svc.mark_sync_failed(db, persona, error=str(exc))
        return
    await svc.mark_sync_succeeded(
        db, persona, agent_id=result["agent_id"], agent_version=result["agent_version"]
    )


async def _foundry_conn(db: AsyncSession) -> tuple[str, str, str]:
    """Resolve (endpoint, project, api_key) for the KB discovery endpoints.

    Uses ``config_service.resolve_foundry_connection`` so a fresh deploy with creds only in ``.env``
    (no saved ``service_configs`` row yet) still populates the connection/knowledge-base dropdowns —
    the DB master row wins when present, ``.env`` is the fallback. Returns empty strings only when
    neither source has an endpoint, so callers degrade to an empty list rather than erroring.
    """
    endpoint, project, key, _model = await config_service.resolve_foundry_connection(db)
    if not endpoint:
        return "", "", ""
    return endpoint, project, key


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


# --- Foundry IQ knowledge (per-persona) ------------------------------------
# NOTE: the static "/knowledge/..." routes MUST be declared before "/{persona_id}" so the router
# doesn't treat "knowledge" as a persona id.


@router.get("/knowledge/connections", response_model=list[KbConnectionOut])
async def list_kb_connections(db: AsyncSession = Depends(get_db)) -> list[KbConnectionOut]:
    """List the project's Azure AI Search connections for the connect dialog (fail-soft → [])."""
    endpoint, project, api_key = await _foundry_conn(db)
    if not endpoint:
        return []
    conns = await foundry_connections.list_search_connections(
        endpoint=endpoint, project=project, api_key=api_key
    )
    return [
        KbConnectionOut(
            name=c["name"], target=c.get("target", ""), is_default=bool(c.get("is_default"))
        )
        for c in conns
        if c.get("name")
    ]


@router.get("/knowledge/knowledge-bases", response_model=list[Option])
async def list_kb_knowledge_bases(
    connection_name: str = Query(default=""), db: AsyncSession = Depends(get_db)
) -> list[Option]:
    """List the Foundry IQ knowledge bases behind a Search connection (fail-soft → [])."""
    endpoint, project, api_key = await _foundry_conn(db)
    if not endpoint:
        return []
    kbs = await foundry_connections.list_knowledge_bases(
        endpoint=endpoint, project=project, api_key=api_key, connection_name=connection_name
    )
    return [
        Option(value=kb["name"], label=kb.get("description") or kb["name"])
        for kb in kbs
        if kb.get("name")
    ]


@router.delete("/knowledge/{config_id}", response_model=PersonaOut)
async def remove_knowledge(config_id: str, db: AsyncSession = Depends(get_db)) -> PersonaOut:
    """Detach a KB from its persona, then re-sync that persona's agent."""
    try:
        removed = await kb_svc.remove_config(db, config_id)
    except kb_svc.PersonaKnowledgeNotFound as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Knowledge config not found"
        ) from exc
    persona = await svc.get_persona(db, removed.persona_id)
    await _sync(db, persona)
    return PersonaOut.of(persona)


@router.get("/{persona_id}/knowledge", response_model=list[PersonaKnowledgeOut])
async def list_knowledge(
    persona_id: str, db: AsyncSession = Depends(get_db)
) -> list[PersonaKnowledgeOut]:
    """List the knowledge bases attached to a persona."""
    try:
        await svc.get_persona(db, persona_id)
    except svc.PersonaNotFound as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Persona not found"
        ) from exc
    return [PersonaKnowledgeOut.of(c) for c in await kb_svc.list_configs(db, persona_id)]


@router.post(
    "/{persona_id}/knowledge",
    response_model=list[PersonaKnowledgeOut],
    status_code=status.HTTP_201_CREATED,
)
async def add_knowledge(
    persona_id: str, body: PersonaKnowledgeCreate, db: AsyncSession = Depends(get_db)
) -> list[PersonaKnowledgeOut]:
    """Attach a KB to a persona, re-sync its agent, and return the updated KB list."""
    try:
        persona = await svc.get_persona(db, persona_id)
    except svc.PersonaNotFound as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Persona not found"
        ) from exc
    await kb_svc.add_config(
        db,
        persona_id,
        connection_name=body.connection_name,
        connection_target=body.connection_target,
        index_name=body.index_name,
    )
    await _sync(db, persona)
    return [PersonaKnowledgeOut.of(c) for c in await kb_svc.list_configs(db, persona_id)]


@router.get("/{persona_id}", response_model=PersonaOut)
async def get_one(persona_id: str, db: AsyncSession = Depends(get_db)) -> PersonaOut:
    try:
        return PersonaOut.of(await svc.get_persona(db, persona_id))
    except svc.PersonaNotFound as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Persona not found"
        ) from exc


@router.post("/{persona_id}/reconcile", response_model=PersonaOut)
async def reconcile(persona_id: str, db: AsyncSession = Depends(get_db)) -> PersonaOut:
    """Pull the live Foundry agent's version + model into the persona when it has drifted.

    Called by the editor on open (auto-reconcile). Fail-soft: an unavailable agent or a read error
    leaves the persona untouched (``reconcile_persona`` never raises), so the page still loads.
    """
    try:
        persona = await svc.get_persona(db, persona_id)
    except svc.PersonaNotFound as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Persona not found"
        ) from exc
    await svc.reconcile_persona(db, persona)
    return PersonaOut.of(persona)


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


# --- editor Playground (inline test) ---------------------------------------


@router.post("/{persona_id}/test-chat", response_model=TestChatOut)
async def test_chat(
    persona_id: str, body: TestChatIn, db: AsyncSession = Depends(get_db)
) -> TestChatOut:
    """Send one message to the persona's hosted Foundry agent and return its reply (text test).

    Requires the persona to have a synced agent (agent_id/version); returns 409 otherwise so the
    editor can tell the admin to sync first. Threads multi-turn via ``previous_response_id``.
    """
    from app.services import agent_chat_service

    try:
        persona = await svc.get_persona(db, persona_id)
    except svc.PersonaNotFound as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Persona not found"
        ) from exc
    if not (persona.agent_id and persona.agent_version):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Persona has no synced agent yet — save/sync it first.",
        )
    # agent_id is stored as "name:version"; the chat service wants the bare name.
    agent_name = persona.agent_id.split(":", 1)[0]
    try:
        result = await agent_chat_service.chat_with_agent(
            agent_name, persona.agent_version, body.message, body.previous_response_id
        )
    except agent_chat_service.AgentChatError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    return TestChatOut(response_text=result["response_text"], response_id=result.get("response_id"))


@router.post("/{persona_id}/voice/session", response_model=PlaygroundVoiceSessionOut)
async def playground_voice_session(
    persona_id: str, db: AsyncSession = Depends(get_db)
) -> PlaygroundVoiceSessionOut:
    """Broker a Voice Live session for THIS persona so the editor Playground can test voice+avatar
    without a candidate interview. Same broker + P5 sync gate as the interview path."""
    from dataclasses import asdict

    from app.services import voice_broker

    try:
        persona = await svc.get_persona(db, persona_id)
    except svc.PersonaNotFound as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Persona not found"
        ) from exc
    try:
        vs = await voice_broker.create_voice_session(db, persona=persona)
    except voice_broker.VoiceAgentNotSynced as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except voice_broker.VoiceUnavailable as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc
    return PlaygroundVoiceSessionOut(**asdict(vs))
