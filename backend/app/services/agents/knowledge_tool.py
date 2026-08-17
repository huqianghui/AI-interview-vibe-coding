"""Foundry-agent knowledge-source MCP tool (SPEC F1/F5/P15) — pure shape, CI-tested.

Binding a knowledge base to the interviewer's Foundry prompt agent is what lets the agent's answers
and follow-ups stay grounded. Knowledge is **per-persona** (SPEC F5): each persona attaches its own
knowledge bases and ``build_agent_tools`` takes the list of already-built KB MCPTool dicts for that
persona. AI Foundry connects a Knowledge Base to an agent via the **MCP protocol** (the Portal's
"Knowledge" section, Preview), NOT an ``AzureAISearchTool`` — the KB exposes a
``/knowledgebases/{index}/mcp`` endpoint and the agent carries an **MCPTool** pointing at it. This
module owns the shape (verified against the reference project's live-tested contract, per SPEC P16);
the live SDK ``MCPTool`` construction + the RemoteTool connection it authenticates through live in
the coverage-omitted azure adapter.

Contract facts the reference learned the hard way (and P15/P16 warn drift silently unbinds the KB):
- The tool is an **MCPTool**: ``server_label`` + ``server_url`` (the MCP endpoint) +
  ``require_approval="never"`` + ``allowed_tools={"tool_names": ["knowledge_base_retrieve"]}``.
- Auth is a **RemoteTool** project connection (``project_connection_id``), NOT a CognitiveSearch
  connection — an ApiKey-type connection returns 403. Finding/creating that connection needs the
  ARM control plane and lives in the adapter; this builder just names the endpoint + filter.
- ``knowledge_base_retrieve`` is the single MCP tool name the KB exposes.
"""

from __future__ import annotations

from typing import Any

# The MCP tool the Foundry IQ knowledge base exposes; the agent is filtered to just this one.
KB_MCP_TOOL_NAME = "knowledge_base_retrieve"
# Must track the Foundry IQ / AI Search API version (same PREVIEW contract as the retrieve call).
SEARCH_API_VERSION = "2026-05-01-preview"


def build_kb_mcp_url(search_endpoint: str, index_name: str) -> str:
    """The KB's MCP endpoint: ``{endpoint}/knowledgebases/{index}/mcp?api-version=…`` (pure)."""
    endpoint = (search_endpoint or "").rstrip("/")
    return f"{endpoint}/knowledgebases/{index_name}/mcp?api-version={SEARCH_API_VERSION}"


def build_knowledge_mcp_tool(
    *,
    search_endpoint: str,
    index_name: str,
    connection_id: str | None = None,
    server_label: str | None = None,
) -> dict[str, Any] | None:
    """Build the MCPTool definition for the SOP KB, or None if the KB isn't configured.

    ``connection_id`` is the RemoteTool project-connection name that authenticates the MCP call
    (omitted → the adapter must supply/resolve it; a missing connection fails auth at runtime, per
    the reference). ``server_label`` defaults to a stable per-index label.
    """
    if not (search_endpoint and index_name):
        return None
    return {
        "type": "mcp",
        "server_label": server_label or f"knowledge-base-{index_name}",
        "server_url": build_kb_mcp_url(search_endpoint, index_name),
        "require_approval": "never",
        "allowed_tools": {"tool_names": [KB_MCP_TOOL_NAME]},
        "project_connection_id": connection_id,
    }


def build_agent_tools(
    *,
    knowledge_tools: list[dict[str, Any]] | None = None,
    persona_tools: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """The agent's ``tools`` list — per-persona KB MCPTools first, then any per-persona tools.

    ``knowledge_tools`` is the list of already-built KB MCPTool dicts for THIS persona's attached
    knowledge bases (see ``build_knowledge_mcp_tool`` + the azure adapter's RemoteTool resolution);
    empty means the persona has no KB and syncs ungrounded. ``persona_tools`` must already be gated
    to supported types (see ``build_persona_tools``). Pure concat — no Azure here.
    """
    tools = list(knowledge_tools or [])
    tools.extend(persona_tools or [])
    return tools
