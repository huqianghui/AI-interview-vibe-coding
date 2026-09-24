"""Voice Live agent metadata builder (SPEC F5) — pure, provider-agnostic, CI-tested.

This module owns the exact bytes written into a Foundry prompt agent's
``microsoft.voice-live.configuration`` metadata. It is deliberately split out of the Azure
agent-sync adapter (which needs a live project client and is coverage-omitted) so the one thing
that has repeatedly bitten this integration — **the metadata SHAPE** — is verified without any
Azure call.

**The snake_case trap (F1 spike Trigger C).** The Voice Live ``session`` object must use
snake_case keys (``input_audio_transcription``, ``turn_detection``, ``end_of_utterance_detection``,
…). A camelCase variant is accepted by the API but leaves the Portal showing **Voice mode OFF** —
a silent failure that only surfaces at demo time. These tests are the guard: if anyone
"tidies" a key to camelCase, CI goes red here, not the client's Portal.

**512-char chunking.** Azure metadata values cap at 512 chars. The JSON config is split across
``microsoft.voice-live.configuration``, ``…configuration.1``, ``…configuration.2``, … (base key
holds the first chunk, then ``.1``/``.2``/… suffixes) — the official quickstart convention.
``decode_voice_live_metadata`` is the exact inverse (used for pull-back + round-trip tests).

No Azure imports. Input is the ORM persona (duck-typed) plus a requested locale; output is a flat
``dict[str, str]`` ready to hand to ``agents.create_version(metadata=...)``.
"""

import json
from typing import Any

VOICE_LIVE_ENABLED_KEY = "microsoft.voice-live.enabled"
VOICE_LIVE_CONFIG_KEY = "microsoft.voice-live.configuration"

# Fixed API vocabulary (constants, not per-persona config).
EOU_MODEL = "semantic_detection_v1_multilingual"
NOISE_SUPPRESSION_TYPE = "azure_deep_noise_suppression"
ECHO_CANCELLATION_TYPE = "server_echo_cancellation"
TRANSCRIPTION_MODEL = "azure-speech"
INTERIM_RESPONSE_TYPE = "llm_interim_response"
INTERIM_TRIGGERS = ("latency",)
INTERIM_LATENCY_THRESHOLD_MS = 500

# Persona avatar/voice fallbacks (only used when the persona leaves a field blank).
DEFAULT_AVATAR_CHARACTER = "lisa"
# Azure Voice Live expects the real style slug. A VIDEO persona's style is passed through verbatim;
# PHOTO avatars have no styles and any stored style is dropped (see build_avatar_config).
DEFAULT_AVATAR_STYLE = "casual-sitting"

# Azure ships TWO kinds of standard avatar, and Voice Live validates the `session.avatar` block
# differently for each (live-verified 2026-09-23, issue #103):
#   - VIDEO avatars (lisa/harry/meg/jeff/lori/max) take `character` + `style` (a real style slug).
#   - PHOTO avatars (VASA-1 talking heads: adrian/amara/…) have NO styles and MUST declare
#     `"type": "photo-avatar"` + `"model": "vasa-1"`; without them Azure treats the character as
#     a video avatar and rejects the session with `avatar_verification_failed` ("Avatar with
#     character [adrian] and style [None] not found") — the digital human never connects. A photo
#     avatar sent WITH a style (e.g. our video default "casual-sitting") is rejected the same way.
# Rosters mirror frontend/src/data/avatarCharacters.ts (VIDEO_CHARACTERS / PHOTO_SEEDS) — keep the
# two files in sync when Azure adds a character. Unknown characters fall back to the style
# heuristic in `is_photo_avatar`.
# Each VIDEO avatar's default style — Azure style slugs are PER CHARACTER ("casual-sitting" exists
# only for lisa; harry's are business/casual/youthful, …). Mirrors `defaultStyle` in the frontend
# roster. Used when a video persona has a blank style (Azure rejects `style: null` and rejects a
# slug the character doesn't have — live-verified 2026-09-23).
VIDEO_AVATAR_DEFAULT_STYLES: dict[str, str] = {
    "lisa": DEFAULT_AVATAR_STYLE,
    "harry": "business",
    "meg": "formal",
    "jeff": "business",
    "lori": "casual",
    "max": "business",
}
VIDEO_AVATAR_CHARACTERS = frozenset(VIDEO_AVATAR_DEFAULT_STYLES)
PHOTO_AVATAR_CHARACTERS = frozenset(
    {
        "adrian", "amara", "amira", "anika", "bianca", "camila", "carlos", "clara", "darius",
        "diego", "elise", "farhan", "faris", "gabrielle", "hyejin", "imran", "isabella", "layla",
        "liwei", "ling", "marcus", "matteo", "rahul", "rana", "ren", "riya", "sakura", "simone",
        "zayd", "zoe",
    }
)  # fmt: skip
PHOTO_AVATAR_TYPE = "photo-avatar"
PHOTO_AVATAR_MODEL = "vasa-1"
DEFAULT_VOICE_BY_LOCALE = {"zh-CN": "zh-CN-XiaoxiaoNeural", "en-US": "en-US-AvaNeural"}
FALLBACK_LOCALE = "en-US"

