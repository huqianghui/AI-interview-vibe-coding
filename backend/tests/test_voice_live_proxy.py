"""Voice Live WS-proxy session builder (SPEC F9 avatar-video path) — pure-shape guard.

`build_avatar_session` is the one piece of the proxy that shapes what Azure receives at
`session.update` time; the live relay needs a real Azure connection and is coverage-omitted. These
tests lock the shape that makes the digital human WORK end-to-end:

- AVATAR modality present (+ h264 video) only when the persona has a character.
- LINEAR TURNS decide `create_response` (whether server-VAD opens a MODEL turn on every candidate
  pause). Every candidate-facing session is linear ⇒ False: BANK "linear" (default) and BANK
  "judged" both read the backend's questions and never say "Thank you." per pause (the judge nudges
  off-WebSocket, not through a model turn). `interrupt_response` (barge-in) stays EXPLICITLY True in
  every mode.
- EXTERNAL personas are ALWAYS `create_response=False`: the agent is purely the external brain's
  mouth (reads the injected `speech_text` only) and must never improvise its own turn — else it both
  duplicates the verbatim read and diverges from the question header.
- The editor Playground (`playground=True`) is the ONE surface that keeps a model turn for a bank
  persona (a free conversation with its synced agent, not the interview flow); external stays linear
  there too. (The retired pre-v0.39 `bank_turn_mode="model"` was the only other model-turn path.)
- VAD shape (issue #114 PR-1): MOUTH sessions with the persona's `eou_detection` on get the
  multilingual VAD + end-of-utterance block (800 ms silence, filler removal, medium threshold,
  1.5 s timeout); agent sessions (the Playground) and eou-off personas keep the plain
  `azure_semantic_vad`. `create_response`/`interrupt_response` semantics are unchanged either way.
"""

import base64
import json
from dataclasses import dataclass

import pytest

# build_avatar_session shapes real azure-ai-voicelive SDK models, so these run only where the
# `azure` extra is installed (local Azure-equipped venv). CI installs `.[dev]` only — zero-Azure by
# design — so skip cleanly there rather than error, mirroring test_foundry_client's importorskip.
pytest.importorskip("azure.ai.voicelive.models")

from app.services.voice_live_proxy import (  # noqa: E402
    AUDIO_APPEND_TYPE,
    build_audio_append,
    build_avatar_session,
)


@dataclass
class FakePersona:
    """Duck-typed stand-in for InterviewerPersona (pure builder needs no DB)."""

    voice_map: str = '{"zh-CN": "zh-CN-XiaoxiaoNeural"}'
    character: str = "lisa"
    style: str = "casual-sitting"
    agent_id: str = "interviewer-x:1"
    agent_version: str = "1"
    interview_brain: str = "bank"
    bank_turn_mode: str = "linear"
    eou_detection: bool = True
    voice_temperature: float = 0.8
    playback_speed: float = 1.0


def _as_dict(obj):
    """SDK models are MutableMappings; dict() gives the wire shape."""
    return dict(obj)


def test_avatar_session_bank_linear_turns_by_default_disables_auto_response():
    # The "Thank you. Thank you. Thank you." fix: a bank persona that never touched the knob runs
    # LINEAR TURNS — server-VAD must NOT open a model turn on every candidate pause. VAD stays on
    # for transcription; only the auto-reply is suppressed. Barge-in stays EXPLICITLY enabled.
    session = build_avatar_session(FakePersona(), locale="zh-CN")
    td = _as_dict(session["turn_detection"])
    assert td["type"] == "azure_semantic_vad_multilingual"  # mouth session, eou on (PR-1)
    assert td["create_response"] is False
    assert td["interrupt_response"] is True


