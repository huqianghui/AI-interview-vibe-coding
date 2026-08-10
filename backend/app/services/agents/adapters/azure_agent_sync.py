"""Foundry prompt-agent sync for interviewer personas (SPEC F5) — coverage-omitted.

Ported from the reference ``agent_sync_service``. Registers only when the ``azure`` extra +
a Foundry project endpoint are present; CI + local dev never import ``azure-ai-projects``.

Key contract facts (learned the hard way in the reference):

- Foundry agents are **immutable** — "update" means ``agents.create_version`` with a new version.
- **Creating a brand-new agent requires Entra ID** (``DefaultAzureCredential``). API-key auth
  returns HTTP 500 on create. So on a 500 we probe ``agents.get``: if the agent already exists
  (e.g. pre-created in the Portal) we fall back to an update; otherwise we surface a clear error
  telling the operator to pre-create it. API key is fine for read/update/delete of existing agents.
- The Voice Live metadata SHAPE is owned by the pure, CI-tested ``voice_live_metadata`` builder —
  this module only transports it. That split is why the demo-critical snake_case invariant is
  verified without a live Azure call (see docs/SPIKE-F1-foundry-iq.md Trigger C).

The SDK is synchronous; every call is wrapped in ``asyncio.to_thread`` so it never blocks the
event loop.
"""

import asyncio
import time
from typing import Any

from app.services.agents.foundry_client import (
    FoundryClientError,
    build_project_client,
    project_endpoint,
)
from app.services.agents.knowledge_tool import build_agent_tools
from app.services.agents.voice_live_metadata import build_voice_live_metadata

# Fallback only — the registry always passes settings.foundry_agent_model (which itself resolves
# DB > .env > code default). Kept as a neutral literal for the bare-constructor case.
_MODEL_ENV_DEFAULT = "gpt-4o"


class AgentSyncError(RuntimeError):
    """Raised when a persona cannot be synced to a Foundry prompt agent."""


