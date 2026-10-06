"""Voice Live WebSocket proxy route (SPEC F9 avatar-video path).

Mounts ``/voice-live/ws``: the browser (candidate interview OR the admin persona-editor
Playground) connects here instead of straight to Azure, so the backend can hold the single Azure
Voice Live SDK connection that carries both realtime audio AND the avatar ICE/SDP handshake (see
:mod:`app.services.voice_live_proxy` for why that must be one connection).

Auth accepts EITHER token kind via the same ``?token=`` query param (browsers can't set WS
headers): a candidate anonymous-session token (interview path) or an admin JWT (editor
Playground). Whichever validates first wins; if neither does, the socket is accepted just long
enough to deliver a JSON error frame and then closed with 1008 (matches the reference's
``_authenticate_websocket`` contract).

Persona resolution and the P5 sync gate live here: this route needs the persona ORM object itself
to build and relay the proxied SDK session.
"""

import json
import logging
import re

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from jose import JWTError, jwt
from sqlalchemy import select

from app.config import get_settings
from app.db import async_session_factory
from app.models.user import User
from app.services import config_service, persona_service
from app.services.agents.voice_live_metadata import FALLBACK_LOCALE
from app.services.anonymous_session_service import AnonymousSessionError, verify_anonymous_token
from app.services.voice_live_probe import uses_realtime_pipeline
from app.services.voice_live_proxy import is_mouth_persona, run_proxy

logger = logging.getLogger(__name__)

router = APIRouter(tags=["voice-live-ws"])

# Locale used when the page does not pin one: the same fallback the voice metadata uses.
DEFAULT_LOCALE = FALLBACK_LOCALE


def resolve_voice_model(master_voice_model: str | None, env_model: str) -> str:
    """Pick the Voice Live SESSION model from USER CONFIG, not a hardcoded env value.

    Priority: the admin-saved ``service_config.voice_model`` → the ``.env``
    ``VOICE_LIVE_DEFAULT_MODEL`` as a last-resort fallback. The first is read from the DB
    per-connection, so a change in the admin UI takes effect on the NEXT interview with no backend
    restart — the env value alone is frozen at process start because ``get_settings()`` is
    ``lru_cache``d. Blank/whitespace-only is skipped (an empty row must not shadow the env default).

    **Two tiers deliberately removed** when the voice model was split out of the inference model:

    * ``service_config.model_or_deployment`` — that is the INFERENCE model (judge / scoring / the
      Foundry agent) and is a deployment name in the resource. Voice Live MODEL mode accepts only
      models it hosts natively in the region, so feeding the inference model in here is exactly what
      produced "Model X is not supported in this region" (measured: gpt-5.4-mini is a real
      deployment and native Voice Live rejects it).
    * ``persona.model`` — same values, same problem, and a per-persona tier would let an illegal
      model reach a session through the agent editor even when the global voice model is valid. The
      voice model is global; ``persona.model`` now only drives the agent / inference side. If a
      per-persona voice model is ever wanted, give it its OWN column and its own legal dropdown.

    The intent of #99 (v0.37.4.6) is preserved in full: the model still comes from user config, is
    still read from the DB per connection, and is still never frozen by the env cache.
    """
    return (master_voice_model or "").strip() or env_model


def resolve_byom_profile(voice_model_mode: str | None, voice_byom_profile: str | None) -> str:
    """The BYOM profile to put on the wire, or "" for the native path.

    The profile is the upstream API protocol Voice Live drives your deployment with; it is NOT
    inferable from the deployment name, which is why it is stored explicitly. Native mode must never
    carry one (a profile there is a different connection path altogether), and a mode of "byom" with
    no profile stored also yields "" so the connection stays native rather than half-configured.
    """
    if (voice_model_mode or "").strip().lower() != "byom":
        return ""
    return (voice_byom_profile or "").strip()


async def _send_error_and_close(
    ws: WebSocket, message: str, code: str = "VOICE_LIVE_ERROR"
) -> None:
    """Send a typed JSON error frame, then close with 1008 (policy violation / rejected setup)."""
    await ws.send_text(json.dumps({"type": "error", "error": {"code": code, "message": message}}))
    await ws.close(code=1008, reason=code)


async def _authenticate(ws: WebSocket, token: str) -> bool:
    """Try admin JWT first, then candidate anonymous-session token. True on success.

    Accepts the socket before validating (browsers only learn about auth failure via a message +
    close, not a rejected handshake) and sends+closes on failure — mirrors the reference's
    ``_authenticate_websocket``, generalized to the two token kinds this app has.
    """
    settings = get_settings()

    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
    except JWTError:
        payload = None

    if payload is not None and payload.get("typ") != "anon":
        user_id = payload.get("sub")
        if user_id:
            async with async_session_factory() as db:
                user = (
                    await db.execute(select(User).where(User.id == user_id))
                ).scalar_one_or_none()
            if user is not None and user.is_active:
                return True

    async with async_session_factory() as db:
        try:
            await verify_anonymous_token(db, token)
            return True
        except AnonymousSessionError:
            return False


