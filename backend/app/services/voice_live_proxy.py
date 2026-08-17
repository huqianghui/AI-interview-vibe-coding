"""Voice Live WebSocket proxy: backend holds the Azure SDK connection so avatar VIDEO works.

The candidate/editor browser opens a plain WebSocket to OUR backend (not directly to Azure). We
hold the ``azure-ai-voicelive`` SDK connection server-side and relay both directions. This is
DIFFERENT from :mod:`app.services.voice_broker` (SPEC F9's WebRTC broker, where the browser
connects straight to Azure and audio never transits the backend) — this module exists because
Azure only delivers ``avatar.ice_servers`` and the avatar SDP handshake (the browser's
``session.avatar.connect`` -> Azure's ``session.avatar.connecting`` with ``server_sdp``) over the
*same* connection that sent ``session.update``. A short-lived STS credential handed to the
browser for a brand-new WebRTC connection cannot reuse that avatar SDP context, so avatar video
needs the backend in the loop as a relay. Ported from the working reference implementation
(AI-avatar-vibe-coding's ``voice_live_websocket.py``), trimmed to this project's persona model.

Two pieces, split the same way as the rest of this codebase's Azure integrations:

- :func:`build_avatar_session` — pure session-shape builder (no Azure network), CI-tested.
- :func:`run_proxy` — the live relay loop. Coverage-omitted (``# pragma: no cover``): it needs a
  real Azure Voice Live connection and CI has none.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from app.models.persona import InterviewerPersona
from app.services.agents.voice_live_metadata import resolve_voice
from app.services.azure_auth import COGNITIVE_SERVICES_SCOPE, get_azure_credential_cached

logger = logging.getLogger(__name__)

PROXY_CONNECTED_TYPE = "proxy.connected"
ERROR_TYPE = "error"

# The certifi-backed SSL context is identical for every connection, so build it once and reuse it
# across connects instead of paying ssl.create_default_context (reads + parses the CA bundle) on
# each run_proxy call. Cached lazily so importing this module never requires ssl/certifi.
_ssl_ctx_cache: Any = None


def _certifi_ssl_context() -> Any:  # pragma: no cover — trivial cache around stdlib ssl/certifi
    """Return a process-wide certifi CA-bundle SSL context (built once, then reused).

    aiohttp (the voicelive SDK's WS transport) uses the OS trust store, which on macOS/some Linux
    can't verify Azure's cert chain → "CERTIFICATE_VERIFY_FAILED, unable to get local issuer
    certificate". Pointing it at certifi's CA bundle fixes that (live-verified). The context is
    immutable for our use, so one instance serves every connection.
    """
    global _ssl_ctx_cache
    if _ssl_ctx_cache is None:
        import ssl

        import certifi

        _ssl_ctx_cache = ssl.create_default_context(cafile=certifi.where())
    return _ssl_ctx_cache


def build_avatar_session(persona: InterviewerPersona, *, locale: str | None) -> Any:
    """Build the Azure SDK ``RequestSession`` for a persona's avatar/voice Voice Live session.

    Pure shaping, no network: this only constructs SDK model objects from the persona's fields, so
    it's unit-testable without any Azure call (assert on the resulting object's ``.modalities``,
    ``.avatar``, ``.voice``, etc. — the SDK models are ``MutableMapping``s that also support
    attribute access). The SDK import lives INSIDE the function so importing this module never
    hard-fails when the ``azure-ai-voicelive`` extra is absent from some tooling environment (e.g.
    a lint-only venv) — mirrors the reference's import-inside-try pattern.

    Modalities include AVATAR only when the persona has a ``character`` configured (an avatar-less
    persona is TEXT+AUDIO only, matching :func:`app.services.voice_broker.create_voice_session`'s
    ``avatar_enabled`` gate).
    """
    from azure.ai.voicelive.models import (
        AudioEchoCancellation,
        AudioInputTranscriptionOptions,
        AudioNoiseReduction,
        AvatarConfig,
        AzureSemanticVad,
        AzureStandardVoice,
        Modality,
        RequestSession,
        VideoParams,
    )

    resolved_locale, voice_name = resolve_voice(persona.voice_map, locale)

    has_avatar = bool((persona.character or "").strip())
    modalities = [Modality.TEXT, Modality.AUDIO]
    if has_avatar:
        modalities.append(Modality.AVATAR)

    session_kwargs: dict[str, Any] = {
        "modalities": modalities,
        "voice": AzureStandardVoice(name=voice_name, type="azure-standard"),
        # Server VAD drives a fully hands-free turn (AI Foundry portal parity): Azure detects when
        # the user stops speaking and AUTO-generates the agent's reply (create_response=True), and
        # the user can barge in to cut the agent off mid-answer (interrupt_response=True). Set both
        # EXPLICITLY rather than relying on Azure's defaults so behavior can't silently regress —
        # this is why the interviewer wasn't replying without a manual trigger.
        "turn_detection": AzureSemanticVad(
            type="azure_semantic_vad",
            create_response=True,
            interrupt_response=True,
        ),
        "input_audio_transcription": AudioInputTranscriptionOptions(
            model="azure-speech", language=resolved_locale
        ),
        "input_audio_noise_reduction": AudioNoiseReduction(type="azure_deep_noise_suppression"),
        "input_audio_echo_cancellation": AudioEchoCancellation(type="server_echo_cancellation"),
    }
    if has_avatar:
        session_kwargs["avatar"] = AvatarConfig(
            character=persona.character,
            style=persona.style or None,
            customized=False,
            video=VideoParams(codec="h264"),
        )

    return RequestSession(**session_kwargs)  # type: ignore[arg-type]


async def _resolve_voice_live_credential(api_key: str) -> tuple[Any, bool]:  # pragma: no cover
    """Entra-first, API-key-fallback credential resolution (mirrors ``azure_auth`` elsewhere).

    Probes the cached async ``DefaultAzureCredential`` (:func:`get_azure_credential_cached`) with
    ``COGNITIVE_SERVICES_SCOPE``; falls back to ``AzureKeyCredential(api_key)``. Returns
    ``(credential, is_entra)``. Unlike the reference, the cached credential is process-lifetime and
    NOT closed by the caller when Entra is used (closing it would break the next WS connection).
    """
    credential = get_azure_credential_cached()
    if credential is not None:
        try:
            await credential.get_token(COGNITIVE_SERVICES_SCOPE)
            logger.info("Voice Live proxy credential: using Entra (DefaultAzureCredential)")
            return credential, True
        except Exception:
            logger.info("Voice Live proxy credential: Entra probe failed, falling back to API key")

    if api_key and api_key.strip():
        from azure.core.credentials import AzureKeyCredential

        return AzureKeyCredential(api_key), False

    raise RuntimeError(
        "No valid Voice Live credential available: Entra probe failed and no API key configured"
    )


async def run_proxy(
    ws: WebSocket,
    *,
    persona: InterviewerPersona,
    locale: str | None,
    endpoint: str,
    project: str,
    api_key: str,
    api_version: str,
    default_model: str,
) -> None:  # pragma: no cover — live Azure connect + relay, no Azure in CI
    """Hold the Azure Voice Live SDK connection and relay browser <-> Azure.

    Agent mode (``persona.agent_id`` set) connects with ``agent_name``/``agent_version``/
    ``project_name`` so the hosted Foundry agent drives the session; ``agent_id`` is stored as
    ``"name:version"`` (see :mod:`app.services.voice_broker`) so any ``:version`` suffix is
    stripped for ``agent_name`` and passed separately as ``agent_version``. Model mode (no
    ``agent_id``) connects with ``model=default_model``.

    Sends ``{"type": "proxy.connected", ...}`` once Azure has acknowledged the initial
    ``session.update``, then runs two race-cancelled relay loops until either side closes.
    """
    from azure.ai.voicelive.aio import ConnectionClosed, connect

    credential, _is_entra = await _resolve_voice_live_credential(api_key)

    is_agent = bool((persona.agent_id or "").strip())
    agent_name = (persona.agent_id or "").split(":", 1)[0] if is_agent else None

    # certifi CA-bundle SSL context (see _certifi_ssl_context) handed to the SDK's vendor_options
    # escape hatch, which maps straight to aiohttp ws_connect's ssl= kwarg. Built once, reused here.
    ssl_ctx = _certifi_ssl_context()

    connect_kwargs: dict[str, Any] = {
        "endpoint": endpoint,
        "credential": credential,
        "api_version": api_version,
        "connection_options": {"vendor_options": {"ssl": ssl_ctx}},
    }
    if is_agent:
        connect_kwargs["agent_name"] = agent_name
        connect_kwargs["agent_version"] = persona.agent_version or ""
        connect_kwargs["project_name"] = project
    else:
        connect_kwargs["model"] = default_model

    try:
        async with connect(**connect_kwargs) as conn:
            session = build_avatar_session(persona, locale=locale)
            await conn.session.update(session=session)

            await ws.send_text(
                json.dumps(
                    {
                        "type": PROXY_CONNECTED_TYPE,
                        "mode": "agent" if is_agent else "model",
                        "agent_name": agent_name or "",
                        "model": "" if is_agent else default_model,
                        "avatar_enabled": bool((persona.character or "").strip()),
                        "persona_id": persona.id,
                    }
                )
            )

            await _relay(ws, conn, ConnectionClosed)
    except ConnectionClosed:
        logger.info("Voice Live proxy: Azure connection closed")
    except WebSocketDisconnect:
        logger.info("Voice Live proxy: client disconnected")


async def _relay(
    ws: WebSocket, conn: Any, connection_closed: type
) -> None:  # pragma: no cover — live relay
    """Run the two forwarding loops; return as soon as either side ends."""
    tasks = [
        asyncio.create_task(_forward_client_to_azure(ws, conn, connection_closed)),
        asyncio.create_task(_forward_azure_to_client(conn, ws, connection_closed)),
    ]
    _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for task in pending:
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass


async def _forward_client_to_azure(
    ws: WebSocket, conn: Any, connection_closed: type
) -> None:  # pragma: no cover — live relay
    """Browser -> Azure: parse each client frame and forward it as a Voice Live client event."""
    try:
        while True:
            message = await ws.receive_text()
            parsed = json.loads(message)
            await conn.send(parsed)
    except (WebSocketDisconnect, connection_closed):
        logger.debug("Voice Live proxy: client->Azure forwarding stopped")
    except Exception as exc:
        logger.warning("Voice Live proxy: client->Azure forwarding error: %s", exc)


async def _forward_azure_to_client(
    conn: Any, ws: WebSocket, connection_closed: type
) -> None:  # pragma: no cover — live relay
    """Azure -> browser: forward every server event (incl. avatar ICE/SDP) as JSON text."""
    try:
        async for event in conn:
            event_dict = event.as_dict() if hasattr(event, "as_dict") else dict(event)
            await ws.send_text(json.dumps(event_dict))
    except connection_closed:
        logger.debug("Voice Live proxy: Azure->client forwarding stopped (Azure closed)")
    except WebSocketDisconnect:
        logger.debug("Voice Live proxy: Azure->client forwarding stopped (client closed)")
    except Exception as exc:
        logger.warning("Voice Live proxy: Azure->client forwarding error: %s", exc)
    finally:
        try:
            await ws.close(code=1000, reason="azure_stream_ended")
        except Exception:
            pass
