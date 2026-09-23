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
    has_configured_voice,
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


def test_resolve_voice_falls_back_to_en_us():
    assert resolve_voice(FakePersona().voice_map, "fr-FR") == ("en-US", "en-US-AvaNeural")


def test_resolve_voice_uses_first_entry_when_no_fallback_locale():
    # Neither the requested locale (de-DE) nor the fallback (en-US) is in the map, so the first
    # entry is used as a last resort.
    _, voice = resolve_voice('{"zh-CN": "zh-CN-XiaoxiaoNeural"}', "de-DE")
    assert voice == "zh-CN-XiaoxiaoNeural"


def test_resolve_voice_uses_builtin_default_for_empty_map():
    assert resolve_voice("{}", "en-US") == ("en-US", "en-US-AvaNeural")


def test_resolve_voice_survives_malformed_json():
    locale, voice = resolve_voice("not json", None)
    assert (locale, voice) == ("en-US", "en-US-AvaNeural")


def test_resolve_voice_survives_empty_voice_map():
    assert resolve_voice("", "en-US") == ("en-US", "en-US-AvaNeural")
    assert resolve_voice(None, None) == ("en-US", "en-US-AvaNeural")


def test_has_configured_voice_true_for_any_nonblank_entry():
    assert has_configured_voice('{"zh-CN": "zh-CN-XiaoxiaoNeural"}') is True
    assert has_configured_voice('{"zh-CN": "", "en-US": "en-US-AvaNeural"}') is True


def test_has_configured_voice_false_for_empty_blank_or_malformed():
    # Unlike resolve_voice (which always falls back to a built-in default), this reports whether
    # the operator configured anything at all — so all of these are False, not defaulted.
    assert has_configured_voice("{}") is False
    assert has_configured_voice('{"zh-CN": "  "}') is False
    assert has_configured_voice("not json") is False
    assert has_configured_voice(None) is False
    assert has_configured_voice('{"zh-CN": 3}') is False


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
    assert session["avatar"] == {
        "character": "lisa",
        "style": "casual-sitting",
        "customized": False,
    }


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


def test_agent_metadata_config_is_single_key_and_compact():
    # Regression: Voice Live rejects a SPLIT `…configuration`/`…configuration.1` metadata value
    # ("agent_initialization_failed"). A normal persona's agent metadata must stay in ONE key.
    md = build_voice_live_metadata(FakePersona(), locale="zh-CN")
    config_keys = [k for k in md if k.startswith(VOICE_LIVE_CONFIG_KEY)]
    assert config_keys == [VOICE_LIVE_CONFIG_KEY]  # exactly one, no ".1" chunk
    assert len(md[VOICE_LIVE_CONFIG_KEY]) <= 512
    # Carries the fields that ENABLE voice mode; omits the verbose runtime-only knobs.
    session = decode_voice_live_metadata(md)
    assert {"voice", "turn_detection", "avatar", "proactive_engagement"} <= session.keys()
    assert "input_audio_transcription" not in session
    assert "interim_response" not in session


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


# --- photo vs video avatars (issue #103) --------------------------------------
# Azure PHOTO avatars (VASA-1: adrian, amara, …) have no styles and MUST be sent as
# `type: photo-avatar` + `model: vasa-1`; without them (or WITH a style) Voice Live rejects the
# session with `avatar_verification_failed` and the digital human never connects. Video avatars
# (lisa, harry, …) keep `character` + `style`. Live-verified 2026-09-23 in agent AND model mode.

from app.services.agents.voice_live_metadata import (  # noqa: E402
    PHOTO_AVATAR_CHARACTERS,
    VIDEO_AVATAR_CHARACTERS,
    build_agent_metadata_session,
    build_avatar_config,
    is_photo_avatar,
)


def test_is_photo_avatar_uses_rosters_then_style_heuristic():
    assert is_photo_avatar("adrian") is True
    assert is_photo_avatar("Adrian", "") is True  # case-insensitive
    assert is_photo_avatar("lisa", "") is False  # known VIDEO avatar even with a blank style
    assert is_photo_avatar("", "") is False
    # Unknown (future) character: no style → photo, a style slug → video.
    assert is_photo_avatar("newface", "") is True
    assert is_photo_avatar("newface", "casual-sitting") is False
    assert not (PHOTO_AVATAR_CHARACTERS & VIDEO_AVATAR_CHARACTERS)
    assert len(PHOTO_AVATAR_CHARACTERS) == 30  # mirrors frontend/src/data/avatarCharacters.ts


def test_build_avatar_config_photo_has_type_model_and_no_style():
    assert build_avatar_config("adrian", "") == {
        "type": "photo-avatar",
        "model": "vasa-1",
        "character": "adrian",
        "customized": False,
    }
    # A stale style left over from a video pick must NOT leak onto a photo avatar (Azure rejects
    # "Avatar with character [adrian] and style [casual-sitting] not found").
    assert "style" not in build_avatar_config("adrian", "casual-sitting")


