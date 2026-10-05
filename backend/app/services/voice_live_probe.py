"""Ask the real service which Voice Live models this resource's REGION accepts.

There is no Azure API that lists "the Voice Live models pre-deployed in region X", and the Learn
table runs ahead of regional rollout (measured: ``gpt-5.6-luna`` was REJECTED on 2026-09-23 and
ACCEPTED on 2026-10-05 on the same resource). So the only trustworthy source is a real connection:
open a session per candidate model, send the cheapest possible ``session.update``, and read the
first server event. ``session.updated`` means the region accepts it; an ``error`` names why.

This module is the shared implementation behind both the admin dropdown
(``GET /admin/config/ai-foundry/voice-live-models``) and ``scripts/voice_live_model_probe.py``.

**What a probe can and cannot prove** (all six behaviours measured 2026-10-05 against the
swedencentral resource, api-version ``2026-01-01-preview``, Entra auth —
see ``docs/voice-live-model-support.md`` §4.4):

* NATIVE mode: decisive. ``gpt-5.4-mini`` is a REAL deployment in the resource and native Voice Live
  still answers ``invalid_model`` / "not supported in this region".
* BYOM mode: the ``profile`` IS validated at connect (``invalid_profile``), and so is a protocol
  mismatch (a chat deployment under ``byom-azure-openai-realtime`` →
  ``byom_realtime_connection_error``). But the **deployment name is NOT validated**: a nonexistent
  name was ACCEPTED. So never claim a BYOM probe proves the deployment exists — that guarantee comes
  from listing the resource's real deployments instead.
"""

import asyncio
import json
import logging
import time
from typing import Any

logger = logging.getLogger(__name__)

# Verdicts. Only the REJECTED_* ones are definitive enough to block a save (see
# is_definitive_rejection): ERROR covers "we could not tell" (timeout, no credential, network).
ACCEPTED = "ACCEPTED"
REJECTED_REGION = "REJECTED_REGION"
REJECTED_PROFILE = "REJECTED_PROFILE"
REJECTED_BYOM = "REJECTED_BYOM"
REJECTED_NOT_FOUND = "REJECTED_NOT_FOUND"
# The service refused the SESSION CONFIGURATION itself — it named the offending field. Definitive by
# construction: a param-scoped validation error is deterministic, so retrying or saving anyway only
# moves the failure into every interview. Measured case: the production session under
# byom-azure-openai-realtime answers
#   param "session.turn_detection.end_of_utterance_detection", "Text-based end-of-utterance
#   detection requires a local speech recognizer and is only supported on cascaded pipelines."
# whose code is the GENERIC invalid_request_error — which is exactly why this is keyed off `param`
# rather than off a code or a phrase.
REJECTED_SESSION = "REJECTED_SESSION"
ERROR = "ERROR"

_DEFINITIVE_REJECTIONS = frozenset(
    {REJECTED_REGION, REJECTED_PROFILE, REJECTED_BYOM, REJECTED_NOT_FOUND, REJECTED_SESSION}
)

# Verbatim markers from real server payloads (docs/voice-live-model-support.md §4.4). Matching the
# error *code* rather than prose keeps this stable if Azure rewords a message.
_MARK_REGION = "not supported in this region"  # accompanies code "invalid_model"
_MARK_PROFILE = "invalid_profile"
_MARK_BYOM = "byom_realtime_connection_error"

# The models Learn's "Voice Live overview" lists as natively pre-deployed (2026-10-05). The last
# three are the ones the docs themselves call out as "supported and tested but NOT pre-deployed —
# use BYOM", so a native probe is EXPECTED to reject them; keeping them in the list is what makes
# the result self-checking.
NATIVE_MODEL_CANDIDATES: tuple[str, ...] = (
    "gpt-realtime-2.1",
    "gpt-realtime-2.1-mini",
    "gpt-realtime-1.5",
    "gpt-realtime",
    "gpt-realtime-mini",
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.4",
    "gpt-5.2",
    "gpt-5.1",
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",
    "phi4-mm-realtime",
    "azure-realtime",
    "gpt-5.5",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
)

