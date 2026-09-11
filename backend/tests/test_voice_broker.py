"""Voice Live broker (SPEC F9): pure signaling-URL builder + persona-gated session creation.

Covers the pure helpers (no Azure) and the two states the broker must distinguish: a synced
persona yields a session on the mock provider; an unsynced persona is REJECTED (P5), never
degraded to model mode.
"""

import pytest

from app.config import get_settings
from app.services import persona_service as psvc
from app.services import voice_broker
from app.services.voice_broker import VoiceAgentNotSynced, VoiceUnavailable
from app.services.voice_providers import MockVoiceProvider, get_voice_provider
from app.utils.azure_endpoints import endpoint_host, to_cognitive_services_endpoint


def test_to_cognitive_services_endpoint_rewrites_foundry_host():
    assert (
        to_cognitive_services_endpoint("https://foo.services.ai.azure.com/")
        == "https://foo.cognitiveservices.azure.com/"
    )


def test_to_cognitive_services_endpoint_passthrough():
    # Already-cognitiveservices and openai hosts are left untouched.
    assert (
        to_cognitive_services_endpoint("https://foo.cognitiveservices.azure.com/")
        == "https://foo.cognitiveservices.azure.com/"
    )
    assert (
        to_cognitive_services_endpoint("https://foo.openai.azure.com/")
        == "https://foo.openai.azure.com/"
    )


def test_endpoint_host_strips_scheme_and_path():
    host = endpoint_host("https://foo.cognitiveservices.azure.com/")
    assert host == "foo.cognitiveservices.azure.com"


def test_build_signaling_url_agent_mode_pins_agent_and_project():
    # Live-verified contract: /voice-live/realtime/calls + HYPHENATED agent-name/agent-project-name/
    # agent-version keys (underscore forms fail agent-init on a normal browser offer).
    url = voice_broker.build_signaling_url(
        host="h.cognitiveservices.azure.com",
        api_version="2026-01-01-preview",
        agent_name="agent-1",
        agent_version="3",
        project_name="proj",
    )
    assert url.startswith("wss://h.cognitiveservices.azure.com/voice-live/realtime/calls?")
    assert "agent-name=agent-1" in url
    assert "agent-project-name=proj" in url
    assert "agent-version=3" in url
    # The underscore forms (which Azure rejects for agent init) must NOT be emitted.
    assert "agent_id=" not in url
    assert "agent_project_name=" not in url
    assert "model=" not in url


def test_build_signaling_url_model_mode_falls_back_to_model():
    url = voice_broker.build_signaling_url(host="h", api_version="v", model="gpt-4o")
    assert url.startswith("wss://h/voice-live/realtime/calls?")
    assert "model=gpt-4o" in url
    assert "agent-name" not in url


def test_build_signaling_url_omits_agent_version_when_absent():
    # agent-version is passed through only when present (no hardcoded "1" default).
    url = voice_broker.build_signaling_url(host="h", api_version="v", agent_name="a")
    assert "agent-name=a" in url
    assert "agent-version" not in url


@pytest.mark.asyncio
async def test_mock_voice_provider_issues_placeholder_bearer():
    cred = await MockVoiceProvider().issue_credential(
        endpoint="https://foo.cognitiveservices.azure.com/", api_key="ignored"
    )
    assert cred.auth_type == "bearer"
    assert cred.auth_token == "mock-voice-bearer-token"
    assert cred.host == "foo.cognitiveservices.azure.com"


def test_get_voice_provider_defaults_to_mock():
    assert get_voice_provider().name == "mock"


def test_get_voice_provider_unknown_falls_back_to_mock():
    # Selecting "azure" when unconfigured must not 500 — fall back to mock for CI safety.
    assert get_voice_provider("azure").name in ("mock", "azure")


@pytest.mark.asyncio
async def test_create_voice_session_requires_a_persona(db_session):
    with pytest.raises(VoiceUnavailable):
        await voice_broker.create_voice_session(db_session)


@pytest.mark.asyncio
async def test_create_voice_session_rejects_unsynced_persona(db_session):
    # P5: a persona whose agent isn't synced must be rejected, not degraded to model mode.
    await psvc.create_persona(db_session, name="Interviewer", is_default=True)
    with pytest.raises(VoiceAgentNotSynced):
        await voice_broker.create_voice_session(db_session)


