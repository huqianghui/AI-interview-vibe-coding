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
  connection layer — those are gated out until that machinery is generalized. A persona MCP
  defaults to ``require_approval="always"`` (the agent talks to an untrusted candidate, so an
  admin-added public server should not auto-run its tools without a human gate).

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


# Only these approval modes reach the SDK; anything else falls back to the safe default.
_VALID_APPROVAL_MODES = frozenset({"never", "always"})
# MCP server URLs must be plain http(s); block other schemes (file:, gopher:, etc.).
_ALLOWED_MCP_SCHEMES = ("https://", "http://")


def _clean_str(value: Any) -> str:
    """Return a stripped string only when the value actually is one, else '' (type-safe)."""
    return value.strip() if isinstance(value, str) else ""


def gate_supported_tools(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep only tools this app can actually sync to Foundry; normalize + dedupe each.

    - ``code_interpreter`` / ``web_search``: reduced to ``{"type": ...}``, at most once each
      (duplicates in the config collapse to a single tool).
    - ``mcp``: kept only when it has a syntactically valid http(s) ``server_url``; normalized to
      type + server_label + server_url + require_approval (+ allowed_tools when given). Deduped by
      server_url so the same server isn't synced twice. ``require_approval`` is clamped to a known
      mode; ``project_connection_id`` from input is never carried through (public servers only).

    Tolerant by design: non-string / malformed fields are treated as absent, never raised.
    """
    out: list[dict[str, Any]] = []
    seen_simple: set[str] = set()
    seen_mcp_urls: set[str] = set()
    for item in items:
        ttype = item.get("type")
        if ttype not in SUPPORTED_TOOL_TYPES:
            continue
        if ttype in ("code_interpreter", "web_search"):
            if ttype in seen_simple:
                continue  # single-instance — collapse duplicates
            seen_simple.add(ttype)
            out.append({"type": ttype})
        elif ttype == "mcp":
            server_url = _clean_str(item.get("server_url"))
            # Require a plain http(s) URL — drop empty, non-string, or other-scheme values so no
            # unvalidated/foot-gun URL (file:, loopback-only-scheme abuse) reaches the SDK.
            if not server_url.lower().startswith(_ALLOWED_MCP_SCHEMES):
                continue
            if server_url in seen_mcp_urls:
                continue  # same server already gated in — dedupe
            seen_mcp_urls.add(server_url)
            # Default to require_approval="always" for a persona MCP: the agent runs a live
            # conversation with an untrusted candidate, so an unapproved+unfiltered public MCP is a
            # prompt-injection→arbitrary-tool-call risk. The vetted SOP-KB tool (built separately in
            # knowledge_tool.py) keeps its own "never" — this default only governs admin-added MCPs.
            approval = item.get("require_approval", "always")
            tool: dict[str, Any] = {
                "type": "mcp",
                "server_label": _clean_str(item.get("server_label")) or "custom-mcp",
                "server_url": server_url,
                "require_approval": approval if approval in _VALID_APPROVAL_MODES else "always",
            }
            allowed = item.get("allowed_tools")
            if isinstance(allowed, list) and allowed:
                names = [a for a in allowed if isinstance(a, str) and a.strip()]
                if names:
                    tool["allowed_tools"] = {"tool_names": names}
            out.append(tool)
    return out


def build_persona_tools(tools_config: str | None) -> list[dict[str, Any]]:
    """Parse + gate in one call — the supported, sync-ready tool dicts for a persona."""
    return gate_supported_tools(parse_persona_tools(tools_config))
