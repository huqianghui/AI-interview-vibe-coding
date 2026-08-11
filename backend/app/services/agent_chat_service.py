"""Agent chat via the AI Foundry Responses API (SPEC F5/F10, Phase 2.3).

Sends a message to the interviewer's hosted **Prompt Agent** and returns (or streams) its
response, using the OpenAI-compatible client from ``azure-ai-projects``
(``project_client.get_openai_client().responses.create(...)`` with an ``agent_reference``). Chat
sessions show up in the Azure Portal agent playground under the agent's session list. This is the
text/decision channel that complements the Voice Live audio path — the interview state machine
uses it to drive the agent (ask a question, judge an answer, decide follow-up vs next).

Ported from the reference ``agent_chat_service``, rebuilt on this project's seams
(:mod:`app.services.agents.foundry_client` for the Entra-first client; settings for the runtime
config) and **without** the reference's ``personalization_context`` (HCP-training personalization,
not part of the interviewer flow). Two modes:

- **Agent mode** (``agent_name`` given): grounded — carries an ``agent_reference`` so the hosted
  Prompt Agent's own instructions + knowledge apply.
- **Plain-model mode** (``agent_name=None``): ungrounded fallback when no Foundry agent is
  configured — same client + deployment, no ``agent_reference``.

The SDK is synchronous; the streaming path runs it in a thread and bridges to an async queue so
it never blocks the event loop.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Literal

logger = logging.getLogger(__name__)


class AgentChatError(RuntimeError):
    """Foundry Agent request failed or returned an invalid stream."""


@dataclass(frozen=True)
class AgentResponseEvent:
    """One ordered event from a Foundry Responses stream."""

    kind: Literal["text", "completed"]
    text: str = ""
    response_id: str | None = None


def _validate_agent_reference(agent_name: str, agent_version: str) -> tuple[str, str]:
    """Validate an exact hosted Prompt Agent reference without substituting values.

    A blank name/version, or an ``asst_``-prefixed classic-assistant id, is rejected — the agent
    paths must fail fast rather than silently degrade to an ungrounded response.
    """
    name = agent_name.strip() if agent_name else ""
    version = agent_version.strip() if agent_version else ""
    if not name:
        raise AgentChatError("Agent name is required")
    if name.lower().startswith("asst_"):
        raise AgentChatError("Agent name must reference a hosted Prompt Agent")
    if not version:
        raise AgentChatError("Agent version is required")
    return name, version


def _foundry_runtime_config() -> tuple[str, str, str, str]:
    """Resolve ``(endpoint, project, api_key, model)`` for the Responses call from settings.

    The single place agent-chat reads its Foundry runtime config. Phase 2.4 (DB config
    management) layers a saved master config on top by extending this resolver — the chat logic
    below never has to change. ``model`` must name a real deployment on the project.
    """
    from app.config import get_settings

    settings = get_settings()
    return (
        settings.foundry_project_endpoint or settings.azure_foundry_endpoint,
        settings.azure_foundry_default_project,
        settings.foundry_api_key or settings.azure_foundry_api_key,
        settings.foundry_agent_model,
    )


def _build_openai_request(
    agent_name: str | None,
    agent_version: str | None,
    message: str,
    previous_response_id: str | None,
) -> tuple[Any, dict, str]:
    """Resolve the OpenAI-compatible client and construct exact Responses kwargs.

    With ``agent_name=None`` the request carries no ``agent_reference`` (plain-model mode). A
    non-None but blank/invalid reference fails fast *before* any client construction.
    """
    from app.services.agents.foundry_client import build_project_client, project_endpoint

    use_agent = agent_name is not None
    name = version = ""
    if use_agent:
        name, version = _validate_agent_reference(agent_name or "", agent_version or "")

    endpoint, project, api_key, model = _foundry_runtime_config()
    client = build_project_client(project_endpoint(endpoint, project), api_key)

    kwargs: dict = {"model": model, "input": [{"role": "user", "content": message}]}
    if use_agent:
        kwargs["extra_body"] = {
            "agent_reference": {"name": name, "version": version, "type": "agent_reference"}
        }
    if previous_response_id:
        kwargs["previous_response_id"] = previous_response_id
    return client.get_openai_client(), kwargs, endpoint


async def chat_with_agent(  # pragma: no cover — needs a live Foundry project
    agent_name: str,
    agent_version: str,
    message: str,
    previous_response_id: str | None = None,
) -> dict:
    """Send one message to a hosted Prompt Agent and return its response.

    Returns ``{response_text, response_id, agent_name, agent_version}``. ``response_id`` threads
    multi-turn conversations via ``previous_response_id``.
    """
    openai_client, kwargs, endpoint = await asyncio.to_thread(
        _build_openai_request, agent_name, agent_version, message, previous_response_id
    )
    logger.info(
        "chat_with_agent: endpoint=%s, agent=%s, version=%s, model=%s",
        endpoint,
        agent_name,
        agent_version,
        kwargs["model"],
    )
    try:
        response = await asyncio.to_thread(openai_client.responses.create, **kwargs)
    except Exception as e:
        logger.error("chat_with_agent failed: agent=%s, error=%s", agent_name, e)
        raise AgentChatError(f"Agent chat failed: {e}") from e

    return {
        "response_text": response.output_text,
        "response_id": response.id,
        "agent_name": agent_name,
        "agent_version": agent_version,
    }


async def stream_model_response(  # pragma: no cover — delegates to the live agent stream
    message: str,
    previous_response_id: str | None = None,
) -> AsyncIterator[AgentResponseEvent]:
    """Stream a plain-model (ungrounded) response — same client + deployment as agent mode but
    without an ``agent_reference``. Used when no Foundry agent is configured (Foundry IQ optional).
    """
    async for event in stream_agent_response(None, None, message, previous_response_id):
        yield event


async def stream_agent_response(  # pragma: no cover — needs a live Foundry project
    agent_name: str | None,
    agent_version: str | None,
    message: str,
    previous_response_id: str | None = None,
) -> AsyncIterator[AgentResponseEvent]:
    """Stream a hosted Prompt Agent response without blocking the event loop.

    With ``agent_name=None`` streams a plain-model (ungrounded) response instead. Emits ordered
    ``text`` deltas then a terminal ``completed`` event carrying the ``response_id`` for the next
    turn; raises :class:`AgentChatError` if the stream ends without completion.
    """
    openai_client, kwargs, _ = await asyncio.to_thread(
        _build_openai_request, agent_name, agent_version, message, previous_response_id
    )
    kwargs["stream"] = True
    queue: asyncio.Queue[AgentResponseEvent | BaseException | None] = asyncio.Queue()
    loop = asyncio.get_running_loop()
    stream_holder: list[Any] = []

    def produce() -> None:
        try:
            stream = openai_client.responses.create(**kwargs)
            stream_holder.append(stream)
            for event in stream:
                event_type = getattr(event, "type", "")
                if event_type == "response.output_text.delta":
                    loop.call_soon_threadsafe(
                        queue.put_nowait,
                        AgentResponseEvent(kind="text", text=getattr(event, "delta", "")),
                    )
                elif event_type == "response.completed":
                    response = getattr(event, "response", None)
                    response_id = getattr(response, "id", None)
                    if not response_id:
                        raise AgentChatError("Agent stream completed without a response ID")
                    loop.call_soon_threadsafe(
                        queue.put_nowait,
                        AgentResponseEvent(kind="completed", response_id=response_id),
                    )
        except BaseException as exc:
            failure = (
                exc
                if isinstance(exc, AgentChatError)
                else AgentChatError(f"Agent stream failed: {exc}")
            )
            loop.call_soon_threadsafe(queue.put_nowait, failure)
        finally:
            if stream_holder:
                close = getattr(stream_holder[0], "close", None)
                if callable(close):
                    close()
            loop.call_soon_threadsafe(queue.put_nowait, None)

    worker = asyncio.create_task(asyncio.to_thread(produce))
    completed = False
    try:
        while True:
            item = await queue.get()
            if item is None:
                break
            if isinstance(item, BaseException):
                raise item
            if item.kind == "completed":
                completed = True
            yield item
        await worker
        if not completed:
            raise AgentChatError("Agent stream ended without completion")
    finally:
        if not worker.done():
            if stream_holder:
                close = getattr(stream_holder[0], "close", None)
                if callable(close):
                    await asyncio.to_thread(close)
            worker.cancel()