@pytest.mark.asyncio
async def test_create_voice_session_succeeds_for_synced_persona(db_session):
    persona = await psvc.create_persona(
        db_session,
        name="Interviewer",
        character="lisa",
        style="casual",
        voice_map='{"zh-CN": "zh-CN-XiaoxiaoNeural"}',
        greeting_map='{"zh-CN": "你好，我们开始面试。", "en-US": "Hi, let\'s begin."}',
        is_default=True,
    )
    await psvc.mark_sync_succeeded(db_session, persona, agent_id="agent-42", agent_version="2")

    vs = await voice_broker.create_voice_session(db_session, locale="zh-CN")

    assert vs.mode == "agent"  # a synced persona with an agent_id → agent mode
    assert "agent-name=agent-42" in vs.signaling_url
    assert "/voice-live/realtime/calls?" in vs.signaling_url
    assert vs.auth_type == "bearer"
    assert vs.persona_id == persona.id
    assert vs.character == "lisa"
    assert vs.greeting == "你好，我们开始面试。"
    # session_config is the snake_case Voice Live shape — never candidate-facing rubric data.
    assert "turn_detection" in vs.session_config
    # Persona has a character → avatar video modality requested (digital-human face).
    assert vs.avatar_enabled is True
    assert vs.session_config["modalities"] == ["text", "audio", "avatar"]
    # With an avatar, runtime session.update must NOT carry voice/proactive/interim — Azure rejects
    # them ("Cannot update voice when avatar is configured" / "'session.proactive_engagement'
    # unexpected"); those are set via agent metadata instead.
    assert "voice" not in vs.session_config
    assert "proactive_engagement" not in vs.session_config
    assert "interim_response" not in vs.session_config


@pytest.mark.asyncio
async def test_external_brain_persona_forces_model_mode_ignoring_agent(db_session):
    # Regression (v0.37.1.9): an external-brain persona is a pure "mouth" — the EXTERNAL workflow is
    # the interviewer brain and the backend injects each turn's speech_text. A hosted Foundry agent
    # attached to it would be a SECOND, improvising brain whose spoken audio diverges from the
    # external-workflow display_text driving the header (the header-vs-transcript mismatch). So
    # even when the persona still carries an agent_id, the session MUST connect in MODEL mode — and
    # the P5 sync gate must be skipped, since the agent is deliberately ignored.
    persona = await psvc.create_persona(
        db_session,
        name="Interviewer",
        character="lisa",
        voice_map='{"zh-CN": "zh-CN-XiaoxiaoNeural"}',
        greeting_map='{"zh-CN": "你好"}',
        is_default=True,
        interview_brain="external",
    )
    # Deliberately leave an agent_id set AND an un-synced status: the fix must ignore both.
    persona.agent_id = "interviewer-abc:80"
    persona.agent_version = "80"
    persona.agent_sync_status = "none"
    await db_session.flush()

    vs = await voice_broker.create_voice_session(db_session, locale="zh-CN")

    default_model = get_settings().voice_live_default_model
    assert vs.mode == "model"  # external → dumb mouth, never agent mode
    assert vs.model == default_model  # falls back to the plain model, not the hosted agent
    assert "agent-name=" not in vs.signaling_url
    assert f"model={default_model}" in vs.signaling_url


@pytest.mark.asyncio
async def test_create_voice_session_no_avatar_when_no_character(db_session):
    # A persona with no character → voice-only (no avatar modality); the frontend shows the orb.
    persona = await psvc.create_persona(
        db_session,
        name="Interviewer",
        character="",
        voice_map='{"zh-CN": "zh-CN-XiaoxiaoNeural"}',
        is_default=True,
    )
    await psvc.mark_sync_succeeded(db_session, persona, agent_id="a", agent_version="1")
    vs = await voice_broker.create_voice_session(db_session, locale="zh-CN")
    assert vs.avatar_enabled is False
    assert "modalities" not in vs.session_config


@pytest.mark.asyncio
async def test_create_voice_session_greeting_follows_locale(db_session):
    persona = await psvc.create_persona(
        db_session,
        name="Interviewer",
        voice_map='{"en-US": "en-US-AvaNeural"}',
        greeting_map='{"zh-CN": "你好", "en-US": "Hello"}',
        is_default=True,
    )
    await psvc.mark_sync_succeeded(db_session, persona, agent_id="a", agent_version="1")
    vs = await voice_broker.create_voice_session(db_session, locale="en-US")
    assert vs.greeting == "Hello"
