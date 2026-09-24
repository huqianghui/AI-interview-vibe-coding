"""Voice Live WebSocket proxy: backend holds the Azure SDK connection so avatar VIDEO works.

The candidate/editor browser opens a plain WebSocket to OUR backend (not directly to Azure). We
hold the ``azure-ai-voicelive`` SDK connection server-side and relay both directions. This is
DIFFERENT from :mod:`app.services.voice_broker` (SPEC F9's WebRTC broker, where the browser
connects straight to Azure and audio never transits the backend) — this module exists because
Azure only delivers ``avatar.ice_servers`` and the avatar SDP handshake (the browser's
``session.avatar.connect`` -> Azure's ``session.avatar.connecting`` with ``server_sdp``) over the
*same* connection that sent ``session.update``. A short-lived STS credential handed to the
browser for a brand-new WebRTC connection cannot reuse that avatar SDP context, so avatar video
needs the backend in the loop as a relay. Ported from the working reference implementation
(AI-avatar-vibe-coding's ``voice_live_websocket.py``), trimmed to this project's persona model.

Two pieces, split the same way as the rest of this codebase's Azure integrations:

- :func:`build_avatar_session` — pure session-shape builder (no Azure network), CI-tested.
- :func:`run_proxy` — the live relay loop. Coverage-omitted (``# pragma: no cover``): it needs a
  real Azure Voice Live connection and CI has none.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from app.models.persona import (
    InterviewerPersona,
    build_read_directive,
    default_external_reader_prompt,
)
from app.services.agents.voice_live_metadata import (
    INTERVIEW_STAGE_BACKGROUND_RGBA,
    build_avatar_config,
    resolve_voice,
)
from app.services.azure_auth import COGNITIVE_SERVICES_SCOPE, get_azure_credential_cached

logger = logging.getLogger(__name__)

PROXY_CONNECTED_TYPE = "proxy.connected"
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

    External personas: always linear (they supply no brain; see ``build_avatar_session``). Bank
    personas: the admin's ``bank_turn_mode`` (``"linear"`` default / ``"model"``), via
    :meth:`InterviewerPersona.linear_turns_for`. Duck-typed on purpose (the pure builder is
    unit-tested with a dataclass stand-in): a persona object without the field is treated as the
    default, linear. ``playground=True`` (editor Playground, pinned ``persona_id``) keeps the model
    turn for a BANK persona — that surface is a free conversation with the agent to test its
    instructions, not the candidate interview flow, so the linear contract would just mute it;
    external stays linear there too (it has no agent to converse with).
    """
    is_external = (getattr(persona, "interview_brain", "bank") or "bank") == "external"
    if is_external:
        return True
    if playground:
        return False
    method = getattr(persona, "linear_turns_for", None)
    if callable(method):
        return bool(method("bank"))
    return (getattr(persona, "bank_turn_mode", "linear") or "linear") != "model"


def is_mouth_persona(persona: InterviewerPersona, *, playground: bool = False) -> bool:
    """Whether this voice session is a pure "MOUTH": MODEL mode + reader prompt, no Foundry agent.

    A mouth only reads the text the backend hands it each turn (carried in ``response.instructions``
    via the read directive) and never generates a turn of its own. That is every EXTERNAL persona
    (the external workflow is the brain) AND every LINEAR-TURNS bank persona (v0.38.3.1): under
    linear turns the agent's brain has no turn left to use, and keeping the agent attached is
    actively harmful — live-verified 2026-09-24: with the question riding as an assistant item, the
    agent's own instructions ("acknowledge when the candidate finishes") won over the item and the
    response meant to read question 2 said "Thank you." instead, so the question was never spoken.
    MODEL mode + ``response.instructions`` is the delivery that reads verbatim (the external path,
    live-verified since v0.37.x). Bank MODEL-turn personas keep their agent (it owns the reaction
    between questions), as does the editor Playground for any bank persona (free conversation).
    """
    return linear_turns_for_persona(persona, playground=playground)


# Mouth-session VAD/EOU tuning (issue #114 PR-1). Constants, not admin knobs: the only per-persona
# switch is ``eou_detection`` (already on the model, previously honoured only by the /calls metadata
# builder). ``EOU_MODEL`` is shared with that builder so the two paths can't drift.
MOUTH_VAD_TYPE = "azure_semantic_vad_multilingual"
MOUTH_VAD_SILENCE_MS = 800
MOUTH_VAD_REMOVE_FILLER_WORDS = True
MOUTH_EOU_THRESHOLD_LEVEL = "medium"
MOUTH_EOU_TIMEOUT_MS = 1500