# The three BYOM integration modes (docs/voice-live-model-support.md §3.2). The profile is the wire
# protocol Voice Live drives your deployment with; it is NOT inferable from the deployment name.
BYOM_PROFILES: tuple[str, ...] = (
    "byom-azure-openai-chat-completion",
    "byom-azure-openai-realtime",
    "byom-foundry-anthropic-messages",
)
DEFAULT_BYOM_PROFILE = "byom-azure-openai-chat-completion"

# Which NATIVE models run Voice Live's speech-to-speech pipeline rather than the cascaded one.
# It decides which end-of-utterance detector a session may ask for, so a wrong answer breaks
# sessions.
#
# MEASURED, not pattern-matched: a text-based EoU session is ACCEPTED by a cascaded model and
# REFUSED by a realtime one ("Text-based end-of-utterance detection requires a local speech
# recognizer and is only supported on cascaded pipelines"), so that refusal IS the classifier. Swept
# over NATIVE_MODEL_CANDIDATES on swedencentral 2026-10-05 with
# ``scripts/voice_live_session_probe.py``: 6 refused, 14 accepted.
#
# Why a name pattern would be WRONG: ``phi4-mm-realtime`` has "realtime" in its name and ACCEPTED
# the text detector — it is cascaded. Any `*realtime*` heuristic misclassifies it.
#
# A realtime model missing from this set gets the text detector and its save is refused with Azure's
# own message (the save-time check sends the production session shape), so the failure is visible at
# configuration time rather than silent in an interview. A cascaded model wrongly listed here just
# gets the audio detector, which is measured equivalent. Both failure directions are benign.
# Re-measure with: python scripts/voice_live_session_probe.py --matrix
REALTIME_NATIVE_MODELS = frozenset(
    {
        "gpt-realtime",
        "gpt-realtime-mini",
        "gpt-realtime-1.5",
        "gpt-realtime-2.1",
        "gpt-realtime-2.1-mini",
        "azure-realtime",
    }
)

# The BYOM profile that drives YOUR deployment over the realtime (speech-native) protocol. Unlike
# the native case this needs no list: the operator states it.
REALTIME_BYOM_PROFILE = "byom-azure-openai-realtime"


def uses_realtime_pipeline(model: str | None, byom_profile: str | None = "") -> bool:
    """Does this (model, profile) pair run the speech-to-speech pipeline?

    True ⇒ the session must use the AUDIO-based end-of-utterance detector; the text-based one is
    refused outright there. False ⇒ cascaded, which keeps the detector it has always used.

    In BYOM mode the PROFILE is the whole answer and the deployment name carries no signal —
    measured: our own ``gpt-realtime-2.1`` deployment under ``byom-azure-openai-chat-completion``
    ACCEPTS the text detector, i.e. that profile is cascaded no matter what sits behind it. Only in
    native mode does the name decide, against the measured set above.
    """
    profile = (byom_profile or "").strip().lower()
    if profile:
        return profile == REALTIME_BYOM_PROFILE
    return (model or "").strip().lower() in REALTIME_NATIVE_MODELS


DEFAULT_TIMEOUT_SECONDS = 8.0
# A voice-only session (no avatar) measured ~120 connections/min, so a handful at a time is well
# inside the limit; the 3-per-60s ceiling is an AVATAR-creation limit and does not apply here
# (memory ai-interview-avatar-quota-not-a-quota). 6 keeps a 23-model sweep near 10-35s.
DEFAULT_CONCURRENCY = 6

# Probed ACCEPTED lists, keyed by (endpoint, api_version). Module-global + time.time() comparison,
# matching azure_auth's credential cache rather than adding a cache dependency.
_native_cache: dict[tuple[str, str], tuple[float, list[str]]] = {}
_NATIVE_CACHE_TTL_SECONDS = 6 * 3600