METADATA_CHUNK_SIZE = 512


def _parse_json_map(raw: str | None) -> dict[str, str]:
    """Parse a persona ``voice_map``/``greeting_map`` JSON string; never raise (bad data → {})."""
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def has_configured_voice(voice_map_raw: str | None) -> bool:
    """True when the persona carries at least one explicitly configured (non-blank) voice.

    Distinct from :func:`resolve_voice`, which always falls back to a built-in default voice:
    this asks whether the OPERATOR configured a voice at all — the signal the interview UI uses
    to default the candidate to the voice + digital-human channel instead of text (issue 3).
    """
    voice_map = _parse_json_map(voice_map_raw)
    return any(isinstance(v, str) and v.strip() for v in voice_map.values())


def resolve_voice(voice_map_raw: str | None, locale: str | None) -> tuple[str, str]:
    """Pick (locale, voice_name) from a persona ``voice_map``.

    Preference order: the requested locale → the fallback locale (zh-CN) → the map's first
    entry → a built-in default voice for the resolved locale. Always returns a usable pair.
    """
    voice_map = _parse_json_map(voice_map_raw)

    for candidate in (locale, FALLBACK_LOCALE):
        if candidate and voice_map.get(candidate):
            return candidate, voice_map[candidate]

    if voice_map:
        first_locale = next(iter(voice_map))
        if voice_map[first_locale]:
            return first_locale, voice_map[first_locale]

    resolved_locale = locale or FALLBACK_LOCALE
    return resolved_locale, DEFAULT_VOICE_BY_LOCALE.get(
        resolved_locale, DEFAULT_VOICE_BY_LOCALE[FALLBACK_LOCALE]
    )


def is_photo_avatar(character: str | None, style: str | None = None) -> bool:
    """True when ``character`` is an Azure PHOTO (VASA-1) avatar rather than a VIDEO avatar.

    Known rosters decide first. For a character in neither roster (a future Azure addition), a
    non-empty character with NO style is treated as photo — photo avatars have no style variants
    and the editor stores ``""`` for them, while a video avatar always carries a style slug.
    """
    name = (character or "").strip().lower()
    if not name:
        return False
    if name in VIDEO_AVATAR_CHARACTERS:
        return False
    if name in PHOTO_AVATAR_CHARACTERS:
        return True
    return not (style or "").strip()


# Painted by Azure BEHIND the digital human on candidate-facing (interview) sessions so the video's
# own backdrop merges with the interview stage (issue1 follow-up, 2026-09-24). RGBA hex. MUST equal
# the frontend's flat stage colour `AVATAR_STAGE_COLOR` (frontend/src/components/avatarFit.ts,
# "#1c1d3a"); the editor Playground keeps its light stage and does NOT send this.
INTERVIEW_STAGE_BACKGROUND_RGBA = "#1C1D3AFF"


