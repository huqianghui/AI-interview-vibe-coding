"""Real LLM adapter backed by Azure AI Foundry (SPEC F3/F4, Phase 5).

Scoring + checklist drafting talk to the ``LLMAdapter`` protocol via ``get_llm_adapter()``; the
mock is the CI/dev default. This adapter runs those same ``complete(prompt, json_mode)`` calls
against a real Foundry deployment so a scored report reflects an actual model judgment.

It uses the **Responses API** (the surviving real-Foundry text path from Phase 2.3), NOT the
chat-completions adapter Phase 2.0 removed — reusing ``foundry_client.build_project_client`` (the
shared Entra-first client) and ``project_endpoint``. JSON mode on the Responses API is
``text={"format": {"type": "json_object"}}`` (the chat-completions ``response_format`` kwarg does
not exist on ``responses.create`` in the installed SDK).

The SDK is synchronous; every SDK call is wrapped in ``asyncio.to_thread`` so it never blocks the
event loop. Registered as the ``azure`` LLM provider by the registry when a Foundry project
endpoint is configured, and flipped on by the config overlay (DB > .env > default).
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from typing import Any

from app.services.agents.base import LLMAdapter
from app.services.agents.foundry_client import build_project_client, project_endpoint

logger = logging.getLogger(__name__)


class LLMAdapterError(RuntimeError):
    """Raised when a Foundry LLM completion fails (never silently swallowed).

    Carries ``status_code`` and ``retryable`` because the message alone is not enough to decide
    whether trying again is worth anything. This used to flatten every SDK exception into a string,
    which left callers with no way to tell a 429 (wait and retry — it will probably work) from a 400
    (a malformed request — it will fail identically forever). Scoring now backs off on the first and
    gives up immediately on the second.
    """

    def __init__(
        self, message: str, *, status_code: int | None = None, retryable: bool = False
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.retryable = retryable


def _is_retryable(exc: Exception) -> tuple[int | None, bool]:
    """Classify an SDK exception into ``(status_code, retryable)``.

    Retryable: 429 (rate limited), 408 (request timeout), 409 (conflict) and any 5xx — transient
    server-side conditions. Also anything with NO status at all, which is the connection/timeout
    family (``APIConnectionError``, ``APITimeoutError``): the request may never have been served.

    Not retryable: every other 4xx. A bad model name, an unsupported parameter or a content-filter
    rejection fails exactly the same way on attempt two, so retrying only spends the candidate's
    time. The 400-level content filter is the one that matters in practice here — see
    `ai-interview-judged-turn-mode-spec`'s note on the jailbreak filter 400ing obvious injections.
    """
    status = getattr(exc, "status_code", None)
    if not isinstance(status, int):
        status = getattr(getattr(exc, "response", None), "status_code", None)
    if not isinstance(status, int):
        return None, True  # no HTTP status reached us: connection/timeout class
    return status, status in (408, 409, 429) or status >= 500


# Enough for the judge's JSON: a per-required-item quote check (a few short quotes), the verdict,
# a ≤ 120-char speech_text and a few-word reason, in en or zh.
FAST_MAX_OUTPUT_TOKENS = 320


def _is_reasoning_model(model: str) -> bool:
    """gpt-5 family / o-series expose ``reasoning.effort`` (and ``text.verbosity`` on gpt-5)."""
    m = (model or "").lower()
    return m.startswith("gpt-5") or m.startswith("o1") or m.startswith("o3") or m.startswith("o4")


def _build_completion_kwargs(
    model: str, prompt: str, json_mode: bool, *, fast: bool = False
) -> dict[str, Any]:
    """The exact Responses-API kwargs for a plain-model completion (pure, unit-tested).

    ``json_mode`` requests a JSON object via ``text.format`` — the Responses-API equivalent of
    chat-completions' ``response_format={"type": "json_object"}`` (which ``responses.create`` does
    not accept). No ``agent_reference`` — scoring is a plain-model judgment, not an agent turn.

    ``fast`` (issue #114 judge): latency-sensitive callers on a reasoning model turn reasoning
    OFF (``minimal`` effort — owner decision 2026-09-24: speed and brevity over the last bit of
    verdict precision), ask for low verbosity, and cap the output tokens (the judge returns a tiny
    JSON object; ``max_output_tokens`` stops a rambling completion from eating the pause budget).
    Live-measured on gpt-5-mini: default effort 7–10 s per call; ``low`` 2–5 s (median ≈3.5 s);
    ``minimal`` 2–3 s warm. Non-reasoning models ignore the reasoning knob.
    """
    kwargs: dict[str, Any] = {"model": model, "input": [{"role": "user", "content": prompt}]}
    text: dict[str, Any] = {}
    if json_mode:
        text["format"] = {"type": "json_object"}
    if fast:
        kwargs["max_output_tokens"] = FAST_MAX_OUTPUT_TOKENS
        if _is_reasoning_model(model):
            kwargs["reasoning"] = {"effort": "minimal"}
            if model.lower().startswith("gpt-5"):
                text["verbosity"] = "low"
    if text:
        kwargs["text"] = text
    return kwargs


class FoundryLLMAdapter(LLMAdapter):
    """Runs LLM completions against a real Foundry deployment via the Responses API."""

    name = "azure"

    def __init__(
        self, *, endpoint: str, project: str = "", api_key: str = "", model: str = "gpt-5-mini"
    ) -> None:
        # Project-scoped endpoint the SDK requires (bare account endpoint 404s), same as agent-sync.
        self._endpoint = project_endpoint(endpoint, project)
        self._api_key = api_key
        self._model = model
        # Built once, reused: the project client + its OpenAI client. Rebuilding per call re-probed
        # the credential every time (~1–2 s of a judge call's latency budget).
        self._openai_client: Any = None

    async def _openai(self) -> Any:  # pragma: no cover — live SDK
        if self._openai_client is None:
            # build_project_client is a synchronous SDK call (credential probe) — off the loop.
            client = await asyncio.to_thread(build_project_client, self._endpoint, self._api_key)
            self._openai_client = client.get_openai_client()
        return self._openai_client

    async def complete(  # pragma: no cover — the live SDK call needs a real Foundry endpoint
        self, prompt: str, *, json_mode: bool = False, fast: bool = False
    ) -> str:
        """Return a single completion string. Raises :class:`LLMAdapterError` on any failure."""
        kwargs = _build_completion_kwargs(self._model, prompt, json_mode, fast=fast)
        try:
            openai_client = await self._openai()
            response = await asyncio.to_thread(openai_client.responses.create, **kwargs)
        except Exception as exc:  # noqa: BLE001 — normalize any SDK error, never swallow
            status, retryable = _is_retryable(exc)
            logger.error(
                "FoundryLLMAdapter.complete failed (model=%s, status=%s, retryable=%s): %s",
                self._model,
                status,
                retryable,
                exc,
            )
            raise LLMAdapterError(
                f"Foundry LLM completion failed: {exc}", status_code=status, retryable=retryable
            ) from exc
        return response.output_text or ""

    async def stream(  # pragma: no cover — delegates to the live agent stream
        self, prompt: str
    ) -> AsyncIterator[str]:
        """Stream a plain-model response. Scoring never calls this; the protocol requires it."""
        from app.services.agent_chat_service import stream_model_response

        async for event in stream_model_response(prompt):
            if event.kind == "text" and event.text:
                yield event.text
