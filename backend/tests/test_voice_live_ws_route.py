"""The ``/voice-live/ws`` route body: auth, persona resolution, the sync gate, and what it hands
``run_proxy`` — with no Azure and no real socket.

Every voice interview and every Playground voice test enters through this route, yet only its pure
helpers were tested. Here the route coroutine runs against a stand-in socket on the test's own
event loop (a Starlette ``TestClient`` would run the app on a second loop that the in-memory SQLite
engine cannot cross), with ``run_proxy`` replaced by a recorder so the assertions are about the
decisions the route makes before Azure is ever involved.
"""

import json
from typing import cast

import pytest
from fastapi import WebSocket, WebSocketDisconnect

from app.api import voice_live_ws
from app.models.service_config import ServiceConfig
from app.services import persona_service
from app.services.anonymous_session_service import create_anonymous_session
from app.services.auth_service import create_access_token, get_password_hash
from app.services.config_service import MASTER_SERVICE_NAME


class _FakeWs:
    def __init__(self, **query: str):
        self.query_params = query
        self.accepted = False
        self.sent: list[dict] = []
        self.closed: tuple[int, str] | None = None

    async def accept(self) -> None:
        self.accepted = True

    async def send_text(self, text: str) -> None:
        self.sent.append(json.loads(text))

    async def close(self, code: int, reason: str) -> None:
        self.closed = (code, reason)

    @property
    def error_code(self) -> str | None:
        return self.sent[-1]["error"]["code"] if self.sent else None


async def _run(ws: "_FakeWs") -> None:
    await voice_live_ws.voice_live_websocket(cast(WebSocket, ws))


@pytest.fixture
def proxy_calls(db_session, monkeypatch):
    """Point the route at the test DB and record every ``run_proxy`` call instead of dialling."""
    calls: list[dict] = []

    async def _record(ws, **kwargs):
        calls.append(kwargs)

    monkeypatch.setattr(voice_live_ws, "async_session_factory", db_session._test_factory)
    monkeypatch.setattr(voice_live_ws, "run_proxy", _record)
    return calls


async def _anon_token(db) -> str:
    _, token = await create_anonymous_session(db, ip_address="1.2.3.4")
    return token


