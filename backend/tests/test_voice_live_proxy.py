"""Voice Live WS-proxy session builder (SPEC F9 avatar-video path) — pure-shape guard.

`build_avatar_session` is the one piece of the proxy that shapes what Azure receives at
`session.update` time; the live relay needs a real Azure connection and is coverage-omitted. These
tests lock the shape that makes the digital human WORK end-to-end:

- AVATAR modality present (+ h264 video) only when the persona has a character.
- Server VAD drives a hands-free turn for BANK personas: `create_response`/`interrupt_response`
  EXPLICITLY True, so Azure auto-generates the agent's spoken reply when the user stops speaking and
  lets the user barge in — the fix for "the interviewer transcribes me but never replies".
- EXTERNAL personas set `create_response=False`: the agent is purely the external brain's mouth
  (reads the injected `speech_text` only) and must never improvise its own turn — else it both
  duplicates the verbatim read (two Interviewer bubbles) and diverges from the question header.
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
    interview_brain: str = "bank"


def _as_dict(obj):
    """SDK models are MutableMappings; dict() gives the wire shape."""
    return dict(obj)


def test_avatar_session_enables_hands_free_vad_auto_response():
    session = build_avatar_session(FakePersona(), locale="zh-CN")
    td = _as_dict(session["turn_detection"])
    assert td["type"] == "azure_semantic_vad"
    # Bank persona: both EXPLICITLY set — hands-free auto-reply + barge-in (not Azure defaults).
    assert td["create_response"] is True
    assert td["interrupt_response"] is True


def test_avatar_session_disables_auto_response_for_external_brain():
    # External persona is the external brain's mouth only: it must NEVER auto-generate a turn (that
    # both duplicates the injected verbatim read and desyncs from the question header). VAD stays on
    # for transcription; only the auto-reply is suppressed. Barge-in stays enabled.
    session = build_avatar_session(FakePersona(interview_brain="external"), locale="zh-CN")
    td = _as_dict(session["turn_detection"])
    assert td["type"] == "azure_semantic_vad"
    assert td["create_response"] is False
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


# --- photo vs video avatars (issue #103) --------------------------------------


def test_avatar_session_photo_avatar_declares_type_and_model_without_style():
    # Regression (issue #103): picking a PHOTO avatar (Adrian) made Voice Live reject the session —
    # Azure only knows a photo avatar when the block carries `type: photo-avatar` + `model: vasa-1`
    # and NO style. Live-verified 2026-09-23 (agent + model mode): this shape gets session.updated
    # with `type: photo-avatar` + ice_servers; the old shape got `avatar_verification_failed`.
    session = build_avatar_session(FakePersona(character="adrian", style=""), locale="en-US")
    avatar = _as_dict(session["avatar"])
    assert avatar["type"] == "photo-avatar"
    assert avatar["model"] == "vasa-1"
    assert avatar["character"] == "adrian"
    assert avatar["customized"] is False
    assert avatar.get("style") is None
    assert _as_dict(avatar["video"])["codec"] == "h264"


def test_avatar_session_photo_avatar_drops_stale_video_style():
    # A style left over from a previous VIDEO pick must not ride along on a photo avatar.
    session = build_avatar_session(
        FakePersona(character="adrian", style="casual-sitting"), locale="en-US"
    )
    assert _as_dict(session["avatar"]).get("style") is None


def test_avatar_session_video_avatar_keeps_style_and_has_no_photo_fields():
    session = build_avatar_session(FakePersona(character="lisa", style="graceful"), locale="en-US")
    avatar = _as_dict(session["avatar"])
    assert avatar["character"] == "lisa"
    assert avatar["style"] == "graceful"
    assert avatar.get("type") is None
    assert avatar.get("model") is None


def test_avatar_session_video_avatar_blank_style_gets_default():
    # Azure rejects a video avatar with `style: null` AND a slug the character doesn't have
    # ("casual-sitting" is lisa-only) — fall back to that character's own default.
    session = build_avatar_session(FakePersona(character="harry", style=""), locale="en-US")
    assert _as_dict(session["avatar"])["style"] == "business"


def test_avatar_session_unknown_character_without_style_is_sent_as_photo():
    # Roster miss (future Azure character): the style heuristic decides, through the real SDK model.
    session = build_avatar_session(FakePersona(character="newface", style=""), locale="en-US")
    avatar = _as_dict(session["avatar"])
    assert avatar["type"] == "photo-avatar"
    assert avatar["model"] == "vasa-1"
    assert avatar.get("style") is None
    session = build_avatar_session(FakePersona(character="newface", style="formal"), locale="en-US")
    avatar = _as_dict(session["avatar"])
    assert avatar.get("type") is None
    assert avatar["style"] == "formal"