def build_turn_detection(*, linear_turns: bool, mouth: bool, eou_detection: bool) -> Any:
    """The ``turn_detection`` block of the Voice Live session.

    Two shapes, decided by WHO owns the turn:

    * Agent sessions (bank model-turn, editor Playground) keep the plain ``azure_semantic_vad`` they
      always had — the Foundry agent's own turn contract is tuned around it.
    * MOUTH sessions (external, linear/judged bank) get ``azure_semantic_vad_multilingual`` with
      end-of-utterance detection (``semantic_detection_v1_multilingual``, medium threshold, 1.5 s
      timeout), an 800 ms silence window and filler-word removal — cleaner, less fragmented segments
      for the transcript buffer and for the judge's silence trigger — unless the persona turned
      ``eou_detection`` off, in which case they keep the plain VAD.

    ``create_response`` is always ``not linear_turns`` (the linear-turns contract; mouth ⇒ False)
    and barge-in is always on. Pure shaping (SDK import inside so the module stays importable
    without the azure extra); guarded by test_voice_live_proxy.py.
    """
    from azure.ai.voicelive.models import (
        AzureSemanticDetectionMultilingual,
        AzureSemanticVad,
        AzureSemanticVadMultilingual,
    )

    if mouth and eou_detection:
        return AzureSemanticVadMultilingual(
            silence_duration_ms=MOUTH_VAD_SILENCE_MS,
            remove_filler_words=MOUTH_VAD_REMOVE_FILLER_WORDS,
            end_of_utterance_detection=AzureSemanticDetectionMultilingual(
                threshold_level=MOUTH_EOU_THRESHOLD_LEVEL,
                timeout_ms=MOUTH_EOU_TIMEOUT_MS,
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
    persona: InterviewerPersona, *, locale: str | None, playground: bool = False
) -> Any:
    """Build the Azure SDK ``RequestSession`` for a persona's avatar/voice Voice Live session.

    Pure shaping, no network: this only constructs SDK model objects from the persona's fields, so
    it's unit-testable without any Azure call (assert on the resulting object's ``.modalities``,
    ``.avatar``, ``.voice``, etc. — the SDK models are ``MutableMapping``s that also support
    attribute access). The SDK import lives INSIDE the function so importing this module never
    hard-fails when the ``azure-ai-voicelive`` extra is absent from some tooling environment (e.g.
    a lint-only venv) — mirrors the reference's import-inside-try pattern.

    Modalities include AVATAR only when the persona has a ``character`` configured (an avatar-less
    persona is TEXT+AUDIO only, matching :func:`app.services.voice_broker.create_voice_session`'s
    ``avatar_enabled`` gate).
    """
    from azure.ai.voicelive.models import (
        AudioEchoCancellation,
        AudioInputTranscriptionOptions,
        AudioNoiseReduction,
        AvatarConfig,
        AzureStandardVoice,
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
    # Who is linear (see linear_turns_for_persona): EXTERNAL personas always — they are purely the
    # external workflow's "mouth" and supply no brain. BANK personas follow the admin-set
    # ``bank_turn_mode`` — "linear" (default since v0.38.2.0) or "model" (the pre-v0.38.2.0
    # behaviour: the model keeps its turn and ``prompt_fragment`` governs what it says in it).
    #
    # History: v0.38.1.1 closed this as "engine decides, no knob" because ``create_response`` is a
    # SINGLE boolean (the acknowledgment turn and the follow-up turn are the same turn —
    # "acknowledge but never follow up" is unreachable) and agent mode rejects overriding
    # ``instructions`` inside
    # ``response.create``. Both facts still hold; what changed (owner, 2026-09-24) is the preferred
    # default: in practice the model turn produced a "Thank you." on every pause, so bank sessions
    # now default to the silent linear contract and the model turn is an explicit opt-in. The
    # frontend half is `linearTurns` in useInterviewVoice (suppresses the turn-advancing bare
    # ``response.create``); both halves must agree, since either alone still leaves the model a way
    # to speak — the page derives it from the same persona field via ``voice_linear_turns``.
    # Guarded by test_voice_live_proxy.py (bank linear ⇒ False, bank model ⇒ True, external ⇒
    # False).
    linear_turns = linear_turns_for_persona(persona, playground=playground)
    session_kwargs: dict[str, Any] = {
        "modalities": modalities,
        "voice": AzureStandardVoice(name=voice_name, type="azure-standard"),
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
        ),
        "input_audio_transcription": AudioInputTranscriptionOptions(
            model="azure-speech", language=resolved_locale
        ),
        "input_audio_noise_reduction": AudioNoiseReduction(type="azure_deep_noise_suppression"),
        "input_audio_echo_cancellation": AudioEchoCancellation(type="server_echo_cancellation"),
    }
    if has_avatar:
        # build_avatar_config owns the PHOTO-vs-VIDEO split (issue #103): a photo avatar (adrian,
        # amara, …) MUST carry `type: photo-avatar` + `model: vasa-1` and NO style, or Azure
        # rejects the session (`avatar_verification_failed`) and the digital human never connects.
        # The SDK model is fed the wire-shape dict so this and the /calls + metadata builders can't
        # drift; `video` declares the codec so Azure actually starts the video pipeline. NOTE:
        # azure-ai-voicelive models are MutableMappings that accept ONE positional mapping of
        # wire-format keys ("type"/"model", not the Python attr `avatar_type`) — this is the
        # documented azure-core Model pattern, not a hack; don't "fix" it into kwargs.
        session_kwargs["avatar"] = AvatarConfig(
            build_avatar_config(
                persona.character,
                persona.style,
                # Interview sessions: Azure paints the avatar's background in the stage colour so
                # the frame edge is invisible on the page (issue1 follow-up, 2026-09-24). The editor
                # Playground keeps the avatar's natural backdrop on its light stage.
                video={
                    **dict(VideoParams(codec="h264")),
                    **(
                        {}
                        if playground
                        else {"background": {"color": INTERVIEW_STAGE_BACKGROUND_RGBA}}
                    ),
                },
            )
        )

    return RequestSession(**session_kwargs)  # type: ignore[arg-type]


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
    playground: bool = False,
) -> None:  # pragma: no cover — live Azure connect + relay, no Azure in CI
    """Hold the Azure Voice Live SDK connection and relay browser <-> Azure.

    Agent mode (``persona.agent_id`` set) connects with ``agent_name``/``agent_version``/
    ``project_name`` so the hosted Foundry agent drives the session; ``agent_id`` is stored as
    ``"name:version"`` (see :mod:`app.services.voice_broker`) so any ``:version`` suffix is
    stripped for ``agent_name`` and passed separately as ``agent_version``. Model mode (no
    ``agent_id``) connects with ``model=default_model``.

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

    connect_kwargs: dict[str, Any] = {
        "endpoint": endpoint,
        "credential": credential,
        "api_version": api_version,
        "connection_options": {"vendor_options": {"ssl": ssl_ctx}},
    }
    if is_agent:
        connect_kwargs["agent_name"] = agent_name
        connect_kwargs["agent_version"] = persona.agent_version or ""
        connect_kwargs["project_name"] = project
    else:
        connect_kwargs["model"] = default_model

    try:
        async with connect(**connect_kwargs) as conn:
            session = build_avatar_session(persona, locale=locale, playground=playground)
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
                # The same reader prompt, as the per-turn read-directive template the frontend fills
                # with each question/speech_text and sends as response.instructions (the only
                # delivery that reads verbatim in MODEL mode — see build_read_directive). Agent mode
                # omits it (Azure rejects instructions overrides there; the frontend then rides the
                # text as an assistant item, which only the agent's own turn contract tolerates).
                read_directive = build_read_directive(reader_prompt)

            await ws.send_text(
                json.dumps(
                    {
                        "type": PROXY_CONNECTED_TYPE,
                        "mode": "agent" if is_agent else "model",
                        "agent_name": agent_name or "",
                        "model": "" if is_agent else default_model,
                        "avatar_enabled": bool((persona.character or "").strip()),
                        "persona_id": persona.id,
                        "read_directive": read_directive,
                        # Observability for the live E2E spec / console: the turn contract this
                        # session was built with (the page derives its own copy from the candidate
                        # API's ``voice_linear_turns``, not from here).
                        "linear_turns": linear_turns_for_persona(persona, playground=playground),
                        "turn_detection": dict(session["turn_detection"]).get("type", ""),
                    }
                )
            )

            await _relay(ws, conn, ConnectionClosed)
    except ConnectionClosed:
        logger.info("Voice Live proxy: Azure connection closed")
    except WebSocketDisconnect:
        logger.info("Voice Live proxy: client disconnected")


async def _relay(
    ws: WebSocket, conn: Any, connection_closed: type
) -> None:  # pragma: no cover — live relay
    """Run the two forwarding loops; return as soon as either side ends."""
    tasks = [
        asyncio.create_task(_forward_client_to_azure(ws, conn, connection_closed)),
        asyncio.create_task(_forward_azure_to_client(conn, ws, connection_closed)),
    ]
    _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for task in pending:
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass


async def _forward_client_to_azure(
    ws: WebSocket, conn: Any, connection_closed: type
) -> None:  # pragma: no cover — live relay
    """Browser -> Azure: parse each client frame and forward it as a Voice Live client event."""
    try:
        while True:
            message = await ws.receive_text()
            parsed = json.loads(message)
            await conn.send(parsed)
    except (WebSocketDisconnect, connection_closed):
        logger.debug("Voice Live proxy: client->Azure forwarding stopped")
    except Exception as exc:
        logger.warning("Voice Live proxy: client->Azure forwarding error: %s", exc)


async def _forward_azure_to_client(
    conn: Any, ws: WebSocket, connection_closed: type
) -> None:  # pragma: no cover — live relay
    """Azure -> browser: forward every server event (incl. avatar ICE/SDP) as JSON text."""
    try:
        async for event in conn:
            event_dict = event.as_dict() if hasattr(event, "as_dict") else dict(event)
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