def is_definitive_rejection(verdict: str) -> bool:
    """True when the service clearly refused, as opposed to "we could not tell".

    Callers gate a hard failure (a 422 on save) on this: a timeout or a missing credential must not
    stop an operator from saving, the way every other discovery path here fails soft.
    """
    return verdict in _DEFINITIVE_REJECTIONS


def _names_a_session_param(error: str) -> bool:
    """True when the payload blames a ``session.*`` field (or the session.update envelope).

    Keyed off the structured ``param``, not off wording: the measured refusal of a speech-native
    passthrough session carries the generic code ``invalid_request_error`` and only ``param`` says
    what is actually wrong. ``invalid_session_update_message`` (``param: "type"``) is the other
    shape seen live, hence the explicit code too.
    """
    try:
        payload = json.loads(error)
    except (TypeError, ValueError):
        return False
    inner = payload.get("error", payload) if isinstance(payload, dict) else {}
    if not isinstance(inner, dict):
        return False
    if str(inner.get("code", "")) == "invalid_session_update_message":
        return True
    return str(inner.get("param", "") or "").startswith("session.")


def classify_probe_result(first_event: dict[str, Any] | None, error: str | None) -> tuple[str, str]:
    """Map the first server event (or a connect-time exception) to ``(verdict, detail)``.

    Pure, so the whole taxonomy is unit-testable against the real payloads captured in §4.4.
    """
    if error is not None:
        low = error.lower()
        if _MARK_REGION in low:
            return REJECTED_REGION, error
        if _MARK_PROFILE in low:
            return REJECTED_PROFILE, error
        if _MARK_BYOM in low:
            return REJECTED_BYOM, error
        if "not found" in low or "does not exist" in low:
            return REJECTED_NOT_FOUND, error
        if _names_a_session_param(error):
            return REJECTED_SESSION, error
        return ERROR, error
    if first_event is None:
        return ERROR, "no server event before timeout"
    etype = str(first_event.get("type", ""))
    if etype.endswith("session.updated"):
        return ACCEPTED, etype
    if etype.endswith("error"):
        return classify_probe_result(None, json.dumps(first_event.get("error", first_event)))
    return ERROR, f"unexpected first event: {etype}"


