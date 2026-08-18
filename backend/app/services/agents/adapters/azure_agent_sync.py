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
- Create can hit transient connection drops; those are retried with exponential backoff
  (:func:`_is_transient_error`, ported from the reference's create loop) before recovery/raise.

The SDK is synchronous; every call is wrapped in ``asyncio.to_thread`` so it never blocks the
event loop.

Reverse-read: :meth:`fetch_remote_state` pulls the live agent's latest version + model back so the
editor can reconcile Portal edits (a Portal edit bumps the version but doesn't sync to our DB). It's
read-only — it never creates a version. Full metadata reverse-sync stays deferred (#29).
"""

import asyncio
import time
from typing import Any

from app.models.persona import default_instructions
from app.services.agents import foundry_connections
from app.services.agents.foundry_client import (
    FoundryClientError,
    build_project_client,
    project_endpoint,
)
from app.services.agents.knowledge_tool import build_agent_tools, build_knowledge_mcp_tool
from app.services.agents.persona_tools import build_persona_tools
from app.services.agents.voice_live_metadata import build_voice_live_metadata

# Fallback only — the registry always passes settings.foundry_agent_model (which itself resolves
# DB > .env > code default). Kept as a neutral literal for the bare-constructor case.
_MODEL_ENV_DEFAULT = "gpt-4o"


class AgentSyncError(RuntimeError):
    """Raised when a persona cannot be synced to a Foundry prompt agent."""


# Create can hit transient connection drops against the Foundry endpoint; retry those a few times
# with exponential backoff before giving up (ported from the reference's create_agent retry loop).
_MAX_CREATE_ATTEMPTS = 3
_TRANSIENT_MARKERS = (
    "RemoteDisconnected",
    "Connection aborted",
    "ConnectionError",
    "ConnectionResetError",
)


def _is_transient_error(exc: BaseException) -> bool:
    """True when an SDK error looks like a transient connection drop worth retrying.

    Pure + unit-testable: classifies by the exception's string form (the SDK raises various
    connection error types), matching the reference's transient-marker set. A 500/auth error is
    NOT transient — those flow to the pre-created-agent recovery path instead.
    """
    text = str(exc)
    return any(marker in text for marker in _TRANSIENT_MARKERS)


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
    ) -> None:
        # The SDK's AIProjectClient needs the PROJECT-scoped endpoint
        # (…/api/projects/{project}), not the bare Foundry account endpoint — the bare form 404s on
        # every agents call (caught live 2026-08-09). Build it from endpoint + project when a
        # project is given and the endpoint isn't already project-scoped.
        self._endpoint = project_endpoint(endpoint, project)
        self._model = model
        self._api_key = api_key
        # Raw endpoint + project are kept for per-persona KB RemoteTool resolution (the SDK's
        # connections list/create needs the project-scoped client, built from these).
        self._raw_endpoint = endpoint
        self._project = project

    # -- public API ---------------------------------------------------------

    async def sync_persona(
        self,
        persona: Any,
        *,
        locale: str | None = None,
        knowledge_configs: list[dict] | None = None,
    ) -> dict[str, str]:
        """Create or update the persona's agent; return ``{agent_id, agent_version}``.

        ``persona.name`` is the stable agent name (Foundry versions are ``name:version``); the
        instructions come from ``persona.prompt_fragment``; the voice config rides in metadata.
        ``knowledge_configs`` are THIS persona's attached knowledge bases (each becomes an
        authenticated KB MCPTool) — the global KB binding was retired in favour of per-persona KBs.
        """
        agent_name = self._agent_name(persona)
        instructions = persona.prompt_fragment or default_instructions(persona.name)
        metadata = build_voice_live_metadata(persona, locale=locale, modified_at=int(time.time()))
        knowledge_tools = await self._resolve_kb_tools(knowledge_configs or [])
        tools = build_agent_tools(
            knowledge_tools=knowledge_tools,
            persona_tools=build_persona_tools(getattr(persona, "tools_config", None)),
        )

        # _project_client does a synchronous Entra probe (blocking network/az-CLI call), so build it
        # off the event loop like the SDK calls it wraps.
        client = await asyncio.to_thread(self._project_client)
        # Per-persona model wins over the global adapter default so a model set in the editor is
        # pushed to Foundry; empty/None falls back to self._model (settings.foundry_agent_model).
        model = getattr(persona, "model", None) or self._model
        result = await self._create_with_retry(
            client, agent_name, instructions, metadata, tools, model
        )
        return {
            "agent_id": str(result.get("id") or agent_name),
            "agent_version": str(result.get("version") or ""),
        }

    async def fetch_remote_state(self, persona: Any) -> dict[str, str] | None:
        """Read the live Foundry agent's latest version + model + instructions (pull direction).

        Returns ``{"agent_version": <str>, "model": <str>, "instructions": <str>}`` for the agent
        backing ``persona``, or ``None`` when the agent doesn't exist or the read fails —
        reconciliation is best-effort and must never 500. Walks
        ``AgentDetails.versions.latest.version`` then ``get_version(...).definition`` for the
        ``PromptAgentDefinition``'s ``model`` and ``instructions`` (both fields this app writes).
        """
        try:
            client = await asyncio.to_thread(self._project_client)
            name = self._agent_name(persona)
            details = await asyncio.to_thread(client.agents.get, agent_name=name)
            version = str(details.versions.latest.version)
            vdetails = await asyncio.to_thread(client.agents.get_version, name, version)
            model = getattr(vdetails.definition, "model", None)
            instructions = getattr(vdetails.definition, "instructions", None)
            return {
                "agent_version": version,
                "model": str(model) if model else "",
                "instructions": str(instructions) if instructions else "",
            }
        except Exception:  # noqa: BLE001 — any read failure → no reconcile, not an error
            return None

    async def _resolve_kb_tools(  # pragma: no cover — needs a live Foundry/Search resource
        self, knowledge_configs: list[dict]
    ) -> list[dict[str, Any]]:
        """Build one authenticated KB MCPTool per enabled config.

        For each enabled config, resolve (find-or-create) the RemoteTool project connection that
        authenticates the KB's MCP endpoint (a CognitiveSearch/ApiKey connection returns 403), then
        build the MCPTool dict. **Invariant (from the reference):** the built-tool count must equal
        the enabled-config count — a KB that can't bind to an authenticated connection must FAIL
        the sync, never silently drop, so a "synced" agent is never falsely reported as grounded.
        """
        enabled = [c for c in knowledge_configs if c.get("is_enabled", True)]
        tools: list[dict[str, Any]] = []
        for cfg in enabled:
            search_target = cfg.get("connection_target", "")
            index_name = cfg.get("index_name", "")
            connection_id = await foundry_connections.resolve_remote_tool_connection(
                endpoint=self._raw_endpoint,
                project=self._project,
                api_key=self._api_key,
                search_target=search_target,
                index_name=index_name,
            )
            # A KB MCPTool without a RemoteTool connection id authenticates as a CognitiveSearch/
            # ApiKey call and 403s at runtime — that is NOT a grounded agent. Require a resolved
            # connection id; a missing one drops the tool so the count-invariant below fails the
            # sync (rather than shipping an unauthenticated tool that looks "synced").
            tool = (
                build_knowledge_mcp_tool(
                    search_endpoint=search_target,
                    index_name=index_name,
                    connection_id=connection_id,
                    server_label=cfg.get("server_label") or None,
                )
                if connection_id
                else None
            )
            if tool is not None:
                tools.append(tool)
        if len(tools) != len(enabled):
            raise AgentSyncError(
                f"Failed to build authenticated MCP tools for all knowledge bases "
                f"({len(tools)}/{len(enabled)}). A KB endpoint/name may be missing or its "
                "RemoteTool connection could not be resolved (a KB without an authenticated "
                "RemoteTool connection would 403 at runtime, so the sync fails instead)."
            )
        return tools

    async def _create_with_retry(  # pragma: no cover — needs a live Foundry endpoint
        self,
        client: Any,
        agent_name: str,
        instructions: str,
        metadata: dict[str, str],
        tools: list[dict[str, Any]],
        model: str,
    ) -> dict[str, Any]:
        """Create the agent version, retrying transient connection drops with 2s/4s backoff.

        A transient error (:func:`_is_transient_error`) is retried up to ``_MAX_CREATE_ATTEMPTS``;
        a non-transient failure (500/auth/etc.) goes straight to the pre-created-agent recovery
        path — API-key auth can update a Portal-created agent but cannot create a new one.
        """
        for attempt in range(1, _MAX_CREATE_ATTEMPTS + 1):
            try:
                return await self._create_version(
                    client, agent_name, instructions, metadata, tools, model
                )
            except Exception as exc:  # noqa: BLE001 — classify, then retry or recover
                if _is_transient_error(exc) and attempt < _MAX_CREATE_ATTEMPTS:
                    await asyncio.sleep(2**attempt)  # 2s, 4s
                    continue
                return await self._recover_or_raise(
                    client, agent_name, instructions, metadata, tools, model, exc
                )
        # Unreachable: the loop either returns or the final attempt hits the else branch above.
        raise AgentSyncError(f"Could not create agent {agent_name!r} after retries")

    async def delete_persona_agent(self, persona: Any) -> None:
        """Best-effort delete of the persona's Foundry agent (used when a persona is removed)."""
        client = await asyncio.to_thread(self._project_client)
        await asyncio.to_thread(client.agents.delete, agent_name=self._agent_name(persona))

    # -- internals ----------------------------------------------------------

    def _agent_name(self, persona: Any) -> str:
        return f"interviewer-{persona.id}"

    def _to_mcp_tool(self, tool: dict[str, Any]) -> Any:
        """Convert an MCP tool dict into an SDK ``MCPTool`` object.

        Used for both the SOP KB (with a RemoteTool ``project_connection_id`` that authenticates
        the KB's MCP endpoint — a CognitiveSearch/ApiKey connection returns 403) and for per-persona
        public MCP servers (no connection id). ``allowed_tools`` is optional (a persona MCP may
        allow all of the server's tools).
        """
        from azure.ai.projects.models import MCPTool, MCPToolFilter

        kwargs: dict[str, Any] = {
            "server_label": tool["server_label"],
            "server_url": tool["server_url"],
            "require_approval": tool.get("require_approval", "never"),
        }
        allowed = tool.get("allowed_tools")
        if allowed and allowed.get("tool_names"):
            kwargs["allowed_tools"] = MCPToolFilter(tool_names=allowed["tool_names"])
        if tool.get("project_connection_id"):
            kwargs["project_connection_id"] = tool["project_connection_id"]
        return MCPTool(**kwargs)

    def _to_sdk_tool(self, tool: dict[str, Any]) -> Any:
        """Dispatch a pure tool dict to its SDK tool object by ``type``.

        Supported (see persona_tools.SUPPORTED_TOOL_TYPES): mcp → MCPTool, code_interpreter →
        CodeInterpreterTool, web_search → WebSearchTool. The gate upstream guarantees only these
        reach here, so an unknown type is a programming error, not user input.
        """
        ttype = tool.get("type")
        if ttype == "mcp":
            return self._to_mcp_tool(tool)
        if ttype == "code_interpreter":
            from azure.ai.projects.models import CodeInterpreterTool

            return CodeInterpreterTool()
        if ttype == "web_search":
            from azure.ai.projects.models import WebSearchTool

            return WebSearchTool()
        raise AgentSyncError(f"Unsupported tool type for sync: {ttype!r}")

    async def _create_version(
        self,
        client: Any,
        agent_name: str,
        instructions: str,
        metadata: dict[str, str],
        tools: list[dict[str, Any]],
        model: str,
    ) -> dict[str, Any]:
        from azure.ai.projects.models import PromptAgentDefinition

        # Attach the SOP knowledge base as an MCPTool when configured so the agent is grounded
        # (P15). The pure builder yields dicts; convert to SDK MCPTool objects here.
        definition_kwargs: dict[str, Any] = {"model": model, "instructions": instructions}
        sdk_tools = [self._to_sdk_tool(t) for t in tools]
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
        model: str,
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
        return await self._create_version(client, agent_name, instructions, metadata, tools, model)

    def _project_client(self) -> Any:
        """Build the project-scoped ``AIProjectClient`` (Entra-first, API-key fallback).

        Delegates to the shared :mod:`foundry_client` builder so the credential decision lives in
        one place; normalizes its error into an :class:`AgentSyncError` for this adapter's callers.
        """
        try:
            return build_project_client(self._endpoint, self._api_key)
        except FoundryClientError as exc:
            raise AgentSyncError(str(exc)) from exc
