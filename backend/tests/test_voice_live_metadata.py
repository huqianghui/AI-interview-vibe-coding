"""Voice Live metadata builder (SPEC F5) — the snake_case + chunking guard.

These tests lock the metadata SHAPE that makes the Portal show Voice mode ON (F1 spike Trigger
C). The failure mode they defend against is silent: a camelCase key is accepted by the API but
disables Voice mode, only visible at demo time. If a key drifts to camelCase, CI fails HERE.
"""

import json
from dataclasses import dataclass

from app.services.agents.voice_live_metadata import (
    VOICE_LIVE_CONFIG_KEY,
    VOICE_LIVE_ENABLED_KEY,
    build_cleared_voice_metadata,
    build_session,
    build_voice_live_metadata,
    chunk_metadata_value,
    decode_voice_live_metadata,
    resolve_voice,
)


@dataclass
class FakePersona:
    """Duck-typed stand-in for InterviewerPersona (no DB needed for a pure builder)."""

    voice_map: str = '{"zh-CN": "zh-CN-XiaoxiaoNeural", "en-US": "en-US-AvaNeural"}'
    character: str = "lisa"
    style: str = "professional"
    turn_detection: str = "azure_semantic_vad"
    eou_detection: bool = True
    noise_suppression: bool = True
    echo_cancellation: bool = True
    interim_response: bool = True
    proactive_engagement: bool = False
    voice_temperature: float = 0.8
    playback_speed: float = 1.0


# --- resolve_voice ---------------------------------------------------------


def test_resolve_voice_prefers_requested_locale():
    assert resolve_voice(FakePersona().voice_map, "en-US") == ("en-US", "en-US-AvaNeural")


def test_resolve_voice_falls_back_to_zh_cn():
    assert resolve_voice(FakePersona().voice_map, "fr-FR") == ("zh-CN", "zh-CN-XiaoxiaoNeural")


def test_resolve_voice_uses_first_entry_when_no_zh_cn():
    _, voice = resolve_voice('{"en-US": "en-US-AvaNeural"}', "de-DE")
    assert voice == "en-US-AvaNeural"


def test_resolve_voice_uses_builtin_default_for_empty_map():
    assert resolve_voice("{}", "en-US") == ("en-US", "en-US-AvaNeural")


def test_resolve_voice_survives_malformed_json():
    locale, voice = resolve_voice("not json", None)
    assert (locale, voice) == ("zh-CN", "zh-CN-XiaoxiaoNeural")


def test_resolve_voice_survives_empty_voice_map():
    assert resolve_voice("", "en-US") == ("en-US", "en-US-AvaNeural")
    assert resolve_voice(None, None) == ("zh-CN", "zh-CN-XiaoxiaoNeural")


# --- build_session shape (the snake_case guard) ----------------------------


def test_session_uses_snake_case_keys_only():
    session = build_session(FakePersona(), locale="en-US")
    expected_keys = {
        "voice",
        "input_audio_transcription",
        "turn_detection",
        "input_audio_noise_reduction",
        "input_audio_echo_cancellation",
        "avatar",
        "proactive_engagement",
        "interim_response",
    }
    assert set(session) == expected_keys
    # No key anywhere in the tree carries an uppercase letter (camelCase trap).
    blob = json.dumps(session)
    for key in _all_keys(session):
        assert key == key.lower(), f"non-snake_case key leaked: {key!r}"
    assert "endOfUtterance" not in blob and "inputAudio" not in blob


def test_eou_sub_object_present_and_snake_case_when_enabled():
    session = build_session(FakePersona(eou_detection=True))
    assert session["turn_detection"]["end_of_utterance_detection"] == {
        "model": "semantic_detection_v1_multilingual"
    }


def test_eou_sub_object_omitted_when_disabled():
    session = build_session(FakePersona(eou_detection=False))
    assert "end_of_utterance_detection" not in session["turn_detection"]


def test_disabled_capabilities_are_explicit_null_not_omitted():
    session = build_session(
        FakePersona(noise_suppression=False, echo_cancellation=False, interim_response=False)
    )
    assert session["input_audio_noise_reduction"] is None
    assert session["input_audio_echo_cancellation"] is None
    assert session["interim_response"] is None


def test_voice_rate_is_stringified_and_temperature_passthrough():
    session = build_session(FakePersona(playback_speed=1.25, voice_temperature=0.6))
    assert session["voice"]["rate"] == "1.25"
    assert session["voice"]["temperature"] == 0.6


def test_avatar_falls_back_when_blank():
    session = build_session(FakePersona(character="", style=""))
    assert session["avatar"] == {"character": "lisa", "style": "casual", "customized": False}


# --- chunking + full metadata ----------------------------------------------


def test_short_config_is_a_single_key():
    assert chunk_metadata_value("k", "x" * 500) == {"k": "x" * 500}


def test_long_config_splits_with_dot_suffixes():
    value = "x" * 1100  # -> 512 + 512 + 76
    chunks = chunk_metadata_value("k", value)
    assert list(chunks) == ["k", "k.1", "k.2"]
    assert chunks["k"] == "x" * 512
    assert "".join(chunks.values()) == value


def test_full_metadata_has_enabled_flag_and_valid_config_json():
    md = build_voice_live_metadata(FakePersona(), locale="zh-CN", modified_at=1700000000)
    assert md[VOICE_LIVE_ENABLED_KEY] == "true"
    assert md["modified_at"] == "1700000000"
    session = decode_voice_live_metadata(md)
    assert session["voice"]["name"] == "zh-CN-XiaoxiaoNeural"


def test_modified_at_omitted_when_not_given():
    md = build_voice_live_metadata(FakePersona())
    assert "modified_at" not in md


def test_metadata_roundtrips_through_decode_even_when_chunked():
    # Force chunking with a huge (valid JSON) voice name so config JSON exceeds 512 chars.
    persona = FakePersona(voice_map=json.dumps({"zh-CN": "v" * 900}))
    md = build_voice_live_metadata(persona, locale="zh-CN")
    # It really did chunk.
    assert f"{VOICE_LIVE_CONFIG_KEY}.1" in md
    session = decode_voice_live_metadata(md)
    assert session["voice"]["name"] == "v" * 900


def test_decode_returns_empty_when_disabled_or_malformed():
    assert decode_voice_live_metadata(build_cleared_voice_metadata()) == {}
    assert decode_voice_live_metadata({VOICE_LIVE_ENABLED_KEY: "true"}) == {}
    assert (
        decode_voice_live_metadata(
            {VOICE_LIVE_ENABLED_KEY: "true", VOICE_LIVE_CONFIG_KEY: "{not json"}
        )
        == {}
    )
    # Valid JSON, but not the expected {session: {...}} shape → empty, no raise.
    assert (
        decode_voice_live_metadata(
            {VOICE_LIVE_ENABLED_KEY: "true", VOICE_LIVE_CONFIG_KEY: "[1, 2, 3]"}
        )
        == {}
    )
    assert (
        decode_voice_live_metadata(
            {VOICE_LIVE_ENABLED_KEY: "true", VOICE_LIVE_CONFIG_KEY: '{"session": "notadict"}'}
        )
        == {}
    )


def test_cleared_metadata_turns_voice_off():
    cleared = build_cleared_voice_metadata()
    assert cleared[VOICE_LIVE_ENABLED_KEY] == "false"


def _all_keys(obj):
    """Yield every dict key in a nested structure."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k
            yield from _all_keys(v)
    elif isinstance(obj, list):
        for item in obj:
            yield from _all_keys(item)