def build_avatar_config(
    character: str | None, style: str | None, *, video: dict[str, Any] | None = None
) -> dict[str, Any]:
    """The snake_case ``session.avatar`` block for a persona's ``character``/``style``.

    Blank character → the video default (``lisa`` / ``casual-sitting``). Photo avatars get
    ``type``/``model`` and NO ``style``; video avatars get ``character`` + ``style`` (a blank style
    falls back to THAT character's default from ``VIDEO_AVATAR_DEFAULT_STYLES``, since Azure
    rejects both ``style: null`` and a slug the character doesn't have).
    ``video`` (codec/resolution) is appended verbatim when given. Single source of truth for the
    WS-proxy session (:mod:`app.services.voice_live_proxy`), the ``/calls`` broker session and the
    agent metadata below — the photo/video split must never drift between them.
    """
    # Azure matches character ids and style slugs as exact lowercase strings ("Adrian" is NOT
    # "adrian"), and the admin API does not normalize these fields — so normalize the WIRE values
    # here, not just the roster lookup, or a mixed-case persona hits avatar_verification_failed.
    name = (character or "").strip().lower() or DEFAULT_AVATAR_CHARACTER
    clean_style = (style or "").strip().lower()
    avatar: dict[str, Any]
    if is_photo_avatar(name, clean_style):
        avatar = {
            "type": PHOTO_AVATAR_TYPE,
            "model": PHOTO_AVATAR_MODEL,
            "character": name,
            "customized": False,
        }
    else:
        avatar = {
            "character": name,
            "style": clean_style or VIDEO_AVATAR_DEFAULT_STYLES.get(name, DEFAULT_AVATAR_STYLE),
            "customized": False,
        }
    if video is not None:
        avatar["video"] = video
    return avatar


def build_session(persona: Any, *, locale: str | None = None) -> dict[str, Any]:
    """Build the snake_case Voice Live ``session`` object from a persona.

    Keys that represent a disabled capability are emitted as explicit ``null`` (matching
    Foundry's own convention), EXCEPT ``turn_detection.end_of_utterance_detection`` which is
    omitted entirely when EOU is off (there is no meaningful "off" sub-object).
    """
    resolved_locale, voice_name = resolve_voice(persona.voice_map, locale)

    session: dict[str, Any] = {
        "voice": {
            "name": voice_name,
            "type": "azure-standard",
            "temperature": persona.voice_temperature,
            # Playback speed is stringified in the Voice Live schema.
            "rate": str(persona.playback_speed),
        },
        "input_audio_transcription": {
            "model": TRANSCRIPTION_MODEL,
            "language": resolved_locale,
        },
        "turn_detection": {"type": persona.turn_detection},
        "input_audio_noise_reduction": (
            {"type": NOISE_SUPPRESSION_TYPE} if persona.noise_suppression else None
        ),
        "input_audio_echo_cancellation": (
            {"type": ECHO_CANCELLATION_TYPE} if persona.echo_cancellation else None
        ),
        "avatar": build_avatar_config(persona.character, persona.style),
        "proactive_engagement": bool(persona.proactive_engagement),
        "interim_response": (
            {
                "type": INTERIM_RESPONSE_TYPE,
                "triggers": list(INTERIM_TRIGGERS),
                "latency_threshold_ms": INTERIM_LATENCY_THRESHOLD_MS,
            }
            if persona.interim_response
            else None
        ),
    }

    if persona.eou_detection:
        session["turn_detection"]["end_of_utterance_detection"] = {"model": EOU_MODEL}

    return session


