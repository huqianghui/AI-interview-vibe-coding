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
    """Raised when a Foundry LLM completion fails (never silently swallowed)."""


def _build_completion_kwargs(model: str, prompt: str, json_mode: bool) -> dict[str, Any]:
    """The exact Responses-API kwargs for a plain-model completion (pure, unit-tested).

    ``json_mode`` requests a JSON object via ``text.format`` — the Responses-API equivalent of
    chat-completions' ``response_format={"type": "json_object"}`` (which ``responses.create`` does
    not accept). No ``agent_reference`` — scoring is a plain-model judgment, not an agent turn.
    """
    kwargs: dict[str, Any] = {"model": model, "input": [{"role": "user", "content": prompt}]}
    if json_mode:
        kwargs["text"] = {"format": {"type": "json_object"}}
    return kwargs


class FoundryLLMAdapter(LLMAdapter):
    """Runs LLM completions against a real Foundry deployment via the Responses API."""

    name = "azure"

    def __init__(
        self, *, endpoint: str, project: str = "", api_key: str = "", model: str = "gpt-4o"
    ) -> None:
        # Project-scoped endpoint the SDK requires (bare account endpoint 404s), same as agent-sync.
        self._endpoint = project_endpoint(endpoint, project)
        self._api_key = api_key
        self._model = model

    async def complete(  # pragma: no cover — the live SDK call needs a real Foundry endpoint
        self, prompt: str, *, json_mode: bool = False
    ) -> str:
        """Return a single completion string. Raises :class:`LLMAdapterError` on any failure."""
        kwargs = _build_completion_kwargs(self._model, prompt, json_mode)
        try:
            # build_project_client + responses.create are synchronous SDK calls — off the loop.
            client = await asyncio.to_thread(build_project_client, self._endpoint, self._api_key)
            openai_client = client.get_openai_client()
            response = await asyncio.to_thread(openai_client.responses.create, **kwargs)
        except Exception as exc:  # noqa: BLE001 — normalize any SDK error, never swallow
            logger.error("FoundryLLMAdapter.complete failed (model=%s): %s", self._model, exc)
            raise LLMAdapterError(f"Foundry LLM completion failed: {exc}") from exc
        return response.output_text or ""

    async def stream(  # pragma: no cover — delegates to the live agent stream
        self, prompt: str
    ) -> AsyncIterator[str]:
        """Stream a plain-model response. Scoring never calls this; the protocol requires it."""
        from app.services.agent_chat_service import stream_model_response

        async for event in stream_model_response(prompt):
            if event.kind == "text" and event.text:
                yield event.text
