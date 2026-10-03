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

# How a PHOTO avatar is framed inside its 512x512 render. `AvatarConfig.scene` is the only lever
# that moves it: `zoom` is (0, +inf) with values below 1 zooming OUT, and `position_y` is [-1, 1]
# panning the subject by that fraction of the frame height (NEGATIVE moves the subject UP, which is
# what brings more of the body into view).
#
# WHY THIS EXISTS. The editor's avatar grid shows each character's CDN portrait — head, shoulders,
# clothes — while the live stream delivered a much tighter crop. Nothing on our side cuts it:
# measured live, a 512x512 stream shown `contain` in a 529x529 box, `bottomGapPx: 0` — the whole
# frame is on screen and the body simply continues past its bottom edge. The crop is Azure's.
#
# WHY ZOOM ALONE WAS NOT ENOUGH, which is what the first attempt got wrong. Azure composes the
# subject BOTTOM-ANCHORED, so zooming out shrinks the person without revealing more of them:
# measured on `layla`, zoom 0.78 and zoom 0.6 BOTH put the widest point (the shoulders) at 98% of
# the frame height with zero gap below. The shipped 0.78 therefore still showed hair and a sliver of
# shoulder, and the owner reported it again (2026-10-03: "the shoulders still are not right, and the
# admin page shows the buttons on the chest but the interview does not"). `position_y` is the lever
# that actually moves the framing down the body; `zoom` only buys back the head margin that the pan
# costs.
#
# THE VALUES ARE MEASURED, on three characters whose source portraits are framed differently, with
# the head-top margin recorded because a VASA-1 head MOVES and a margin that is fine at rest clips
# the hair on a nod:
#
#   zoom 0.62, position_y -0.12   amira  head top 38px, blazer lapels + inner top visible
#                                 layla  head top 26px, collar + blouse visible
#                                 imran  head top 38px, shoulders + polo shirt visible
#
# Rejected by the same measurements: 0.58/-0.15 reached slightly lower on the chest but left only
# 16px (3%) above the hair, too little for head motion.
#
# WHAT THIS CANNOT DO. The editor grid's portrait is a static CDN marketing photo, not a render of
# the same framing, so the two will never match pixel for pixel — the goal is the same COMPOSITION
# (a head-and-shoulders portrait with the garment visible), which these values produce.
#
# PHOTO ONLY: a video avatar is already a standing figure and zooming out just shrinks the person.
#
# A per-character map is the escape hatch if a fourth character disagrees (the roster already has
# per-character maps for styles and backdrops). Three independent characters landing on one pair is
# why there is a single global value instead.
#
# THE COST OF SHOWING MORE BODY, measured after the fact and NOT anticipated when these values
# were chosen. Framing further down the body also brings the garment into shot, and the live render
# does not reproduce it: on `layla`, whose source portrait is a fine floral print, the garment
# arrives as a smeared watercolour with no identifiable pattern, and it shifts frame to frame.
#
# Measured over 12 frames 400 ms apart — per-region mean RGB, frame-to-frame standard deviation
# summed across channels:
#
#   layla (fine floral)   face 7.01   garment 19.45    2.8x less stable than the FACE
#   amira (plain blazer)  face 4.21   garment  8.91    plain cloth smears into plain cloth
#
# The garment should be perfectly still — the sitter is not moving — so anything above the face's
# own number is the render redrawing it. A plain garment costs less than half the instability,
# which is the practical lever if this ever needs to look better.
#
# WHY is MY INFERENCE, not documentation: VASA-1 animates a FACE, so regions away from it are
# presumably weakly constrained and re-synthesised per frame rather than carried from the source
# photo. Microsoft documents nothing about this either way, and I have not verified it. The owner
# is asking the product group whether the behaviour is by design (2026-10-03) — if the answer says
# otherwise, this paragraph is the thing to correct.
#
# OWNER DECISION 2026-10-03: keep this framing FOR NOW. Explicitly PROVISIONAL, unlike the barge-in
# call in the perf review: a tighter crop hides the artifact but brings back the complaint these
# values fixed ("the shoulders are gone"), so neither side is free. Revisit after the product
# group answers, or if the smearing bothers a real viewer.
PHOTO_AVATAR_SCENE_ZOOM = 0.62
PHOTO_AVATAR_SCENE_POSITION_Y = -0.12
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
            # See PHOTO_AVATAR_SCENE_ZOOM: without this Azure frames much tighter than the
            # portrait the editor previews, and `zoom` alone cannot fix it because the subject is
            # bottom-anchored. Set here rather than in the proxy so the split cannot drift between
            # this builder's consumers, which is why it exists.
            "scene": {
                "zoom": PHOTO_AVATAR_SCENE_ZOOM,
                "position_y": PHOTO_AVATAR_SCENE_POSITION_Y,
            },
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
        # Same photo/video split as the runtime session. Two keys are dropped to keep the
        # metadata inside one 512-char value: `customized` (False is Azure's default anyway) and
        # `scene` (a photo avatar's framing). `scene` belongs with the verbose runtime knobs named
        # above — it shapes how a session LOOKS, not whether the agent can do voice, and it reaches
        # Azure via `session.update` like the rest. Spending this budget on it is what would split
        # the key, and a split key fails agent initialization outright.
        "avatar": {
            k: v
            for k, v in build_avatar_config(persona.character, persona.style).items()
            if k not in ("customized", "scene")
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
