"""Per-persona agent tools (SPEC F5) — pure shape + support gating, CI-tested.

A persona carries a JSON array of tool configs (``persona.tools_config``) that get synced into the
backing Foundry prompt agent's ``tools``. Execution happens in the Foundry runtime, not here — this
module only parses + validates the config, and gates it to the tool types this app can actually emit
to Foundry today, so an unsupported/half-configured tool never reaches the agent.

Supported today (no connection/RemoteTool auth required — they run in the Foundry runtime as-is):
- ``code_interpreter`` — sandboxed Python.
- ``web_search`` — native internet search.
- ``mcp`` — a Model Context Protocol server the agent may call. Only PUBLIC/unauthenticated
  servers are supported here (a bare ``server_url``); a protected MCP server needs a RemoteTool
  ``project_connection_id`` whose provisioning lives in the (KB-specific, not-yet-generic)
  connection layer — those are gated out until that machinery is generalized.

Deferred (need connection auth / spec parsing / Microsoft-hosted backends): openapi, a2a,
bing_grounding, azure_ai_search, sharepoint, fabric, work_iq, computer_use, file_search, etc. The
editor UI still shows those as cards, but they are dropped here so they never sync as a fake tool.
"""

from __future__ import annotations

import json
from typing import Any

# Tool types this app can emit to a Foundry agent right now (see module docstring).
SUPPORTED_TOOL_TYPES = frozenset({"code_interpreter", "web_search", "mcp"})


def parse_persona_tools(tools_config: str | None) -> list[dict[str, Any]]:
    """Parse the persona's ``tools_config`` JSON into a list of tool dicts.

    Tolerant by design: malformed JSON, a non-list top level, or non-dict entries yield ``[]`` /
    are skipped rather than raising — a bad config must never break agent sync.
    """
    if not tools_config:
        return []
    try:
        data = json.loads(tools_config)
    except (ValueError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict) and item.get("type")]


def gate_supported_tools(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep only tools this app can actually sync to Foundry; normalize each to a minimal dict.

    - ``code_interpreter`` / ``web_search``: reduced to ``{"type": ...}`` (no extra config needed).
    - ``mcp``: kept only when it has a ``server_url``; normalized to type + server_label +
      server_url + require_approval + allowed_tools (omitting ``project_connection_id`` — public
      servers only). Anything else (unsupported type, or an MCP without a URL) is dropped.
    """
    out: list[dict[str, Any]] = []
    for item in items:
        ttype = item.get("type")
        if ttype not in SUPPORTED_TOOL_TYPES:
            continue
        if ttype in ("code_interpreter", "web_search"):
            out.append({"type": ttype})
        elif ttype == "mcp":
            server_url = (item.get("server_url") or "").strip()
            if not server_url:
                continue  # a protected/unconfigured MCP can't sync — drop it
            tool: dict[str, Any] = {
                "type": "mcp",
                "server_label": item.get("server_label") or "custom-mcp",
                "server_url": server_url,
                "require_approval": item.get("require_approval", "never"),
            }
            allowed = item.get("allowed_tools")
            if isinstance(allowed, list) and allowed:
                tool["allowed_tools"] = {"tool_names": [str(a) for a in allowed]}
            out.append(tool)
    return out


def build_persona_tools(tools_config: str | None) -> list[dict[str, Any]]:
    """Parse + gate in one call — the supported, sync-ready tool dicts for a persona."""
    return gate_supported_tools(parse_persona_tools(tools_config))