class AzureAgentSyncAdapter:
    """Creates/updates the Foundry prompt agent backing an interviewer persona."""

    name = "azure"

    def __init__(
        self,
        *,
        endpoint: str,
        model: str = _MODEL_ENV_DEFAULT,
        api_key: str = "",
        project: str = "",
        search_endpoint: str = "",
        search_index: str = "",
        mcp_connection_id: str = "",
    ) -> None:
        # The SDK's AIProjectClient needs the PROJECT-scoped endpoint
        # (…/api/projects/{project}), not the bare Foundry account endpoint — the bare form 404s on
        # every agents call (caught live 2026-08-09). Build it from endpoint + project when a
        # project is given and the endpoint isn't already project-scoped.
        self._endpoint = project_endpoint(endpoint, project)
        self._model = model
        self._api_key = api_key
        # SOP knowledge-base binding via MCP (P15). Empty search config → no knowledge tool. The
        # MCP RemoteTool connection id authenticates the KB's MCP endpoint (ApiKey conn → 403).
        self._search_endpoint = search_endpoint
        self._search_index = search_index
        self._mcp_connection_id = mcp_connection_id

    # -- public API ---------------------------------------------------------

    async def sync_persona(self, persona: Any, *, locale: str | None = None) -> dict[str, str]:
        """Create or update the persona's agent; return ``{agent_id, agent_version}``.

        ``persona.name`` is the stable agent name (Foundry versions are ``name:version``); the
        instructions come from ``persona.prompt_fragment``; the voice config rides in metadata.
        """
        agent_name = self._agent_name(persona)
        instructions = persona.prompt_fragment or f"You are {persona.name}, an interviewer."
        metadata = build_voice_live_metadata(persona, locale=locale, modified_at=int(time.time()))
        tools = build_agent_tools(
            search_endpoint=self._search_endpoint,
            index_name=self._search_index,
            connection_id=self._mcp_connection_id or None,
        )

        client = self._project_client()
        try:
            result = await self._create_version(client, agent_name, instructions, metadata, tools)
        except Exception as exc:  # noqa: BLE001 — normalize any SDK error into a recovery attempt
            result = await self._recover_or_raise(
                client, agent_name, instructions, metadata, tools, exc
            )

        return {
            "agent_id": str(result.get("id") or agent_name),
            "agent_version": str(result.get("version") or ""),
        }

    async def delete_persona_agent(self, persona: Any) -> None:
        """Best-effort delete of the persona's Foundry agent (used when a persona is removed)."""
        client = self._project_client()
        await asyncio.to_thread(client.agents.delete, agent_name=self._agent_name(persona))

    # -- internals ----------------------------------------------------------

    def _agent_name(self, persona: Any) -> str:
        return f"interviewer-{persona.id}"

    def _to_mcp_tool(self, tool: dict[str, Any]) -> Any:
        """Convert the pure MCP tool dict (from knowledge_tool) into an SDK ``MCPTool`` object.

        RemoteTool connection (``project_connection_id``) authenticates the KB's MCP endpoint — a
        CognitiveSearch/ApiKey connection returns 403, per the reference's live findings.
        """
        from azure.ai.projects.models import MCPTool, MCPToolFilter

        return MCPTool(
            server_label=tool["server_label"],
            server_url=tool["server_url"],
            require_approval=tool.get("require_approval", "never"),
            allowed_tools=MCPToolFilter(tool_names=tool["allowed_tools"]["tool_names"]),
            project_connection_id=tool.get("project_connection_id"),
        )

    async def _create_version(
        self,
        client: Any,
        agent_name: str,
        instructions: str,
        metadata: dict[str, str],
        tools: list[dict[str, Any]],
    ) -> dict[str, Any]:
        from azure.ai.projects.models import PromptAgentDefinition

        # Attach the SOP knowledge base as an MCPTool when configured so the agent is grounded
        # (P15). The pure builder yields dicts; convert to SDK MCPTool objects here.
        definition_kwargs: dict[str, Any] = {"model": self._model, "instructions": instructions}
        sdk_tools = [self._to_mcp_tool(t) for t in tools]
        if sdk_tools:
            definition_kwargs["tools"] = sdk_tools
        created = await asyncio.to_thread(
            client.agents.create_version,
            agent_name=agent_name,
            definition=PromptAgentDefinition(**definition_kwargs),
            metadata=metadata,
        )
        return {
            "id": getattr(created, "id", agent_name),
            "version": getattr(created, "version", ""),
        }

    async def _recover_or_raise(
        self,
        client: Any,
        agent_name: str,
        instructions: str,
        metadata: dict[str, str],
        tools: list[dict[str, Any]],
        original: Exception,
    ) -> dict[str, Any]:
        """On a create failure, if the agent already exists, retry as an update; else raise.

        This mirrors the reference's 500-on-create handling: API-key auth cannot create a new
        agent, but can update one pre-created in the Portal.
        """
        try:
            existing = await asyncio.to_thread(client.agents.get, agent_name=agent_name)
        except Exception:  # noqa: BLE001 — agent genuinely absent → the original error stands
            existing = None
        if existing is None:
            raise AgentSyncError(
                f"Could not create agent {agent_name!r}: {original}. "
                "Creating a new agent requires Entra ID (DefaultAzureCredential); "
                "with API-key auth, pre-create the agent in the Foundry Portal first."
            ) from original
        # Agent exists — a new version (update) is allowed under API-key auth.
        return await self._create_version(client, agent_name, instructions, metadata, tools)

    def _project_client(self) -> Any:
        """Build the project-scoped ``AIProjectClient`` (Entra-first, API-key fallback).

        Delegates to the shared :mod:`foundry_client` builder so the credential decision lives in
        one place; normalizes its error into an :class:`AgentSyncError` for this adapter's callers.
        """
        try:
            return build_project_client(self._endpoint, self._api_key)
        except FoundryClientError as exc:
            raise AgentSyncError(str(exc)) from exc