def test_avatar_session_bank_persona_without_the_field_is_linear():
    # A duck-typed / legacy persona object with no bank_turn_mode attribute at all falls back to the
    # safe silent contract, never to a chatty model turn.
    @dataclass
    class LegacyPersona:
        voice_map: str = "{}"
        character: str = ""
        style: str = ""
        agent_id: str = "x:1"
        agent_version: str = "1"
        interview_brain: str = "bank"

    td = _as_dict(build_avatar_session(LegacyPersona(), locale="en-US")["turn_detection"])
    assert td["create_response"] is False


def test_avatar_session_disables_auto_response_for_external_brain_regardless_of_bank_mode():
    # External persona is the external brain's mouth only: it must NEVER auto-generate a turn (that
    # both duplicates the injected verbatim read and desyncs from the question header) — whatever
    # the bank-only knob says. Barge-in stays enabled.
    for mode in ("linear", "judged"):
        session = build_avatar_session(
            FakePersona(interview_brain="external", bank_turn_mode=mode), locale="zh-CN"
        )
        td = _as_dict(session["turn_detection"])
        assert td["type"] == "azure_semantic_vad_multilingual"  # external is a mouth session
        assert td["create_response"] is False
        assert td["interrupt_response"] is True


def test_avatar_session_playground_keeps_model_turn_for_bank_only():
    # Editor Playground = free conversation with the agent to test its instructions, so a linear
    # bank persona keeps its model turn THERE (else the Playground would just be mute). External
    # has no agent to converse with and stays linear.
    bank = _as_dict(build_avatar_session(FakePersona(), locale="zh-CN", playground=True))
    assert _as_dict(bank["turn_detection"])["create_response"] is True
    ext = build_avatar_session(
        FakePersona(interview_brain="external"), locale="zh-CN", playground=True
    )
    assert _as_dict(ext["turn_detection"])["create_response"] is False


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


# --- input audio sampling rate (weak-network uplink cut) ----------------------


def test_session_declares_the_configured_input_sampling_rate():
    """Azure decodes our raw PCM16 at whatever the session declares, so this field is not an
    optimisation but a correctness contract with the browser's MIC_SAMPLE_RATE."""
    from app.config import get_settings

    session = build_avatar_session(FakePersona(), locale="zh-CN")
    assert session["input_audio_sampling_rate"] == get_settings().voice_live_input_sampling_rate


def test_avatar_less_persona_also_declares_the_input_sampling_rate():
    """Regression guard for the settings hoist: the rate is a TOP-LEVEL session field, but
    ``get_settings()`` used to be read only inside the ``if has_avatar`` branch. An avatar-less
    persona must still tell Azure the uplink rate, or its transcripts come out garbled."""
    from app.config import get_settings

    session = build_avatar_session(FakePersona(character=""), locale="zh-CN")
    assert session["input_audio_sampling_rate"] == get_settings().voice_live_input_sampling_rate


def test_an_unsupported_input_sampling_rate_refuses_to_boot(monkeypatch):
    """Azure takes only 16000/24000 for pcm16. A typo used to boot fine and then break every
    voice connection at session.update time — reading as "voice is broken", not "bad config"."""
    import pytest as _pytest

    from app.config import Settings

    monkeypatch.setenv("VOICE_LIVE_INPUT_SAMPLING_RATE", "22050")
    with _pytest.raises(ValueError, match="VOICE_LIVE_INPUT_SAMPLING_RATE"):
        Settings()

    monkeypatch.setenv("VOICE_LIVE_INPUT_SAMPLING_RATE", "24000")
    assert Settings().voice_live_input_sampling_rate == 24000


# --- avatar video params (bitrate escape hatch) -------------------------------


def test_avatar_video_omits_bitrate_when_the_setting_is_unset():
    """Default is "let Azure decide": Azure adapts its own bitrate, so the key must be
    ABSENT rather than sent as None (which Azure would reject)."""
    session = build_avatar_session(FakePersona(), locale="zh-CN")
    video = _as_dict(_as_dict(session["avatar"])["video"])
    assert video["codec"] == "h264"
    assert "bitrate" not in video


