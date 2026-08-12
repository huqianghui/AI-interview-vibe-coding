"""Voice Live WebRTC session broker (SPEC F9).

The candidate's browser establishes a WebRTC connection **directly** to Azure Voice Live; the
backend's only job is to hand the browser a short-lived credential and the signaling URL. Audio
never transits the backend (P4 boundary — no candidate media on our servers).

This module owns two things, split so the risky part is CI-testable without Azure:

1. :func:`build_signaling_url` — a **pure** function that assembles the ``wss://…`` signaling URL
   for agent-mode or model-mode against the ``/voice-live/realtime/calls`` endpoint. Agent mode
   emits Azure's ``agent_id`` + ``agent_project_name`` (+ ``agent_version``) query keys; model mode
   falls back to a bare ``model`` query. No network, fully tested.

2. :func:`create_voice_session` — the broker entry point. Resolves the active interviewer persona,
   enforces the **P5 gate** (a persona whose ``agent_sync_status != "synced"`` is rejected, never
   silently degraded to model mode — the reference's bug we must not inherit), builds the Voice
   Live ``session`` metadata from the persona (reusing the F5 ``voice_live_metadata`` builder), and
   delegates the credential (bearer token) to the selected provider adapter (mock / azure).

The provider split keeps CI + local dev on the mock adapter (deterministic placeholder credential,
zero Azure), while the real STS key→bearer exchange lives in :mod:`app.services.voice_providers`.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from urllib.parse import urlencode

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.services import persona_service
from app.services.agents.voice_live_metadata import build_session, resolve_voice
from app.services.azure_auth import COGNITIVE_SERVICES_SCOPE, FOUNDRY_SCOPE
from app.services.voice_providers import VoiceCredential, get_voice_provider
from app.utils.azure_endpoints import endpoint_host, to_cognitive_services_endpoint

# Locale the broker defaults to when the caller doesn't pin one (matches F5 metadata fallback).
DEFAULT_LOCALE = "zh-CN"


class VoiceBrokerError(Exception):
    """Base class for broker failures surfaced to the API as a typed HTTP error."""


class VoiceUnavailable(VoiceBrokerError):
    """Voice Live is not configured/enabled — the candidate should stay on the text channel."""


class VoiceAgentNotSynced(VoiceBrokerError):
    """P5: the interviewer persona's Foundry agent is not synced.

    Raised (never silently degraded) when the resolved persona's ``agent_sync_status`` is not
    ``"synced"``. Voice mode requires a synced agent; the API turns this into a 409 so the
    frontend falls back to text-only continuation (P6b) rather than connecting to a mode that
    would answer without the interviewer's persona/knowledge grounding.
    """


@dataclass(frozen=True)
class VoiceSession:
    """Everything the browser needs to open a direct WebRTC connection to Azure Voice Live."""

    signaling_url: str
    auth_token: str
    auth_type: str
    mode: str  # "agent" | "model"
    model: str
    session_config: dict
    persona_id: str
    character: str
    style: str
    greeting: str | None = None
    # True when the session requests a digital-human avatar video track (the persona has a
    # character/style). The frontend negotiates a recvonly video transceiver and shows the face.
    avatar_enabled: bool = False


def build_signaling_url(
    *,
    host: str,
    api_version: str,
    agent_name: str | None = None,
    agent_version: str | None = None,
    project_name: str | None = None,
    model: str | None = None,
) -> str:
    """Assemble the Voice Live realtime signaling URL (pure).

    Agent mode (``agent_name`` given) pins the synced Foundry agent + project; model mode falls
    back to a bare ``model`` query.

    Contract (live-verified end to end 2026-08-12 against ``avarda-demo-prj``, swedencentral). The
    full spec + error→cause table live in
    ``docs/planning/spec-voice-live-agent-contract.md`` — READ THAT if voice regresses.

    - Path is ``/voice-live/realtime/calls`` (WebRTC call endpoint), NOT ``/voice-live/realtime``.
    - Agent-mode query keys are **hyphenated**: ``agent-name`` + ``agent-project-name`` +
      ``agent-version`` (the ``agent_name``/``project_name`` args are the persona's field names,
      mapped to Azure's hyphenated keys here). The underscore forms
      (``agent_id``/``agent_project_name``) reach the agent but fail ``agent_initialization_failed``
      on a normal browser offer.
    - ``agent-version`` is passed through only when present.
    - ``agent_name`` here must already be the BARE agent id — the caller strips any ``:version``
      suffix that the SDK's ``create_version`` returns.

    The api-version comes from the caller (``settings.voice_live_api_version`` =
    ``2026-01-01-preview``); ``2026-04-10``+ / GA ``2026-07-15`` reject classic agents and 404 on
    ``/calls``.

    The returned URL carries NO auth token: browsers can't set WebSocket headers, so the frontend
    appends the brokered Entra bearer as an ``Authorization=Bearer%20<token>`` query parameter.
    """
    if agent_name:
        # HYPHENATED keys are required: `agent-name` / `agent-project-name` / `agent-version`.
        # Live-verified 2026-08-12 — the underscore forms (`agent_id`/`agent_project_name`) reach
        # the agent but fail "agent_initialization_failed" on a normal browser (BUNDLE) offer; the
        # hyphenated forms complete the full session.created → session.updated → sdp.created
        # handshake with a standard offer. (Matches the AI-Coach project's working contract.)
        params = {
            "api-version": api_version,
            "agent-name": agent_name,
            "agent-project-name": project_name or "",
        }
        if agent_version:
            params["agent-version"] = agent_version
        query = urlencode(params)
    else:
        query = urlencode({"api-version": api_version, "model": model or ""})
    return f"wss://{host}/voice-live/realtime/calls?{query}"


def _greeting_for_locale(greeting_map_raw: str | None, locale: str) -> str | None:
    """Pick a persona greeting for ``locale`` (falls back to the default locale, then any)."""
    if not greeting_map_raw:
        return None
    try:
        greetings = json.loads(greeting_map_raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(greetings, dict) or not greetings:
        return None
    for candidate in (locale, DEFAULT_LOCALE):
        if greetings.get(candidate):
            return greetings[candidate]
    first = next(iter(greetings.values()))
    return first or None


async def create_voice_session(
    db: AsyncSession, *, locale: str | None = None, provider: str | None = None
) -> VoiceSession:
    """Broker a WebRTC voice session for the active interviewer persona.

    Steps: resolve the enabled default persona → **P5 gate** (must be ``synced``) → build the
    snake_case Voice Live ``session`` config from the persona → get a browser-safe credential from
    the provider adapter → assemble the signaling URL. Raises :class:`VoiceUnavailable` when Voice
    Live is off/unconfigured and :class:`VoiceAgentNotSynced` when the P5 gate fails.
    """
    settings = get_settings()
    effective_locale = locale or DEFAULT_LOCALE

    persona = await persona_service.get_default_persona(db)
    if persona is None:
        raise VoiceUnavailable("No enabled interviewer persona is configured")

    # P5: reject, never silently degrade. A persona without a synced Foundry agent cannot drive
    # voice mode — the reference fell back to model mode here and lost persona grounding.
    if persona.agent_sync_status != "synced":
        raise VoiceAgentNotSynced(
            f"Interviewer agent not ready (sync status: {persona.agent_sync_status})"
        )

    voice_provider = get_voice_provider(provider)
    # build_session resolves the voice name itself; we only need the resolved locale for the
    # greeting lookup below (so a zh-CN greeting isn't served for an en-US session).
    resolved_locale, _ = resolve_voice(persona.voice_map, effective_locale)
    session_config = build_session(persona, locale=resolved_locale)

    # `proactive_engagement` and `interim_response` are agent-level behaviors carried in the agent's
    # voice-live metadata, NOT runtime `session.update` fields — the realtime session rejects them
    # ("'session.proactive_engagement' unexpected"), live-verified 2026-08-12. Drop them from the
    # runtime config the browser sends; the agent already has them from sync-time metadata.
    session_config.pop("proactive_engagement", None)
    session_config.pop("interim_response", None)

    # Request the avatar video modality when the persona has a character configured, so Voice Live
    # sends a digital-human video track (the frontend negotiates a recvonly video transceiver).
    avatar_enabled = bool((persona.character or "").strip())
    if avatar_enabled:
        session_config["modalities"] = ["text", "audio", "avatar"]
        # With an avatar configured, the voice is fixed at the avatar/agent level — a runtime
        # `session.update` carrying `voice` is rejected ("Cannot update voice when avatar is
        # configured"), live-verified 2026-08-12. The voice is already set via agent metadata.
        session_config.pop("voice", None)

    # Agent mode authorizes against the AI Agent service (needs an ai.azure.com/Foundry-scoped
    # token); model mode accepts the cognitiveservices scope. Live-verified 2026-08-12: a
    # cognitiveservices token on an agent session is rejected "Unauthorized to AI Agent service".
    is_agent = bool((persona.agent_id or "").strip())
    token_scope = FOUNDRY_SCOPE if is_agent else COGNITIVE_SERVICES_SCOPE
    # The SDK returns the created agent id as "name:version"; Voice Live's `agent_id` query wants
    # the bare name (version rides in the separate `agent_version` param). Strip any ":ver" suffix.
    agent_name = (persona.agent_id or "").split(":", 1)[0] if is_agent else None

    credential: VoiceCredential = await voice_provider.issue_credential(
        endpoint=to_cognitive_services_endpoint(settings.azure_foundry_endpoint),
        api_key=settings.azure_foundry_api_key,
        scope=token_scope,
    )

    host = endpoint_host(to_cognitive_services_endpoint(settings.azure_foundry_endpoint)) or (
        credential.host or ""
    )
    signaling_url = build_signaling_url(
        host=host or credential.host or "voice-live.local",
        api_version=settings.voice_live_api_version,
        agent_name=agent_name,
        agent_version=persona.agent_version,
        project_name=settings.azure_foundry_default_project,
        model=settings.voice_live_default_model,
    )

    return VoiceSession(
        signaling_url=signaling_url,
        auth_token=credential.auth_token,
        auth_type=credential.auth_type,
        mode="agent" if is_agent else "model",
        model="" if is_agent else settings.voice_live_default_model,
        session_config=session_config,
        persona_id=persona.id,
        character=persona.character,
        style=persona.style,
        greeting=_greeting_for_locale(persona.greeting_map, resolved_locale),
        avatar_enabled=avatar_enabled,
    )