def build_agent_metadata_session(persona: Any, *, locale: str | None = None) -> dict[str, Any]:
    """A COMPACT ``session`` for the agent's ``microsoft.voice-live.configuration`` metadata.

    Distinct from :func:`build_session` (the full runtime config sent over the WS at
    ``session.update`` time). Azure caps a metadata value at ~512 chars; the full config (~690
    chars) would be split across ``…configuration``/``…configuration.1``, and Voice Live does NOT
    reassemble the split — it fails agent initialization ("agent_initialization_failed"), verified
    live 2026-08-12 against a real Foundry project (a compact single-key config initializes fine;
    the working portal agent Dr-Zhang-Wei likewise carries a single unsplit key).

    So the metadata only needs the fields that ENABLE voice mode on the agent: voice,
    turn_detection, avatar, proactive_engagement. The verbose runtime knobs (transcription model,
    EOU sub-object, noise/echo suppression, interim-response triggers) apply at runtime via
    ``session.update``
    from :func:`build_session`, and are omitted here to keep the config in one metadata value.
    """
    _, voice_name = resolve_voice(persona.voice_map, locale)
    session: dict[str, Any] = {
        "voice": {
            "name": voice_name,
            "type": "azure-standard",
            "temperature": persona.voice_temperature,
        },
        "turn_detection": {"type": persona.turn_detection},
        # Same photo/video split as the runtime session (customized=False is Azure's default and
        # is dropped here to keep the metadata inside one 512-char value).
        "avatar": {
            k: v
            for k, v in build_avatar_config(persona.character, persona.style).items()
            if k != "customized"
        },
        "proactive_engagement": bool(persona.proactive_engagement),
    }
    return session


def chunk_metadata_value(
    key: str, value: str, *, max_len: int = METADATA_CHUNK_SIZE
) -> dict[str, str]:
    """Split ``value`` across ``key``, ``key.1``, ``key.2``, … at ``max_len`` boundaries."""
    if len(value) <= max_len:
        return {key: value}
    chunks: dict[str, str] = {}
    for chunk_num, start in enumerate(range(0, len(value), max_len)):
        chunk_key = key if chunk_num == 0 else f"{key}.{chunk_num}"
        chunks[chunk_key] = value[start : start + max_len]
    return chunks


def build_voice_live_metadata(
    persona: Any, *, locale: str | None = None, modified_at: int | None = None
) -> dict[str, str]:
    """Full agent metadata dict: enabled flag + chunked snake_case config JSON.

    ``modified_at`` is injectable for deterministic tests; when omitted it is left out entirely
    (the sync adapter stamps it at call time).
    """
    # Use the COMPACT session for agent metadata (Voice Live does not reassemble a split
    # `…configuration`/`…configuration.1` value — it fails agent init). Keep it in a single key.
    session = build_agent_metadata_session(persona, locale=locale)
    config_json = json.dumps({"session": session}, separators=(",", ":"), ensure_ascii=False)

    metadata: dict[str, str] = {VOICE_LIVE_ENABLED_KEY: "true"}
    metadata.update(chunk_metadata_value(VOICE_LIVE_CONFIG_KEY, config_json))
    if modified_at is not None:
        metadata["modified_at"] = str(modified_at)
    return metadata


def build_cleared_voice_metadata() -> dict[str, str]:
    """Metadata that turns Voice mode OFF (used when disabling a persona's agent)."""
    return {VOICE_LIVE_ENABLED_KEY: "false", VOICE_LIVE_CONFIG_KEY: "{}"}


def decode_voice_live_metadata(metadata: dict[str, str]) -> dict[str, Any]:
    """Inverse of the builder: reassemble the chunked config JSON → the ``session`` dict.

    Returns ``{}`` on any malformed input (never raises). Chunks are ordered by their numeric
    suffix so ``.10`` sorts after ``.9`` rather than lexicographically before it.
    """
    if metadata.get(VOICE_LIVE_ENABLED_KEY) != "true":
        return {}

    def _suffix_order(key: str) -> int:
        rest = key[len(VOICE_LIVE_CONFIG_KEY) :]
        return int(rest[1:]) if rest.startswith(".") and rest[1:].isdigit() else 0

    keys = sorted(
        (
            k
            for k in metadata
            if k == VOICE_LIVE_CONFIG_KEY or k.startswith(VOICE_LIVE_CONFIG_KEY + ".")
        ),
        key=_suffix_order,
    )
    if not keys:
        return {}
    joined = "".join(metadata[k] for k in keys)
    try:
        parsed = json.loads(joined)
    except (ValueError, TypeError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    session = parsed.get("session")
    return session if isinstance(session, dict) else {}