def test_avatar_video_carries_the_configured_bitrate_cap(monkeypatch):
    """The one server-side bandwidth lever Azure honours (a client-side SDP b=AS cap is ignored —
    measured 2026-09-30), so a configured value must actually reach the session."""
    from app.config import get_settings

    get_settings.cache_clear()
    monkeypatch.setenv("VOICE_LIVE_AVATAR_VIDEO_BITRATE", "500000")
    try:
        session = build_avatar_session(FakePersona(), locale="zh-CN")
        video = _as_dict(_as_dict(session["avatar"])["video"])
        assert video["bitrate"] == 500000
    finally:
        get_settings.cache_clear()


def test_avatar_video_keeps_background_alongside_a_bitrate_cap(monkeypatch):
    """Both optional keys are built by separate branches now; neither may clobber the other."""
    from app.config import get_settings

    get_settings.cache_clear()
    monkeypatch.setenv("VOICE_LIVE_AVATAR_VIDEO_BITRATE", "300000")
    try:
        session = build_avatar_session(FakePersona(), locale="zh-CN", background="c09d75")
        video = _as_dict(_as_dict(session["avatar"])["video"])
        assert video["bitrate"] == 300000
        assert video["background"] == {"color": "#C09D75FF"}
    finally:
        get_settings.cache_clear()


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


# --- turn_detection shape (issue #114 PR-1): multilingual VAD + EOU for mouth sessions ------------


def _td(persona, **kw):
    return _as_dict(build_avatar_session(persona, locale="en-US", **kw)["turn_detection"])


def test_mouth_session_gets_multilingual_vad_with_eou_block():
    # Bank linear (mouth) with the persona's eou_detection on: the exact constants from the spec.
    td = _td(FakePersona())
    assert td["type"] == "azure_semantic_vad_multilingual"
    assert td["silence_duration_ms"] == 800
    assert td["remove_filler_words"] is True
    eou = _as_dict(td["end_of_utterance_detection"])
    # Cascaded (a chat model) is the default and keeps exactly what it has always shipped.
    assert eou["model"] == "semantic_detection_v1_multilingual"
    assert eou["threshold_level"] == "medium"
    assert eou["timeout_ms"] == 1500
    assert td["create_response"] is False
    assert td["interrupt_response"] is True


def test_realtime_sessions_switch_to_the_audio_detector_and_cascaded_ones_do_not():
    """The detector is chosen by PIPELINE, and getting it wrong breaks the session outright.

    The text detector reads the recognised transcript, which only exists on a cascaded pipeline, so
    a speech-to-speech model refuses the whole session: "Text-based end-of-utterance detection
    requires a local speech recognizer and is only supported on cascaded pipelines"
    (``param: session.turn_detection.end_of_utterance_detection``). That one line was the only
    thing keeping realtime voice models out. Cascaded sessions keep the text detector, so the chat
    path this product ships on is unchanged.
    """
    cascaded = _as_dict(_td(FakePersona())["end_of_utterance_detection"])
    assert cascaded["model"] == "semantic_detection_v1_multilingual"
    assert cascaded["timeout_ms"] == 1500

    realtime = _as_dict(_td(FakePersona(), realtime_pipeline=True)["end_of_utterance_detection"])
    assert realtime["model"] == "smart_end_of_turn_detection"
    assert realtime["timeout_ms"] == 1000


def test_the_two_eou_timeouts_are_the_measured_values_not_round_numbers():
    """1500 is what cascaded always shipped; 1000 came out of an A/B on real audio.

    The audio detector at 1500 ms ends a turn ~0.45-0.6 s later than the text one; at 1000 ms it is
    level (English last-stop 7.68 s vs 7.57 s, Chinese 8.96 s vs 8.98 s). At 700 ms the behaviour
    CHANGED rather than sped up — it stopped splitting at a 1.2 s pause and merged the answer into
    one segment ending at 9.08 s, unexplained. Re-run scripts/voice_live_eou_ab.py before touching
    either value.
    """
    from app.services.voice_live_proxy import MOUTH_EOU_AUDIO_TIMEOUT_MS, MOUTH_EOU_TIMEOUT_MS

    assert MOUTH_EOU_TIMEOUT_MS == 1500
    assert MOUTH_EOU_AUDIO_TIMEOUT_MS == 1000


