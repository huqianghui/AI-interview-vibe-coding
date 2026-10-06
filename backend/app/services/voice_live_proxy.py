"""Voice Live WebSocket proxy: backend holds the Azure SDK connection so avatar VIDEO works.

The candidate/editor browser opens a plain WebSocket to OUR backend (not directly to Azure). We hold
the ``azure-ai-voicelive`` SDK connection server-side and relay both directions. The browser cannot
connect straight to Azure for this, because Azure only delivers ``avatar.ice_servers`` and the
avatar SDP handshake (the browser's ``session.avatar.connect`` -> Azure's
``session.avatar.connecting`` with ``server_sdp``) over the *same* connection that sent
``session.update``. A short-lived STS credential handed to the browser for a brand-new WebRTC
connection cannot reuse that avatar SDP context, so avatar video needs the backend in the loop as a
relay. Ported from the working reference implementation (AI-avatar-vibe-coding's
``voice_live_websocket.py``), trimmed to this project's persona model.

Two pieces, split the same way as the rest of this codebase's Azure integrations:

- :func:`build_avatar_session` — pure session-shape builder (no Azure network), CI-tested.
- :func:`run_proxy` — the live relay loop. Coverage-omitted (``# pragma: no cover``): it needs a
  real Azure Voice Live connection and CI has none.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from app.config import get_settings
from app.models.persona import (
    InterviewerPersona,
    build_read_directive,
    default_external_reader_prompt,
)
from app.services.agents.voice_live_metadata import build_avatar_config, resolve_voice
from app.services.azure_auth import COGNITIVE_SERVICES_SCOPE, get_azure_credential_cached

logger = logging.getLogger(__name__)

PROXY_CONNECTED_TYPE = "proxy.connected"
AUDIO_APPEND_TYPE = "input_audio_buffer.append"
ERROR_TYPE = "error"

# Human-readable names for the locales the UI offers (frontend/src/i18n.ts SUPPORTED_LANGUAGES).
# Unknown locales fall back to the tag itself, which models read fine ("fr-FR").
_LANGUAGE_NAMES = {
    "zh-CN": "Chinese (中文)",
    "en-US": "English",
}


def build_language_pin_item(locale: str | None) -> dict[str, Any]:
    """A system conversation item that pins the WHOLE session to one language.

    Why this exists (the "说着说着变中文" bug): the agent's instructions used to say "conduct the
    interview in the candidate's language", so every server-VAD auto-response re-guessed the
    candidate's language from the latest transcript — and an accented answer or a noisy STT result
    flipped the interviewer into Chinese mid-interview. The language is the CANDIDATE's explicit UI
    choice (the ``locale`` query param), not a per-turn model guess, so we state it once as a
    session-scoped system message right after ``session.update``. Agent mode rejects overriding
    ``instructions`` in ``response.create`` (live-verified), and re-syncing the Foundry agent per
    session is wasteful — a system conversation item is the one per-session channel that works for
    both agent and model modes.

    Pure shaping (no network, no SDK imports) so it's unit-testable in the zero-Azure CI.
    """
    resolved = (locale or "").strip() or "en-US"
    language = _LANGUAGE_NAMES.get(resolved, resolved)
    text = (
        f"SESSION LANGUAGE: {language}. Conduct this ENTIRE interview in {language} only — every "
        "question, follow-up, acknowledgement, and closing remark. Do not translate or rephrase "
        "the provided questions into any other language. Do not switch languages because of the "
        "candidate's accent, wording, or the language they answer in. Switch ONLY if the candidate "
        "explicitly asks you to use another language."
    )
    return {
        "type": "conversation.item.create",
        "item": {
            "type": "message",
            "role": "system",
            "content": [{"type": "input_text", "text": text}],
        },
    }


def build_reader_prompt_item(text: str) -> dict[str, Any]:
    """A system conversation item carrying the EXTERNAL-mode reader prompt.

    Same shape and channel as :func:`build_language_pin_item` — a session-scoped ``role: "system"``
    message sent right after ``session.update``. In external mode the persona is a pure "mouth"
    running MODEL mode with no Foundry agent (v0.37.1.9), so there are no agent ``instructions`` to
    carry the reading contract; this system item is the one channel that shapes how it reads each
    injected ``speech_text`` (Azure rejects overriding ``instructions`` in ``response.create``).

    Pure shaping (no network, no SDK imports) so it's unit-testable in the zero-Azure CI.
    """
    return {
        "type": "conversation.item.create",
        "item": {
            "type": "message",
            "role": "system",
            "content": [{"type": "input_text", "text": text}],
        },
    }


# The certifi-backed SSL context is identical for every connection, so build it once and reuse it
# across connects instead of paying ssl.create_default_context (reads + parses the CA bundle) on
# each run_proxy call. Cached lazily so importing this module never requires ssl/certifi.
_ssl_ctx_cache: Any = None


def _certifi_ssl_context() -> Any:  # pragma: no cover — trivial cache around stdlib ssl/certifi
    """Return a process-wide certifi CA-bundle SSL context (built once, then reused).

    aiohttp (the voicelive SDK's WS transport) uses the OS trust store, which on macOS/some Linux
    can't verify Azure's cert chain → "CERTIFICATE_VERIFY_FAILED, unable to get local issuer
    certificate". Pointing it at certifi's CA bundle fixes that (live-verified). The context is
    immutable for our use, so one instance serves every connection.
    """
    global _ssl_ctx_cache
    if _ssl_ctx_cache is None:
        import ssl

        import certifi

        _ssl_ctx_cache = ssl.create_default_context(cafile=certifi.where())
    return _ssl_ctx_cache


def linear_turns_for_persona(persona: InterviewerPersona, *, playground: bool = False) -> bool:
    """Whether this persona's voice session runs LINEAR TURNS (no model turn of its own).

    Every candidate-facing session is linear since v0.39.0.0: external personas supply no brain,
    and both bank modes (``linear`` and ``judged``) read the backend's text verbatim — the judge
    nudges off-WebSocket, never through a model turn. The one surface that keeps a model turn is
    the editor Playground (``playground=True``, pinned ``persona_id``): a free conversation with a
    BANK persona's synced agent to test its instructions, where the linear contract would just mute
    it. External stays linear even there (it has no agent to converse with).
    """
    is_external = (getattr(persona, "interview_brain", "bank") or "bank") == "external"
    if is_external:
        return True
    return not playground


# Interim response ("one moment, let me check" while the model is slow or calling a tool). Azure's
# documented default threshold, made explicit so a server-side default change cannot move it.
INTERIM_RESPONSE_LATENCY_MS = 2000


def interim_response_applies(
    persona: InterviewerPersona, *, playground: bool = False, realtime_pipeline: bool = False
) -> bool:
    """Whether the session carries ``interim_response``: the persona's toggle, Playground only.

    A candidate interview never does. Every candidate session is a mouth (see is_mouth_persona):
    each question is server-side TTS of the exact card text, so there is no model turn to bridge,
    and a filler line would be speech the card does not show. In the Playground the persona keeps a
    model turn, so the toggle applies — except in MODEL mode on a speech-to-speech model, which
    Azure documents as unsupported (agent mode has no such restriction).
    """
    if not bool(getattr(persona, "interim_response", False)):
        return False
    if is_mouth_persona(persona, playground=playground):
        return False
    agent_mode = bool((getattr(persona, "agent_id", "") or "").strip())
    return agent_mode or not realtime_pipeline


def is_mouth_persona(persona: InterviewerPersona, *, playground: bool = False) -> bool:
    """Whether this voice session is a pure "MOUTH": MODEL mode + reader prompt, no Foundry agent.

    A mouth only reads the text the backend hands it each turn and never generates a turn of its
    own. That is every EXTERNAL persona (the external workflow is the brain) AND every LINEAR-TURNS
    bank persona (v0.38.3.1): under linear turns the agent's brain has no turn left to use, and
    keeping the agent attached is actively harmful — live-verified 2026-09-24: with the question
    riding as an assistant item, the agent's own instructions ("acknowledge when the candidate
    finishes") won over the item and the response meant to read question 2 said "Thank you."
    instead, so the question was never spoken. The read itself is ``response.create`` +
    ``pre_generated_assistant_message`` (server-side TTS of the exact text, no model inference —
    v0.39.2.3); the earlier ``response.instructions`` read was still a model turn and gpt-5-mini
    drifted on it mid-interview (2026-09-28: card said one bank question, the avatar asked another).
    Since v0.39.0.0 every candidate-facing bank session (linear OR judged) is a mouth; the only
    surface that keeps the agent is the editor Playground for a bank persona (free conversation).
    The pre-v0.39 ``bank_turn_mode="model"`` in-interview agent turn is retired and migrated away.
    """
    return linear_turns_for_persona(persona, playground=playground)


# Mouth-session VAD/EOU tuning (issue #114 PR-1). Constants, not admin knobs: the only per-persona
# switch is ``eou_detection`` (already on the model).
MOUTH_VAD_TYPE = "azure_semantic_vad_multilingual"
MOUTH_VAD_SILENCE_MS = 800
MOUTH_VAD_REMOVE_FILLER_WORDS = True
MOUTH_EOU_THRESHOLD_LEVEL = "medium"
# CASCADED sessions keep the value they have always shipped with. Nothing about the chat-model path
# changes: same detector, same timeout, same segmentation.
MOUTH_EOU_TIMEOUT_MS = 1500
# REALTIME (speech-to-speech) sessions use the audio-based detector, and 1000 ms is the measured
# value, not a round number (model-support §4.8, spec-voice-live-eou-unification.md §4). The audio
# detector at 1500 ms ends a turn ~0.45-0.6 s later than the text one; at 1000 ms it is level
# (English last-stop 7.68 s vs 7.57 s, Chinese 8.96 s vs 8.98 s). At 700 ms the behaviour CHANGES
# rather than speeds up — it stopped splitting at a 1.2 s pause and merged the answer into one
# segment ending at 9.08 s, unexplained. Re-run scripts/voice_live_eou_ab.py before touching it.
MOUTH_EOU_AUDIO_TIMEOUT_MS = 1000


def build_turn_detection(
    *, linear_turns: bool, mouth: bool, eou_detection: bool, realtime_pipeline: bool = False
) -> Any:
    """The ``turn_detection`` block of the Voice Live session.

    Two shapes, decided by WHO owns the turn:

    * Agent sessions (bank model-turn, editor Playground) keep the plain ``azure_semantic_vad`` they
      always had — the Foundry agent's own turn contract is tuned around it.
    * MOUTH sessions (external, linear/judged bank) get ``azure_semantic_vad_multilingual`` with
      end-of-utterance detection (``smart_end_of_turn_detection``, medium threshold, 1 s timeout),
      an 800 ms silence window and filler-word removal — unless the persona turned
      ``eou_detection`` off, in which case they keep the plain VAD.

    ``realtime_pipeline`` picks WHICH end-of-utterance detector, and it is not a preference — it
    decides whether the session can exist at all. Voice Live ships two:
    ``semantic_detection_v1_multilingual`` reads the recognised TEXT, and
    ``smart_end_of_turn_detection`` works on the input AUDIO.

    * ``False`` (cascaded — a chat model) keeps the **text** detector at 1500 ms: exactly what this
      product has always shipped, so the chat path is untouched by realtime support.
    * ``True`` (speech-to-speech) must use the **audio** detector, because passthrough has no Voice
      Live speech recognizer and the text one is refused outright: *"Text-based end-of-utterance
      detection requires a local speech recognizer and is only supported on cascaded pipelines"*
      (``param: session.turn_detection.end_of_utterance_detection``). That single line was the only
      thing keeping realtime voice models out.

    The audio detector is accepted on every pipeline measured, and an A/B on real audio found the
    segmentation identical to the text one (same segment count, same split point, byte-identical
    transcript) in English and Chinese alike — so switching a realtime session to it costs nothing
    behaviourally. It is NOT applied to cascaded sessions anyway: keeping the shipped path
    unchanged bit-for-bit is worth more than one fewer branch. Evidence:
    ``docs/voice-live-model-support.md`` §4.7-§4.8, reproducible via
    ``scripts/voice_live_eou_ab.py``. Who counts as realtime is measured too, not pattern-matched —
    see ``voice_live_probe.uses_realtime_pipeline`` (``phi4-mm-realtime`` is cascaded despite its
    name).

    ``create_response`` is always ``not linear_turns`` (the linear-turns contract; mouth ⇒ False)
    and barge-in is always on. Pure shaping (SDK import inside so the module stays importable
    without the azure extra); guarded by test_voice_live_proxy.py.
    """
    from azure.ai.voicelive.models import (
        AzureSemanticDetectionMultilingual,
        AzureSemanticVad,
        AzureSemanticVadMultilingual,
        SmartEndOfTurnDetection,
    )

    if mouth and eou_detection:
        return AzureSemanticVadMultilingual(
            silence_duration_ms=MOUTH_VAD_SILENCE_MS,
            remove_filler_words=MOUTH_VAD_REMOVE_FILLER_WORDS,
            end_of_utterance_detection=(
                SmartEndOfTurnDetection(
                    threshold_level=MOUTH_EOU_THRESHOLD_LEVEL,
                    timeout_ms=MOUTH_EOU_AUDIO_TIMEOUT_MS,
                )
                if realtime_pipeline
                else AzureSemanticDetectionMultilingual(
                    threshold_level=MOUTH_EOU_THRESHOLD_LEVEL,
                    timeout_ms=MOUTH_EOU_TIMEOUT_MS,
                )
            ),
            create_response=not linear_turns,
            interrupt_response=True,
        )
    return AzureSemanticVad(
        type="azure_semantic_vad",
        create_response=not linear_turns,
        interrupt_response=True,
    )


def build_avatar_session(
    persona: InterviewerPersona,
    *,
    locale: str | None,
    playground: bool = False,
    background: str | None = None,
    realtime_pipeline: bool = False,
) -> Any:
    """Build the Azure SDK ``RequestSession`` for a persona's avatar/voice Voice Live session.

    Pure shaping, no network: this only constructs SDK model objects from the persona's fields, so
    it's unit-testable without any Azure call (assert on the resulting object's ``.modalities``,
    ``.avatar``, ``.voice``, etc. — the SDK models are ``MutableMapping``s that also support
    attribute access). The SDK import lives INSIDE the function so importing this module never
    hard-fails when the ``azure-ai-voicelive`` extra is absent from some tooling environment (e.g.
    a lint-only venv) — mirrors the reference's import-inside-try pattern.

    Modalities include AVATAR only when the persona has a ``character`` configured (an avatar-less
    persona is TEXT+AUDIO only).
    """
    from azure.ai.voicelive.models import (
        AudioEchoCancellation,
        AudioInputTranscriptionOptions,
        AudioNoiseReduction,
        AvatarConfig,
        AzureStandardVoice,
        InterimResponseTrigger,
        LlmInterimResponseConfig,
        Modality,
        RequestSession,
        VideoParams,
    )

    resolved_locale, voice_name = resolve_voice(persona.voice_map, locale)

    has_avatar = bool((persona.character or "").strip())
    modalities = [Modality.TEXT, Modality.AUDIO]
    if has_avatar:
        modalities.append(Modality.AVATAR)

    # LINEAR TURNS (backend half). ``create_response`` decides whether Azure's server-VAD opens a
    # MODEL turn every time the candidate stops speaking. Under linear turns it must NOT: the model
    # would improvise its own turn (a "Thank you." per PAUSE — not per answer — or an off-script
    # follow-up), which duplicates/competes with the verbatim question read (two Azure responses →
    # two Interviewer bubbles) and, for external sessions, diverges from the external-brain-driven
    # question header. VAD still detects end-of-utterance and transcribes in both modes — only the
    # auto-REPLY is suppressed — so candidate-answer capture is unaffected; the interview advances
    # via the "I'm done" / commitAnswer path + the backend's next question.
    #
    # Who is linear (see linear_turns_for_persona): every candidate-facing session. EXTERNAL
    # personas supply no brain, and both BANK modes (``linear`` / ``judged``) read the backend's
    # text verbatim — the judge nudges off-WebSocket, never through a model turn. Only the editor
    # Playground (``playground=True``) keeps a model turn, to converse with a bank persona's synced
    # agent.
    #
    # History: v0.38.1.1 closed this as "engine decides, no knob" because ``create_response`` is a
    # SINGLE boolean (the acknowledgment turn and the follow-up turn are the same turn —
    # "acknowledge but never follow up" is unreachable) and agent mode rejects overriding
    # ``instructions`` inside ``response.create``. Both facts still hold; what changed (owner,
    # 2026-09-24) is that the model turn said "Thank you." on every pause, so it was retired
    # (v0.39.0.0) and every bank session is now the silent linear contract. The frontend half is
    # `linearTurns` in useInterviewVoice (suppresses the turn-advancing bare ``response.create``);
    # both halves must agree, since either alone still leaves the model a way to speak — the page
    # derives it from the same persona field via ``voice_linear_turns``. Guarded by
    # test_voice_live_proxy.py (bank ⇒ linear/False, external ⇒ False, playground bank ⇒ True).
    linear_turns = linear_turns_for_persona(persona, playground=playground)
    # Hoisted above the avatar guard below: ``input_audio_sampling_rate`` is a TOP-LEVEL session
    # field and applies to avatar-less personas too, so it cannot read settings from inside the
    # ``if has_avatar`` block.
    settings = get_settings()
    session_kwargs: dict[str, Any] = {
        "modalities": modalities,
        # The persona's two speech knobs ride the session voice: ``temperature`` (expressiveness of
        # HD voices, 0–1) and ``rate`` (speaking speed "0.5"–"1.5", stringified per the Voice Live
        # schema). They were only ever wired into the legacy ``/calls`` metadata builder, so on this
        # proxy path — the one production uses — the editor's "Voice temperature" / "Playback speed"
        # did nothing (found 2026-09-30). Prompt text cannot reach these; only session.voice can.
        # Duck-typed like ``eou_detection`` above (the pure builder is unit-tested with a stand-in).
        # Clamped to Azure's documented bounds (temperature 0–1, rate 0.5–1.5): the admin API now
        # refuses out-of-range values, but rows saved before that (the editor used to allow up to 2)
        # must not make Azure reject session.update and mute the persona.
        "voice": AzureStandardVoice(
            name=voice_name,
            type="azure-standard",
            temperature=min(1.0, max(0.0, float(getattr(persona, "voice_temperature", 0.8)))),
            rate=str(min(1.5, max(0.5, float(getattr(persona, "playback_speed", 1.0))))),
        ),
        # Server VAD detects when the user stops speaking (AI Foundry portal parity). Whether it
        # also AUTO-generates the model's reply is the linear-turns decision above (model-turn bank
        # personas: True; linear bank + all external: False). The user can always barge in to cut
        # the agent off mid-answer (interrupt_response=True). Set EXPLICITLY rather than relying on
        # Azure's defaults so behavior can't silently regress. MOUTH sessions additionally get the
        # multilingual VAD + end-of-utterance detection when the persona's ``eou_detection`` knob is
        # on (see build_turn_detection) — the segment boundaries the upcoming judge (issue #114)
        # will key off; agent sessions keep the plain VAD they always had.
        "turn_detection": build_turn_detection(
            linear_turns=linear_turns,
            mouth=is_mouth_persona(persona, playground=playground),
            eou_detection=bool(getattr(persona, "eou_detection", True)),
            # Speech-to-speech models cannot run the text detector; see build_turn_detection.
            realtime_pipeline=realtime_pipeline,
        ),
        "input_audio_transcription": AudioInputTranscriptionOptions(
            model="azure-speech", language=resolved_locale
        ),
        # Declares how Azure must interpret the raw PCM16 the browser uploads. Kept in lockstep
        # with the frontend's MIC_SAMPLE_RATE: a mismatch is not a quality regression but a total
        # failure (pitch/speed-shifted audio, garbage transcripts), so the value is echoed back
        # to the page in ``proxy.connected`` for a runtime drift check.
        # See Settings.voice_live_input_sampling_rate.
        "input_audio_sampling_rate": settings.voice_live_input_sampling_rate,
    }
    # The persona's two input-audio toggles. Both default on, and on is exactly what every session
    # sent before they were wired. Off omits the field: Voice Live treats both as opt-in, and an
    # absent field comes back as ``null`` in the session.updated echo (measured 2026-10-06).
    if bool(getattr(persona, "noise_suppression", True)):
        session_kwargs["input_audio_noise_reduction"] = AudioNoiseReduction(
            type="azure_deep_noise_suppression"
        )
    if bool(getattr(persona, "echo_cancellation", True)):
        session_kwargs["input_audio_echo_cancellation"] = AudioEchoCancellation(
            type="server_echo_cancellation"
        )
    # What the interim line says is decided by Voice Live's own logic, not by this session's model.
    if interim_response_applies(
        persona, playground=playground, realtime_pipeline=realtime_pipeline
    ):
        session_kwargs["interim_response"] = LlmInterimResponseConfig(
            triggers=[InterimResponseTrigger.TOOL, InterimResponseTrigger.LATENCY],
            latency_threshold_ms=INTERIM_RESPONSE_LATENCY_MS,
        )
    if has_avatar:
        # build_avatar_config owns the PHOTO-vs-VIDEO split (issue #103): a photo avatar (adrian,
        # amara, …) MUST carry `type: photo-avatar` + `model: vasa-1` and NO style, or Azure
        # rejects the session (`avatar_verification_failed`) and the digital human never connects.
        # The SDK model is fed the wire-shape dict so this and the /calls + metadata builders can't
        # drift; `video` declares the codec so Azure actually starts the video pipeline. NOTE:
        # azure-ai-voicelive models are MutableMappings that accept ONE positional mapping of
        # wire-format keys ("type"/"model", not the Python attr `avatar_type`) — this is the
        # documented azure-core Model pattern, not a hack; don't "fix" it into kwargs.
        # Built with plain statements rather than nested conditional dict-spreads: the previous
        # one-liner buried "codec, optional bitrate, optional background" under three layers.
        video_params: dict[str, Any] = dict(VideoParams(codec="h264"))
        if settings.voice_live_avatar_video_bitrate:
            # Escape hatch only (see Settings.voice_live_avatar_video_bitrate): unset means
            # Azure's own default, and Azure already adapts its bitrate on its own.
            video_params["bitrate"] = settings.voice_live_avatar_video_bitrate
        if background:
            # 6-hex RGB from the page's ``avatar_bg``: Azure paints it behind the digital
            # human. The page sends the photo avatar's own thumbnail backdrop (the frontend
            # roster's PHOTO_BACKDROPS) so the live video matches the editor preview exactly —
            # Azure's live synthesis otherwise uses a different (grey) wall than the official
            # thumbnail (measured 2026-09-24).
            video_params["background"] = {"color": f"#{background.upper()}FF"}

        session_kwargs["avatar"] = AvatarConfig(
            build_avatar_config(
                persona.character,
                persona.style,
                video=video_params,
            )
        )

    return RequestSession(**session_kwargs)  # type: ignore[arg-type]


def applied_voice_mismatch(sent: Any, applied: Any) -> str:
    """Did Azure actually apply the voice we asked for? Returns a message, or "" when it matches.

    Why this exists, measured 2026-10-05: a session whose ``voice`` never took effect is **silent
    in the worst possible way**. On a cascaded pipeline Azure quietly fills in a TTS voice, so
    nothing looks wrong; on a speech-to-speech model the audio becomes the model's own
    (``openai/marin``), and then a ``pre_generated_assistant_message`` read — which exists precisely
    to have the SERVER speak exact text — has no TTS to run. Azure answers it with
    ``response.text.delta``, emits **no error frame at all**, and the picture keeps animating while
    nothing is said. The frontend watchdog then retries three times and gives up. Hours went into
    that silence (docs/voice-live-model-support.md §4.12); this check turns it into one log line.

    Compares only what the product sets and cares about — the voice TYPE and NAME. Everything else
    in the echo (nulls Azure fills in, field order) is noise.
    """

    def _pair(voice: Any) -> tuple[str, str]:
        if voice is None:
            return "", ""
        data = dict(voice) if hasattr(voice, "keys") else {}
        return str(data.get("type") or ""), str(data.get("name") or "")

    want_type, want_name = _pair(sent)
    got_type, got_name = _pair(applied)
    if not want_type and not want_name:
        return ""  # we asked for nothing, so nothing can be wrong
    if (want_type, want_name) == (got_type, got_name):
        return ""
    return (
        f"session.voice was NOT applied: sent {want_type or '?'}/{want_name or '?'}, "
        f"Azure applied {got_type or '(none)'}/{got_name or '(none)'} — a pre-generated read will "
        "not be synthesised on a speech-to-speech model, and Azure reports no error"
    )


async def _resolve_voice_live_credential(api_key: str) -> tuple[Any, bool]:  # pragma: no cover
    """Entra-first, API-key-fallback credential resolution (mirrors ``azure_auth`` elsewhere).

    Probes the cached async ``DefaultAzureCredential`` (:func:`get_azure_credential_cached`) with
    ``COGNITIVE_SERVICES_SCOPE``; falls back to ``AzureKeyCredential(api_key)``. Returns
    ``(credential, is_entra)``. Unlike the reference, the cached credential is process-lifetime and
    NOT closed by the caller when Entra is used (closing it would break the next WS connection).
    """
    credential = get_azure_credential_cached()
    if credential is not None:
        try:
            await credential.get_token(COGNITIVE_SERVICES_SCOPE)
            logger.info("Voice Live proxy credential: using Entra (DefaultAzureCredential)")
            return credential, True
        except Exception:
            logger.info("Voice Live proxy credential: Entra probe failed, falling back to API key")

    if api_key and api_key.strip():
        from azure.core.credentials import AzureKeyCredential

        return AzureKeyCredential(api_key), False

    raise RuntimeError(
        "No valid Voice Live credential available: Entra probe failed and no API key configured"
    )


def build_connect_kwargs(
    *,
    endpoint: str,
    credential: Any,
    api_version: str,
    ssl_ctx: Any,
    is_agent: bool,
    agent_name: str | None,
    agent_version: str,
    project: str,
    default_model: str,
    byom_profile: str = "",
) -> dict[str, Any]:
    """The exact ``connect()`` kwargs for one session (pure, so the three paths are unit-testable).

    Three mutually exclusive ways to attach a brain, and mixing them is what produces the errors
    this function exists to keep apart:

    * **agent (path ③)** — ``agent_name`` / ``agent_version`` / ``project_name``, no ``model``.
      Never carries a BYOM profile: the agent's own model lives on the Foundry side.
    * **native model (path ①)** — ``model=<a name Voice Live hosts natively in the region>``.
    * **BYOM (path ②)** — the same ``model=`` slot holds YOUR deployment name and
      ``query={"profile": ...}`` tells Voice Live which upstream protocol to drive it with. The SDK
      maps ``query`` straight onto the WebSocket URL.

    A non-empty ``byom_profile`` is only honoured on the model path; see
    ``voice_live_ws.resolve_byom_profile`` for where the empty-vs-set decision is made.
    """
    kwargs: dict[str, Any] = {
        "endpoint": endpoint,
        "credential": credential,
        "api_version": api_version,
        "connection_options": {"vendor_options": {"ssl": ssl_ctx}},
    }
    if is_agent:
        kwargs["agent_name"] = agent_name
        kwargs["agent_version"] = agent_version
        kwargs["project_name"] = project
        return kwargs
    kwargs["model"] = default_model
    if byom_profile:
        kwargs["query"] = {"profile": byom_profile}
    return kwargs


async def run_proxy(
    ws: WebSocket,
    *,
    persona: InterviewerPersona,
    locale: str | None,
    endpoint: str,
    project: str,
    api_key: str,
    api_version: str,
    default_model: str,
    byom_profile: str = "",
    realtime_pipeline: bool = False,
    playground: bool = False,
    avatar_background: str | None = None,
) -> None:  # pragma: no cover — live Azure connect + relay, no Azure in CI
    """Hold the Azure Voice Live SDK connection and relay browser <-> Azure.

    Agent mode (``persona.agent_id`` set) connects with ``agent_name``/``agent_version``/
    ``project_name`` so the hosted Foundry agent drives the session; ``agent_id`` is stored as
    ``"name:version"`` (see ``persona_service``) so any ``:version`` suffix is
    stripped for ``agent_name`` and passed separately as ``agent_version``. Model mode (no
    ``agent_id``) connects with ``model=default_model``, plus ``query={"profile": byom_profile}``
    when the operator pointed the voice session at their own deployment (BYOM, path ②) — see
    :func:`build_connect_kwargs`.

    Sends ``{"type": "proxy.connected", ...}`` once Azure has acknowledged the initial
    ``session.update``, then runs two race-cancelled relay loops until either side closes.
    """
    from azure.ai.voicelive.aio import ConnectionClosed, connect

    credential, _is_entra = await _resolve_voice_live_credential(api_key)

    # MOUTH personas (see is_mouth_persona: every external persona + every linear-turns bank
    # persona) connect in MODEL mode, never agent mode, even when they carry an agent_id. The
    # backend injects each turn's text for a verbatim read; a hosted Foundry agent attached here
    # would be a SECOND brain — external: it improvises its own questions/follow-ups whose audio
    # diverges from the external-workflow header (v0.37.1.9); linear bank: its instructions hijack
    # the read response into an acknowledgment so the question is never spoken (v0.38.3.1,
    # live-verified).
    is_mouth = is_mouth_persona(persona, playground=playground)
    is_agent = bool((persona.agent_id or "").strip()) and not is_mouth
    agent_name = (persona.agent_id or "").split(":", 1)[0] if is_agent else None

    # certifi CA-bundle SSL context (see _certifi_ssl_context) handed to the SDK's vendor_options
    # escape hatch, which maps straight to aiohttp ws_connect's ssl= kwarg. Built once, reused here.
    ssl_ctx = _certifi_ssl_context()

    connect_kwargs = build_connect_kwargs(
        endpoint=endpoint,
        credential=credential,
        api_version=api_version,
        ssl_ctx=ssl_ctx,
        is_agent=is_agent,
        agent_name=agent_name,
        agent_version=persona.agent_version or "",
        project=project,
        default_model=default_model,
        byom_profile=byom_profile,
    )

    try:
        async with connect(**connect_kwargs) as conn:
            session = build_avatar_session(
                persona,
                locale=locale,
                playground=playground,
                background=avatar_background,
                realtime_pipeline=realtime_pipeline,
            )
            await conn.session.update(session=session)

            # Pin the session language BEFORE any response can be generated (see
            # build_language_pin_item) — the raw client-event send is the same path
            # _forward_client_to_azure uses for browser frames.
            await conn.send(build_language_pin_item(locale))

            # Mouth mode (external, or linear-turns bank) = MODEL mode with no agent instructions:
            # inject the reader prompt as a session-scoped system item shaping the read (verbatim,
            # no improvising). Ordering: language pin first (session-wide), reader prompt second
            # (behavioral), both BEFORE any response. Bank MODEL-turn mode injects none — its
            # Foundry agent carries the instructions. The reader prompt is the persona's
            # ``external_reader_prompt`` (admin-editable) or the generated default — one reading
            # contract for every mouth session, whichever engine drives the questions.
            read_directive = ""
            if is_mouth:
                reader_prompt = (persona.external_reader_prompt or "").strip() or (
                    default_external_reader_prompt(persona.name)
                )
                await conn.send(build_reader_prompt_item(reader_prompt))
                # The same reader prompt as the read directive: non-empty on proxy.connected ⟺ MOUTH
                # mode for the frontend, which then reads each question/speech_text with
                # response.create + pre_generated_assistant_message (server-side TTS of the exact
                # text — see build_read_directive for why the template is no longer filled into
                # response.instructions). Agent mode omits it (Azure rejects instructions overrides
                # there; the frontend then rides the text as an assistant item, which only the
                # agent's own turn contract tolerates).
                read_directive = build_read_directive(reader_prompt)

            await ws.send_text(
                json.dumps(
                    {
                        "type": PROXY_CONNECTED_TYPE,
                        "mode": "agent" if is_agent else "model",
                        "agent_name": agent_name or "",
                        "model": "" if is_agent else default_model,
                        # Which brain-attach path this session really used — path ② is invisible
                        # otherwise, since BYOM reuses the same ``model=`` slot as native.
                        "byom_profile": "" if is_agent else byom_profile,
                        # Which pipeline the session was built for — the thing that decides which
                        # end-of-utterance detector went on the wire.
                        "realtime_pipeline": realtime_pipeline,
                        "avatar_enabled": bool((persona.character or "").strip()),
                        "persona_id": persona.id,
                        "read_directive": read_directive,
                        # Observability for the live E2E spec / console: the turn contract this
                        # session was built with (the page derives its own copy from the candidate
                        # API's ``voice_linear_turns``, not from here).
                        "linear_turns": linear_turns_for_persona(persona, playground=playground),
                        "turn_detection": dict(session["turn_detection"]).get("type", ""),
                        # Read back off the built session (like turn_detection above, unlike the
                        # re-derived avatar_enabled) so this can never disagree with what Azure was
                        # actually told. The page compares it with its own mic capture rate.
                        "input_audio_sampling_rate": session["input_audio_sampling_rate"],
                        # Capability flag, not a preference: a page that sees it sends mic audio as
                        # BINARY frames and lets this side do the base64 (see build_audio_append).
                        # It has to be negotiated rather than assumed because the frontend and the
                        # backend are separate container apps that roll out independently — a new
                        # page against a backend one revision behind would send binary frames that
                        # the old relay rejects, and the candidate's microphone would go silently
                        # dead. Absent ⟹ the page keeps using base64 JSON, which this side still
                        # accepts, so neither rollout order can break voice.
                        "binary_audio": True,
                    }
                )
            )

            await _relay(ws, conn, ConnectionClosed, session.get("voice"))
    except ConnectionClosed:
        logger.info("Voice Live proxy: Azure connection closed")
    except WebSocketDisconnect:
        logger.info("Voice Live proxy: client disconnected")


async def _relay(
    ws: WebSocket, conn: Any, connection_closed: type, sent_voice: Any = None
) -> None:  # pragma: no cover — live relay
    """Run the two forwarding loops; return as soon as either side ends."""
    tasks = [
        asyncio.create_task(_forward_client_to_azure(ws, conn, connection_closed)),
        asyncio.create_task(_forward_azure_to_client(conn, ws, connection_closed, sent_voice)),
    ]
    _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for task in pending:
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass


def build_audio_append(pcm: bytes) -> dict[str, str]:
    """Wrap raw PCM16 mic bytes into the Voice Live ``input_audio_buffer.append`` client event.

    This is the server half of the binary uplink (perf review P0-1). Azure's own protocol has no
    binary audio frame — ``audio`` is a base64 string — so base64 is unavoidable on the Azure hop.
    What IS avoidable is paying for it on the BROWSER hop as well: the page used to base64-encode
    every batch and wrap it in JSON itself, so the candidate's upstream carried base64's +1/3 plus
    a JSON envelope. Moving both to this side means the browser sends the 1280 raw bytes it already
    has and this function does the encoding, on a server with bandwidth to spare.

    Kept as a pure function (and unit-tested) because the relay around it cannot be: it needs a live
    Azure socket.
    """
    return {"type": AUDIO_APPEND_TYPE, "audio": base64.b64encode(pcm).decode("ascii")}


async def _forward_client_to_azure(
    ws: WebSocket, conn: Any, connection_closed: type
) -> None:  # pragma: no cover — live relay
    """Browser -> Azure: forward each client frame as a Voice Live client event.

    TEXT frames are Voice Live client events, forwarded verbatim. BINARY frames are raw PCM16 mic
    audio and are wrapped by :func:`build_audio_append` — see there for why the browser no longer
    does its own base64.

    Uses the raw ``receive()`` rather than ``receive_text()`` because the latter rejects a binary
    frame outright; the disconnect message it would have raised on is handled here instead.
    """
    try:
        while True:
            message = await ws.receive()
            if message.get("type") == "websocket.disconnect":
                break
            text = message.get("text")
            if text is not None:
                await conn.send(json.loads(text))
                continue
            data = message.get("bytes")
            if data:
                await conn.send(build_audio_append(data))
    except (WebSocketDisconnect, connection_closed):
        logger.debug("Voice Live proxy: client->Azure forwarding stopped")
    except Exception as exc:
        logger.warning("Voice Live proxy: client->Azure forwarding error: %s", exc)


async def _forward_azure_to_client(
    conn: Any,
    ws: WebSocket,
    connection_closed: type,
    sent_voice: Any = None,
) -> None:  # pragma: no cover — live relay
    """Azure -> browser: forward every server event (incl. avatar ICE/SDP) as JSON text.

    Also checks the first ``session.updated`` against the voice we asked for — see
    :func:`applied_voice_mismatch` for the silence that check exists to make audible.
    """
    checked_voice = False
    try:
        async for event in conn:
            event_dict = event.as_dict() if hasattr(event, "as_dict") else dict(event)
            if not checked_voice and str(event_dict.get("type", "")).endswith("session.updated"):
                checked_voice = True
                problem = applied_voice_mismatch(
                    sent_voice, (event_dict.get("session") or {}).get("voice")
                )
                if problem:
                    logger.warning("Voice Live proxy: %s", problem)
            await ws.send_text(json.dumps(event_dict))
    except connection_closed:
        logger.debug("Voice Live proxy: Azure->client forwarding stopped (Azure closed)")
    except WebSocketDisconnect:
        logger.debug("Voice Live proxy: Azure->client forwarding stopped (client closed)")
    except Exception as exc:
        logger.warning("Voice Live proxy: Azure->client forwarding error: %s", exc)
    finally:
        try:
            await ws.close(code=1000, reason="azure_stream_ended")
        except Exception:
            pass
