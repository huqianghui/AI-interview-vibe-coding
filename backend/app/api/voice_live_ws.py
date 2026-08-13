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

Persona resolution + the P5 sync gate mirror :func:`app.services.voice_broker.create_voice_session`
(kept here, not delegated to the broker, because the broker's ``VoiceSession`` shape is for the
WebRTC direct-to-Azure path — this route needs the persona ORM object itself to build/relay the
proxied SDK session).
"""

import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from jose import JWTError, jwt
from sqlalchemy import select

from app.config import get_settings
from app.db import async_session_factory
from app.models.user import User
from app.services import persona_service
from app.services.anonymous_session_service import AnonymousSessionError, verify_anonymous_token
from app.services.voice_broker import DEFAULT_LOCALE
from app.services.voice_live_proxy import run_proxy

logger = logging.getLogger(__name__)

router = APIRouter(tags=["voice-live-ws"])


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
      - ``locale`` (optional): defaults to :data:`app.services.voice_broker.DEFAULT_LOCALE`.
    """
    token = ws.query_params.get("token")
    persona_id = ws.query_params.get("persona_id")
    locale = ws.query_params.get("locale") or DEFAULT_LOCALE

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

        # P5 gate: reject, never silently degrade (same invariant as voice_broker).
        if persona.agent_sync_status != "synced":
            await _send_error_and_close(
                ws,
                f"Interviewer agent not ready (sync status: {persona.agent_sync_status})",
                "AGENT_SYNC_REQUIRED",
            )
            return

    settings = get_settings()
    try:
        await run_proxy(
            ws,
            persona=persona,
            locale=locale,
            endpoint=settings.azure_foundry_endpoint,
            project=settings.azure_foundry_default_project,
            api_key=settings.azure_foundry_api_key,
            api_version=settings.voice_live_api_version,
            default_model=settings.voice_live_default_model,
        )
    except WebSocketDisconnect:
        logger.info("Voice Live WS: client disconnected")
    except Exception as exc:  # noqa: BLE001 — surface as a typed frame, never a raw 500 stack
        logger.error("Voice Live WS proxy error: %s", exc, exc_info=True)
        try:
            await _send_error_and_close(ws, str(exc), "VOICE_LIVE_ERROR")
        except Exception:
            pass