def test_eou_off_wins_over_the_pipeline_choice():
    # A persona that turned end-of-utterance detection off keeps the plain VAD on BOTH pipelines —
    # the pipeline picks the detector, it does not re-enable one.
    for realtime in (False, True):
        td = _td(FakePersona(eou_detection=False), realtime_pipeline=realtime)
        assert td["type"] == "azure_semantic_vad"
        assert "end_of_utterance_detection" not in td


def test_external_mouth_session_gets_the_same_vad_shape():
    td = _td(FakePersona(interview_brain="external"))
    assert td["type"] == "azure_semantic_vad_multilingual"
    eou = _as_dict(td["end_of_utterance_detection"])
    assert eou["model"] == "semantic_detection_v1_multilingual"
    assert td["create_response"] is False


def test_eou_detection_off_keeps_the_plain_vad_for_mouth_sessions():
    personas = (
        FakePersona(eou_detection=False),
        FakePersona(interview_brain="external", eou_detection=False),
    )
    for persona in personas:
        td = _td(persona)
        assert td["type"] == "azure_semantic_vad"
        assert "end_of_utterance_detection" not in td
        assert "silence_duration_ms" not in td
        assert td["create_response"] is False
        assert td["interrupt_response"] is True


def test_agent_sessions_keep_the_plain_vad_regardless_of_eou_knob():
    # The editor Playground is the one remaining AGENT session (a bank persona keeps its model turn
    # there to converse with its synced agent): untouched by PR-1 — plain VAD, auto-reply on.
    td = _td(FakePersona(), playground=True)
    assert td["type"] == "azure_semantic_vad"
    assert "end_of_utterance_detection" not in td
    assert td["create_response"] is True
    assert td["interrupt_response"] is True


def test_legacy_persona_without_eou_field_defaults_to_eou_on():
    @dataclass
    class Legacy:
        voice_map: str = "{}"
        character: str = ""
        style: str = ""
        agent_id: str = "x:1"
        agent_version: str = "1"
        interview_brain: str = "bank"

    assert _td(Legacy())["type"] == "azure_semantic_vad_multilingual"


def test_avatar_session_paints_the_requested_avatar_background_only_when_given():
    # Owner rule (2026-09-24): ONE colour, no visible frame. The page passes the photo avatar's
    # own thumbnail backdrop (frontend PHOTO_BACKDROPS) as `avatar_bg`; Azure paints it behind the
    # digital human so the live video matches the editor preview. Without it: Azure's default.
    persona = FakePersona(character="amira", style="")
    painted = _as_dict(
        _as_dict(build_avatar_session(persona, locale="en-US", background="c09d75")["avatar"])[
            "video"
        ]
    )
    assert painted["background"] == {"color": "#C09D75FF"}
    assert painted["codec"] == "h264"
    plain = _as_dict(_as_dict(build_avatar_session(persona, locale="en-US")["avatar"])["video"])
    assert "background" not in plain


def test_avatar_session_voice_carries_the_persona_temperature_and_rate():
    # The editor's "Voice temperature" / "Playback speed" knobs only ever reached the legacy /calls
    # metadata builder; on the WS-proxy path production uses they were dropped, so adjusting them
    # did nothing (2026-09-30). They ride session.voice — the only place speech expressiveness and
    # speed can be set (prompt text cannot reach them). rate is a string per the Voice Live schema.
    session = build_avatar_session(
        FakePersona(voice_temperature=0.35, playback_speed=1.2), locale="zh-CN"
    )
    voice = _as_dict(session["voice"])
    assert voice["type"] == "azure-standard"
    assert voice["name"] == "zh-CN-XiaoxiaoNeural"
    assert voice["temperature"] == 0.35
    assert voice["rate"] == "1.2"