async def _admin_token(db, *, active: bool = True, role: str = "admin") -> str:
    from app.models.user import User

    user = User(
        username=f"{role}-{active}",
        email=f"{role}-{active}@local",
        hashed_password=get_password_hash("pw"),
        role=role,
        is_active=active,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return create_access_token(data={"sub": user.id})


async def _default_persona(db, **kw):
    return await persona_service.create_persona(db, name="P", is_default=True, **kw)


# --- auth ------------------------------------------------------------------------------------


async def test_missing_token_is_rejected_with_a_typed_frame(proxy_calls):
    ws = _FakeWs()
    await _run(ws)
    assert ws.accepted, "the socket is accepted first so the browser can read the reason"
    assert ws.error_code == "AUTH_REQUIRED"
    assert ws.closed == (1008, "AUTH_REQUIRED")
    assert proxy_calls == []


async def test_garbage_token_is_rejected(proxy_calls):
    ws = _FakeWs(token="not-a-token")
    await _run(ws)
    assert ws.error_code == "AUTH_FAILED"
    assert proxy_calls == []


async def test_inactive_admin_falls_through_and_is_rejected(db_session, proxy_calls):
    await _default_persona(db_session)
    ws = _FakeWs(token=await _admin_token(db_session, active=False))
    await _run(ws)
    assert ws.error_code == "AUTH_FAILED"
    assert proxy_calls == []


async def test_admin_jwt_opens_the_proxy(db_session, proxy_calls):
    await _default_persona(db_session)
    ws = _FakeWs(token=await _admin_token(db_session))
    await _run(ws)
    assert ws.sent == []
    assert len(proxy_calls) == 1


async def test_candidate_session_token_opens_the_proxy(db_session, proxy_calls):
    persona = await _default_persona(db_session)
    ws = _FakeWs(token=await _anon_token(db_session))
    await _run(ws)
    assert ws.sent == []
    (call,) = proxy_calls
    assert call["persona"].id == persona.id
    assert call["playground"] is False
    assert call["locale"] == voice_live_ws.DEFAULT_LOCALE


# --- persona resolution + the sync gate ------------------------------------------------------


async def test_no_default_persona_is_voice_unavailable(db_session, proxy_calls):
    ws = _FakeWs(token=await _anon_token(db_session))
    await _run(ws)
    assert ws.error_code == "VOICE_UNAVAILABLE"
    assert proxy_calls == []


async def test_unknown_pinned_persona_is_not_found(db_session, proxy_calls):
    ws = _FakeWs(token=await _admin_token(db_session), persona_id="nope")
    await _run(ws)
    assert ws.error_code == "PERSONA_NOT_FOUND"
    assert proxy_calls == []


async def test_playground_bank_persona_needs_a_synced_agent(db_session, proxy_calls):
    # The Playground converses with the bank persona's own agent, so an unsynced one is refused
    # rather than silently degraded.
    persona = await _default_persona(db_session)
    ws = _FakeWs(token=await _admin_token(db_session), persona_id=persona.id)
    await _run(ws)
    assert ws.error_code == "AGENT_SYNC_REQUIRED"
    assert proxy_calls == []


async def test_playground_bank_persona_with_a_synced_agent_is_a_playground_call(
    db_session, proxy_calls
):
    persona = await _default_persona(db_session)
    persona.agent_sync_status = "synced"
    await db_session.commit()
    ws = _FakeWs(token=await _admin_token(db_session), persona_id=persona.id, locale="zh-CN")
    await _run(ws)
    (call,) = proxy_calls
    assert call["playground"] is True
    assert call["locale"] == "zh-CN"


async def test_candidate_path_skips_the_sync_gate(db_session, proxy_calls):
    # Every candidate session is a mouth (no agent turn), so an unsynced agent must not block it.
    persona = await _default_persona(db_session)
    assert persona.agent_sync_status != "synced"
    await _run(_FakeWs(token=await _anon_token(db_session)))
    assert len(proxy_calls) == 1


async def test_external_persona_skips_the_gate_even_in_the_playground(db_session, proxy_calls):
    persona = await _default_persona(db_session, interview_brain="external")
    ws = _FakeWs(token=await _admin_token(db_session), persona_id=persona.id)
    await _run(ws)
    assert len(proxy_calls) == 1


# --- what reaches run_proxy ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("AABBCC", "aabbcc"), ("#00ff7f", "00ff7f"), ("red", None), ("12345", None), ("", None)],
)
async def test_avatar_background_accepts_only_six_hex(db_session, proxy_calls, raw, expected):
    await _default_persona(db_session)
    ws = _FakeWs(token=await _anon_token(db_session), avatar_bg=raw)
    await _run(ws)
    assert proxy_calls[0]["avatar_background"] == expected


async def test_saved_voice_model_and_byom_profile_reach_the_proxy(db_session, proxy_calls):
    await _default_persona(db_session)
    db_session.add(
        ServiceConfig(
            service_name=MASTER_SERVICE_NAME,
            voice_model="my-deployment",
            voice_model_mode="byom",
            voice_byom_profile="byom-azure-openai-chat-completion",
        )
    )
    await db_session.commit()
    await _run(_FakeWs(token=await _anon_token(db_session)))
    (call,) = proxy_calls
    assert call["default_model"] == "my-deployment"
    assert call["byom_profile"] == "byom-azure-openai-chat-completion"


async def test_no_saved_config_falls_back_to_the_env_model(db_session, proxy_calls):
    await _default_persona(db_session)
    await _run(_FakeWs(token=await _anon_token(db_session)))
    (call,) = proxy_calls
    assert call["default_model"] == voice_live_ws.get_settings().voice_live_default_model
    assert call["byom_profile"] == ""


# --- failures inside the proxy ---------------------------------------------------------------