def test_build_avatar_config_video_keeps_style_and_defaults_blank_style():
    assert build_avatar_config("lisa", "casual-sitting") == {
        "character": "lisa",
        "style": "casual-sitting",
        "customized": False,
    }
    # A video avatar with a blank style gets THAT character's default slug — Azure rejects both
    # `style: null` and a slug the character doesn't have ("casual-sitting" is lisa-only).
    assert build_avatar_config("harry", "")["style"] == "business"
    assert build_avatar_config("meg", "")["style"] == "formal"
    assert build_avatar_config("lori", None)["style"] == "casual"
    assert build_avatar_config("lisa", "")["style"] == "casual-sitting"
    assert build_avatar_config("", "") == {
        "character": "lisa",
        "style": "casual-sitting",
        "customized": False,
    }


def test_build_avatar_config_appends_video_params():
    cfg = build_avatar_config("adrian", "", video={"codec": "h264"})
    assert cfg["video"] == {"codec": "h264"}
    assert cfg["type"] == "photo-avatar"


def test_build_session_photo_avatar_wire_shape():
    session = build_session(FakePersona(character="adrian", style=""))
    assert session["avatar"] == {
        "type": "photo-avatar",
        "model": "vasa-1",
        "character": "adrian",
        "customized": False,
    }


def test_agent_metadata_photo_avatar_stays_single_key_without_style():
    md = build_voice_live_metadata(FakePersona(character="gabrielle", style=""), locale="en-US")
    config_keys = [k for k in md if k.startswith(VOICE_LIVE_CONFIG_KEY)]
    assert config_keys == [VOICE_LIVE_CONFIG_KEY]  # still ONE ≤512-char value
    assert len(md[VOICE_LIVE_CONFIG_KEY]) <= 512
    avatar = decode_voice_live_metadata(md)["avatar"]
    assert avatar == {"type": "photo-avatar", "model": "vasa-1", "character": "gabrielle"}


def test_agent_metadata_video_avatar_unchanged():
    avatar = build_agent_metadata_session(FakePersona(character="lisa", style="graceful"))["avatar"]
    assert avatar == {"character": "lisa", "style": "graceful"}


def test_build_avatar_config_handles_none_character_and_style():
    # ORM/duck-typed personas may carry None rather than "" — same fallback either way.
    assert build_avatar_config(None, None) == {
        "character": "lisa",
        "style": "casual-sitting",
        "customized": False,
    }
    assert is_photo_avatar(None, None) is False


def test_avatar_rosters_match_frontend_roster():
    # The backend rosters MUST mirror frontend/src/data/avatarCharacters.ts (VIDEO_CHARACTERS +
    # PHOTO_SEEDS): a character added on one side only would regress into exactly the bug this
    # guards against (avatar_verification_failed on connect). Parse the ids + video defaultStyle
    # straight out of the TS source so drift fails CI instead of the next demo.
    import re
    from pathlib import Path

    from app.services.agents.voice_live_metadata import VIDEO_AVATAR_DEFAULT_STYLES

    ts = (Path(__file__).resolve().parents[2] / "frontend/src/data/avatarCharacters.ts").read_text()
    ids = set(re.findall(r'id:\s*"([a-z0-9]+)"', ts))
    assert ids == (VIDEO_AVATAR_CHARACTERS | PHOTO_AVATAR_CHARACTERS)
    video_defaults = dict(
        re.findall(r'id:\s*"([a-z0-9]+)",\s*[^}]*?defaultStyle:\s*"([a-z-]+)"', ts)
    )
    assert video_defaults == VIDEO_AVATAR_DEFAULT_STYLES


def test_build_avatar_config_unknown_character_uses_style_heuristic():
    # A character Azure adds before either roster is updated: no style → treated as photo (photo
    # avatars have none); a style slug → treated as video and passed through verbatim.
    assert build_avatar_config("newface", "") == {
        "type": "photo-avatar",
        "model": "vasa-1",
        "character": "newface",
        "customized": False,
    }
    assert build_avatar_config("newface", "formal") == {
        "character": "newface",
        "style": "formal",
        "customized": False,
    }


def test_agent_metadata_blank_character_falls_back_to_video_default():
    avatar = build_agent_metadata_session(FakePersona(character="", style=""))["avatar"]
    assert avatar == {"character": "lisa", "style": "casual-sitting"}


def test_build_avatar_config_normalizes_case_and_whitespace_on_the_wire():
    # Azure matches ids/slugs as exact lowercase strings; the admin API doesn't normalize them.
    assert build_avatar_config(" Adrian ", None)["character"] == "adrian"
    assert build_avatar_config(" Adrian ", None)["type"] == "photo-avatar"
    video = build_avatar_config("LISA", " Casual-Sitting ")
    assert video == {"character": "lisa", "style": "casual-sitting", "customized": False}


def test_agent_metadata_photo_avatar_with_long_voice_name_stays_single_key():
    # The photo shape is ~14 chars wider than the old video shape; make sure the longest roster id
    # plus a realistic long Azure voice name still fits ONE 512-char metadata value (a split value
    # fails agent initialization, see build_agent_metadata_session).
    longest_photo = max(PHOTO_AVATAR_CHARACTERS, key=len)
    voice_map = (
        '{"zh-CN": "zh-CN-XiaochenMultilingualNeural", "en-US": "en-US-AvaMultilingualNeural"}'
    )
    md = build_voice_live_metadata(
        FakePersona(character=longest_photo, style="", voice_map=voice_map), locale="zh-CN"
    )
    assert [k for k in md if k.startswith(VOICE_LIVE_CONFIG_KEY)] == [VOICE_LIVE_CONFIG_KEY]
    assert len(md[VOICE_LIVE_CONFIG_KEY]) <= 512