@router.websocket("/voice-live/ws")
async def voice_live_websocket(ws: WebSocket) -> None:
    """Proxy WebSocket: browser <-> backend <-> Azure Voice Live (avatar video path).

    Query params:
      - ``token`` (required): candidate anonymous-session token OR admin JWT.
      - ``persona_id`` (optional): editor Playground pins a specific persona; omitted for the
        candidate interview path, which resolves the enabled default persona instead.
      - ``locale`` (optional): defaults to :data:`DEFAULT_LOCALE`.
      - ``avatar_bg`` (optional): 6-hex RGB (no ``#``) the page wants Azure to paint BEHIND the
        digital human — the photo avatar's own thumbnail backdrop from the frontend roster, so the
        live video matches the editor preview to the pixel. Anything else is ignored.
    """
    token = ws.query_params.get("token")
    persona_id = ws.query_params.get("persona_id")
    locale = ws.query_params.get("locale") or DEFAULT_LOCALE
    _bg = (ws.query_params.get("avatar_bg") or "").strip().lstrip("#")
    avatar_background = _bg.lower() if re.fullmatch(r"[0-9a-fA-F]{6}", _bg) else None

    await ws.accept()

    if not token:
        await _send_error_and_close(
            ws, "Authentication required: missing token query parameter", "AUTH_REQUIRED"
        )
        return

    if not await _authenticate(ws, token):
        await _send_error_and_close(ws, "Authentication failed: invalid token", "AUTH_FAILED")
        return

    async with async_session_factory() as db:
        if persona_id:
            try:
                persona = await persona_service.get_persona(db, persona_id)
            except persona_service.PersonaNotFound:
                await _send_error_and_close(ws, "Persona not found", "PERSONA_NOT_FOUND")
                return
        else:
            persona = await persona_service.get_default_persona(db)
            if persona is None:
                await _send_error_and_close(
                    ws,
                    "No enabled interviewer persona is configured",
                    "VOICE_UNAVAILABLE",
                )
                return

        # P5 gate: reject, never silently degrade to an ungrounded session.
        # EXCEPTION: MOUTH personas (external, or linear-turns bank — see is_mouth_persona) ignore
        # the hosted agent (run_proxy forces MODEL mode for them), so requiring the agent to be
        # synced is nonsensical — skip the gate. Playground pins keep the agent, so they stay gated.
        if (
            not is_mouth_persona(persona, playground=bool(persona_id))
            and persona.agent_sync_status != "synced"
        ):
            await _send_error_and_close(
                ws,
                f"Interviewer agent not ready (sync status: {persona.agent_sync_status})",
                "AGENT_SYNC_REQUIRED",
            )
            return

        # Read the two user-config sources per-connection (see resolve_voice_model for the why).
        _master = await config_service.get_master_config(db)
        # The VOICE leg only — persona.model and model_or_deployment are the inference model now
        # (see resolve_voice_model).
        _master_voice_model = _master.voice_model if _master else None
        _voice_mode = _master.voice_model_mode if _master else None
        _voice_profile = _master.voice_byom_profile if _master else None

    settings = get_settings()
    resolved_model = resolve_voice_model(_master_voice_model, settings.voice_live_default_model)
    resolved_profile = resolve_byom_profile(_voice_mode, _voice_profile)
    # Cascaded (a chat model) keeps the detector it always had; speech-to-speech MUST switch,
    # because the text-based one is refused there. Membership is measured, not guessed — see
    # voice_live_probe.uses_realtime_pipeline (phi4-mm-realtime is cascaded despite its name).
    realtime_pipeline = uses_realtime_pipeline(resolved_model, resolved_profile)
    logger.info(
        "Voice Live model resolved to %r (master.voice_model=%r → env=%r); mode=%r profile=%r",
        resolved_model,
        _master_voice_model or None,
        settings.voice_live_default_model,
        _voice_mode or "native",
        resolved_profile or None,
    )
    logger.info(
        "Voice Live pipeline: realtime=%s (model=%r profile=%r)",
        realtime_pipeline,
        resolved_model,
        resolved_profile or None,
    )
    try:
        await run_proxy(
            ws,
            persona=persona,
            locale=locale,
            endpoint=settings.azure_foundry_endpoint,
            project=settings.azure_foundry_default_project,
            api_key=settings.azure_foundry_api_key,
            api_version=settings.voice_live_api_version,
            default_model=resolved_model,
            byom_profile=resolved_profile,
            realtime_pipeline=realtime_pipeline,
            # Editor Playground (pinned persona_id) is a free conversation with the agent, so a
            # linear-turn BANK persona keeps its model turn THERE only (see
            # linear_turns_for_persona).
            playground=bool(persona_id),
            avatar_background=avatar_background,
        )
    except WebSocketDisconnect:
        logger.info("Voice Live WS: client disconnected")
    except Exception as exc:  # noqa: BLE001 — surface as a typed frame, never a raw 500 stack
        logger.error("Voice Live WS proxy error: %s", exc, exc_info=True)
        try:
            await _send_error_and_close(ws, str(exc), "VOICE_LIVE_ERROR")
        except Exception:
            pass