async def test_a_proxy_error_becomes_a_typed_frame(db_session, monkeypatch):
    async def _boom(ws, **kwargs):
        raise RuntimeError("Model X is not supported in this region")

    monkeypatch.setattr(voice_live_ws, "async_session_factory", db_session._test_factory)
    monkeypatch.setattr(voice_live_ws, "run_proxy", _boom)
    await _default_persona(db_session)
    ws = _FakeWs(token=await _anon_token(db_session))
    await _run(ws)
    assert ws.error_code == "VOICE_LIVE_ERROR"
    # The Azure message is surfaced verbatim — the interview page shows it instead of a generic one.
    assert ws.sent[-1]["error"]["message"] == "Model X is not supported in this region"
    assert ws.closed == (1008, "VOICE_LIVE_ERROR")


async def test_a_client_disconnect_is_not_reported_as_an_error(db_session, monkeypatch):
    async def _gone(ws, **kwargs):
        raise WebSocketDisconnect()

    monkeypatch.setattr(voice_live_ws, "async_session_factory", db_session._test_factory)
    monkeypatch.setattr(voice_live_ws, "run_proxy", _gone)
    await _default_persona(db_session)
    ws = _FakeWs(token=await _anon_token(db_session))
    await _run(ws)
    assert ws.sent == [] and ws.closed is None


# --- pinning a persona (the editor Playground) is admin-only ----------------------------------


async def test_a_candidate_session_cannot_pin_a_persona(db_session, proxy_calls):
    # A candidate who adds ?persona_id= by hand would otherwise get the Playground: a free
    # conversation with the agent instead of the verbatim-read interview.
    persona = await _default_persona(db_session)
    persona.agent_sync_status = "synced"
    await db_session.commit()
    ws = _FakeWs(token=await _anon_token(db_session), persona_id=persona.id)
    await _run(ws)
    assert ws.error_code == "PLAYGROUND_ADMIN_ONLY"
    assert ws.closed == (1008, "PLAYGROUND_ADMIN_ONLY")
    assert proxy_calls == []


async def test_a_non_admin_login_cannot_pin_a_persona(db_session, proxy_calls):
    # A candidate's own login JWT (role=user) validates as a user, but is not an admin.
    persona = await _default_persona(db_session)
    persona.agent_sync_status = "synced"
    await db_session.commit()
    ws = _FakeWs(token=await _admin_token(db_session, role="user"), persona_id=persona.id)
    await _run(ws)
    assert ws.error_code == "PLAYGROUND_ADMIN_ONLY"
    assert proxy_calls == []


async def test_a_non_admin_login_still_opens_the_interview_path(db_session, proxy_calls):
    await _default_persona(db_session)
    await _run(_FakeWs(token=await _admin_token(db_session, role="user")))
    (call,) = proxy_calls
    assert call["playground"] is False


# --- App Insights: the session joins the browser's trace ------------------------------------


async def test_the_session_span_is_parented_on_the_browsers_traceparent(
    db_session, proxy_calls, monkeypatch
):
    # A WebSocket cannot carry headers, so the page passes its W3C trace context in the query
    # string; the route must hand it to the session span (with the interview id) or the browser's
    # socket and the backend's session never join in App Insights.
    import contextlib

    from app import telemetry

    spans: list[tuple[str, dict]] = []

    @contextlib.contextmanager
    def _span(name, parent=None, **attributes):
        spans.append((name, {"parent": parent, **attributes}))
        yield None

    monkeypatch.setattr(telemetry, "span", _span)
    monkeypatch.setattr(telemetry, "parent_context", lambda tp: f"ctx:{tp}")
    await _default_persona(db_session)
    tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    await _run(_FakeWs(token=await _anon_token(db_session), traceparent=tp))
    ((name, attrs),) = spans
    assert name == "voice.session"
    assert attrs["parent"] == f"ctx:{tp}"
    assert "voice.interview_id" in attrs  # None here: this anonymous session has no interview yet
