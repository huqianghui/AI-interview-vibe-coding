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
# Azure Voice Live expects the real style slug; the persona's style is passed through verbatim.
DEFAULT_AVATAR_STYLE = "casual-sitting"
DEFAULT_VOICE_BY_LOCALE = {"zh-CN": "zh-CN-XiaoxiaoNeural", "en-US": "en-US-AvaNeural"}
FALLBACK_LOCALE = "zh-CN"

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
        "avatar": {
            "character": persona.character or DEFAULT_AVATAR_CHARACTER,
            "style": persona.style or DEFAULT_AVATAR_STYLE,
            "customized": False,
        },
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
        "avatar": {
            "character": persona.character or DEFAULT_AVATAR_CHARACTER,
            "style": persona.style or DEFAULT_AVATAR_STYLE,
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