async def probe_model(
    *,
    endpoint: str,
    credential: Any,
    api_version: str,
    model: str,
    byom_profile: str = "",
    session: Any = None,
    timeout_s: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Open one Voice Live session for ``model`` and classify the first server event.

    NATIVE mode with an empty ``byom_profile``; BYOM mode otherwise, where ``model`` is a deployment
    name in the Foundry resource and the profile rides as a query param (the SDK maps ``query``
    straight onto the WebSocket URL). Never raises: a connect-time rejection is classified too.

    ``session`` is what gets sent in the ``session.update``. Default: a minimal
    ``RequestSession(instructions="probe")``, which answers "does the region host this model" and is
    what the catalogue sweep wants. **Pass the production-shaped session when the question is "will
    the app's real sessions work"** — the two answers differ, measured: ``gpt-realtime-2.1`` under
    ``byom-azure-openai-realtime`` ACCEPTS the minimal session and REJECTS the real one with
    "Text-based end-of-utterance detection requires a local speech recognizer", because
    speech-native passthrough has no Voice Live recognizer to run text EOU or ``azure-speech``
    transcription on. A check that only sends the minimal session is a false green for that profile.
    """
    mode = "byom" if byom_profile else "native"
    started = time.monotonic()
    try:
        # Imports inside the try on purpose: without the azure extra installed this is an
        # ImportError, and a missing optional dependency must come back as an inconclusive verdict
        # (the admin route then saves with a note) rather than escape and 500 the save.
        from azure.ai.voicelive.aio import connect
        from azure.ai.voicelive.models import RequestSession

        # Same TLS trust store and same Entra-first credential order as the live proxy, so a probe
        # result actually represents what a real session would do.
        from app.services.voice_live_proxy import _certifi_ssl_context

        kwargs: dict[str, Any] = {
            "endpoint": endpoint,
            "credential": credential,
            "api_version": api_version,
            "model": model,
            "connection_options": {"vendor_options": {"ssl": _certifi_ssl_context()}},
        }
        if byom_profile:
            kwargs["query"] = {"profile": byom_profile}

        async with connect(**kwargs) as conn:
            # The cheapest "did Azure accept this?" signal: a good model answers session.updated, a
            # bad one answers error. No audio is ever sent.
            await conn.session.update(
                session=session if session is not None else RequestSession(instructions="probe")
            )
            first: dict[str, Any] | None = None
            try:
                async with asyncio.timeout(timeout_s):
                    async for event in conn:
                        first = event.as_dict() if hasattr(event, "as_dict") else dict(event)
                        etype = str(first.get("type", getattr(event, "type", "")))
                        if etype.endswith("session.updated") or etype.endswith("error"):
                            break
            except TimeoutError:
                first = None
            verdict, detail = classify_probe_result(first, None)
    except Exception as exc:  # noqa: BLE001 — a 4xx on the WS upgrade surfaces as an exception
        verdict, detail = classify_probe_result(None, str(exc))

    return {
        "model": model,
        "mode": mode,
        "profile": byom_profile,
        "verdict": verdict,
        "detail": detail,
        "elapsed_s": round(time.monotonic() - started, 2),
    }


async def probe_models(
    *,
    endpoint: str,
    credential: Any,
    api_version: str,
    models: tuple[str, ...] | list[str],
    timeout_s: float = DEFAULT_TIMEOUT_SECONDS,
    concurrency: int = DEFAULT_CONCURRENCY,
) -> list[dict[str, Any]]:
    """Probe many models in NATIVE mode with bounded concurrency, preserving input order."""
    sem = asyncio.Semaphore(max(1, concurrency))

    async def one(name: str) -> dict[str, Any]:
        async with sem:
            return await probe_model(
                endpoint=endpoint,
                credential=credential,
                api_version=api_version,
                model=name,
                timeout_s=timeout_s,
            )

    return list(await asyncio.gather(*(one(m) for m in models)))


async def list_native_models(
    *,
    endpoint: str,
    api_key: str,
    api_version: str,
    refresh: bool = False,
    timeout_s: float = DEFAULT_TIMEOUT_SECONDS,
    concurrency: int = DEFAULT_CONCURRENCY,
) -> list[str]:
    """The models this resource's region ACCEPTS in native mode, cached for 6h per endpoint.

    Returns them in catalogue order. Raises nothing of its own: credential problems propagate from
    the resolver so the caller can decide (the admin route fails soft and returns []).
    """
    key = (endpoint, api_version)
    now = time.time()
    if not refresh:
        hit = _native_cache.get(key)
        if hit is not None and (now - hit[0]) < _NATIVE_CACHE_TTL_SECONDS:
            return list(hit[1])

    from app.services.voice_live_proxy import _resolve_voice_live_credential

    credential, _is_entra = await _resolve_voice_live_credential(api_key)
    results = await probe_models(
        endpoint=endpoint,
        credential=credential,
        api_version=api_version,
        models=NATIVE_MODEL_CANDIDATES,
        timeout_s=timeout_s,
        concurrency=concurrency,
    )
    accepted = [r["model"] for r in results if r["verdict"] == ACCEPTED]
    rejected = [r["model"] for r in results if r["verdict"] == REJECTED_REGION]
    logger.info(
        "Voice Live native probe: %d accepted, %d region-rejected (%s)",
        len(accepted),
        len(rejected),
        endpoint,
    )
    _native_cache[key] = (now, accepted)
    return list(accepted)


def clear_native_cache() -> None:
    """Drop the probe cache (tests, and an explicit admin refresh)."""
    _native_cache.clear()