def test_avatar_session_voice_defaults_when_the_persona_lacks_the_knobs():
    # A duck-typed / legacy persona without the fields gets the model defaults, not a crash.
    @dataclass
    class Bare:
        voice_map: str = '{"en-US": "en-US-AvaNeural"}'
        character: str = ""
        style: str = ""
        agent_id: str = ""
        agent_version: str = ""
        interview_brain: str = "bank"

    voice = _as_dict(build_avatar_session(Bare(), locale="en-US")["voice"])
    assert voice["temperature"] == 0.8 and voice["rate"] == "1.0"


def test_avatar_session_voice_clamps_out_of_range_knobs_instead_of_breaking_the_session():
    # Rows saved before the API bounds existed (the editor allowed temperature up to 2 and speed up
    # to 2) must not make Azure reject session.update — clamp to the documented range.
    voice = _as_dict(
        build_avatar_session(
            FakePersona(voice_temperature=1.8, playback_speed=2.0), locale="zh-CN"
        )["voice"]
    )
    assert voice["temperature"] == 1.0 and voice["rate"] == "1.5"
    voice = _as_dict(
        build_avatar_session(
            FakePersona(voice_temperature=-0.3, playback_speed=0.1), locale="zh-CN"
        )["voice"]
    )
    assert voice["temperature"] == 0.0 and voice["rate"] == "0.5"


def test_avatar_session_voice_carries_the_knobs_in_playground_mode_too():
    # The editor Playground pins a persona on the same builder; its speech knobs must apply there
    # exactly as in the candidate interview (coverage audit: parity previously unasserted).
    voice = _as_dict(
        build_avatar_session(
            FakePersona(voice_temperature=0.2, playback_speed=1.3), locale="en-US", playground=True
        )["voice"]
    )
    assert voice["temperature"] == 0.2 and voice["rate"] == "1.3"


# ─── Binary mic uplink (perf review P0-1) ─────────────────────────────────────────────────────────
# The page used to base64-encode every mic batch and wrap it in JSON before sending. Measured on a
# live session, that cost 391 kbps of payload for 256 kbps of audio: base64's +1/3 plus a ~47-byte
# JSON envelope charged per message. The envelope part was fixed by batching 40 ms in the worklet
# (391 -> 351 kbps); this function removes the base64 from the browser hop. Azure's own protocol has
# no binary audio frame, so the encode still has to happen — just on this side.
#
# The relay that calls it needs a live Azure socket and is coverage-omitted, so these tests are the
# only guard on the wrapping. A wrong shape here is a silently dead microphone.


def test_build_audio_append_wraps_pcm_as_base64_client_event():
    pcm = bytes([0x00, 0x01, 0xFF, 0x7F, 0x80, 0x00])
    event = build_audio_append(pcm)
    assert event == {"type": AUDIO_APPEND_TYPE, "audio": base64.b64encode(pcm).decode("ascii")}
    # The exact event name Voice Live expects — a typo here is accepted by the socket and then
    # ignored, so the candidate's audio would vanish with no error anywhere.
    assert event["type"] == "input_audio_buffer.append"


def test_build_audio_append_round_trips_a_full_40ms_batch_byte_for_byte():
    # 40 ms of 16 kHz mono PCM16 = 640 samples = 1280 bytes: exactly what the worklet transfers.
    pcm = bytes((i * 37) % 256 for i in range(1280))
    assert base64.b64decode(build_audio_append(pcm)["audio"]) == pcm


def test_build_audio_append_emits_ascii_str_not_bytes():
    # `json.dumps` of a bytes value raises, and the SDK serialises this dict — the decode matters.
    audio = build_audio_append(b"\x01\x02")["audio"]
    assert isinstance(audio, str)
    json.dumps({"audio": audio})


