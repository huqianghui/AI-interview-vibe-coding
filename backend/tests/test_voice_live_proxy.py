"""Voice Live WS-proxy session builder (SPEC F9 avatar-video path) — pure-shape guard.

`build_avatar_session` is the one piece of the proxy that shapes what Azure receives at
`session.update` time; the live relay needs a real Azure connection and is coverage-omitted. These
tests lock the shape that makes the digital human WORK end-to-end:

- AVATAR modality present (+ h264 video) only when the persona has a character.
- Server VAD drives a hands-free turn: `create_response`/`interrupt_response` EXPLICITLY True, so
  Azure auto-generates the agent's spoken reply when the user stops speaking and lets the user barge
  in — the fix for "the interviewer transcribes me but never replies".
"""

from dataclasses import dataclass

import pytest

# build_avatar_session shapes real azure-ai-voicelive SDK models, so these run only where the
# `azure` extra is installed (local Azure-equipped venv). CI installs `.[dev]` only — zero-Azure by
# design — so skip cleanly there rather than error, mirroring test_foundry_client's importorskip.
pytest.importorskip("azure.ai.voicelive.models")

from app.services.voice_live_proxy import build_avatar_session  # noqa: E402


@dataclass
class FakePersona:
    """Duck-typed stand-in for InterviewerPersona (pure builder needs no DB)."""

    voice_map: str = '{"zh-CN": "zh-CN-XiaoxiaoNeural"}'
    character: str = "lisa"
    style: str = "casual-sitting"
    agent_id: str = "interviewer-x:1"
    agent_version: str = "1"


def _as_dict(obj):
    """SDK models are MutableMappings; dict() gives the wire shape."""
    return dict(obj)


def test_avatar_session_enables_hands_free_vad_auto_response():
    session = build_avatar_session(FakePersona(), locale="zh-CN")
    td = _as_dict(session["turn_detection"])
    assert td["type"] == "azure_semantic_vad"
    # Both EXPLICITLY set — hands-free auto-reply + barge-in (not relying on Azure defaults).
    assert td["create_response"] is True
    assert td["interrupt_response"] is True


def test_avatar_session_includes_avatar_video_when_character_set():
    session = build_avatar_session(FakePersona(), locale="zh-CN")
    modalities = [str(m) for m in session["modalities"]]
    assert any("avatar" in m for m in modalities)
    avatar = _as_dict(session["avatar"])
    assert avatar["character"] == "lisa"
    assert _as_dict(avatar["video"])["codec"] == "h264"


def test_avatar_session_text_audio_only_when_no_character():
    persona = FakePersona(character="")
    session = build_avatar_session(persona, locale="zh-CN")
    modalities = [str(m) for m in session["modalities"]]
    assert not any("avatar" in m for m in modalities)
    with pytest.raises(KeyError):
        _ = session["avatar"]