def test_build_audio_append_handles_an_empty_batch_without_raising():
    # Defensive: a zero-length binary frame should produce a harmless no-op event, never a crash
    # that takes the whole relay — and with it the session — down.
    assert build_audio_append(b"") == {"type": AUDIO_APPEND_TYPE, "audio": ""}


# The session a CASCADED (chat-model) interview sends, field for field. Captured from the code that
# shipped before any of the voice-model / end-of-utterance work and verified byte-identical across
# v0.42.6.0, v0.43.1.0 and today — five persona shapes and both locales. Its job is to fail loudly
# if the path that every live interview actually runs on is changed by accident while someone is
# editing the realtime branch beside it.
SHIPPED_CASCADED_SESSION = {
    "input_audio_echo_cancellation": {"type": "server_echo_cancellation"},
    "input_audio_noise_reduction": {"type": "azure_deep_noise_suppression"},
    "input_audio_sampling_rate": 16000,
    "input_audio_transcription": {"language": "en-US", "model": "azure-speech"},
    "modalities": ["text", "audio", "avatar"],
    "turn_detection": {
        "create_response": False,
        "end_of_utterance_detection": {
            "model": "semantic_detection_v1_multilingual",
            "threshold_level": "medium",
            "timeout_ms": 1500,
        },
        "interrupt_response": True,
        "remove_filler_words": True,
        "silence_duration_ms": 800,
        "type": "azure_semantic_vad_multilingual",
    },
    "voice": {
        "name": "en-US-AvaNeural",
        "rate": "1.0",
        "temperature": 0.8,
        "type": "azure-standard",
    },
}


def _plain(obj):
    """SDK models are MutableMappings holding enums; flatten to plain JSON-ish values."""
    if hasattr(obj, "as_dict"):
        obj = obj.as_dict()
    if hasattr(obj, "keys"):
        return {str(k): _plain(v) for k, v in dict(obj).items()}
    if isinstance(obj, (list, tuple)):
        return [_plain(v) for v in obj]
    return getattr(obj, "value", obj)


def test_the_cascaded_session_still_matches_what_shipped_field_for_field():
    """The chat-model path must not move while the realtime branch next to it does.

    This is the guard for "are you sure nothing else changed?" — a question no amount of reading the
    diff answers as well as rebuilding the session and comparing it. The avatar block is excluded on
    purpose: it is roster data (character, framing, bitrate), not session behaviour.
    """
    built = _plain(
        build_avatar_session(
            FakePersona(voice_map='{"en-US": "en-US-AvaNeural"}'),
            locale="en-US",
            playground=False,
            background=None,
        )
    )
    built.pop("avatar", None)
    assert built == SHIPPED_CASCADED_SESSION


def test_the_realtime_session_differs_from_the_shipped_one_in_exactly_one_field():
    """And the realtime branch may only move the detector — nothing else about the session.

    Written as a diff rather than a second golden copy: the point being locked is that choosing a
    realtime voice model changes the end-of-utterance detector and NOTHING else (same voice, same
    transcription, same modalities, same VAD envelope).
    """
    realtime = _plain(
        build_avatar_session(
            FakePersona(voice_map='{"en-US": "en-US-AvaNeural"}'),
            locale="en-US",
            playground=False,
            background=None,
            realtime_pipeline=True,
        )
    )
    realtime.pop("avatar", None)
    differing = {
        k
        for k in set(realtime) | set(SHIPPED_CASCADED_SESSION)
        if realtime.get(k) != SHIPPED_CASCADED_SESSION.get(k)
    }
    assert differing == {"turn_detection"}
    cascaded_td = dict(SHIPPED_CASCADED_SESSION["turn_detection"])
    realtime_td = dict(realtime["turn_detection"])
    assert {
        k for k in set(realtime_td) | set(cascaded_td) if realtime_td.get(k) != cascaded_td.get(k)
    } == {"end_of_utterance_detection"}
