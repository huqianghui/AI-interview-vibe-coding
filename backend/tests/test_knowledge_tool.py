"""Foundry-agent knowledge-base MCP tool definition (SPEC F1/P15) — pure shape, no Azure.

The shape matches the reference project's LIVE-verified contract: an MCPTool pointing at the KB's
``/knowledgebases/{index}/mcp`` endpoint, filtered to ``knowledge_base_retrieve``, authenticated by
a RemoteTool project connection (P16 — drift here silently unbinds the KB).
"""

from app.services.agents.knowledge_tool import (
    KB_MCP_TOOL_NAME,
    build_agent_tools,
    build_kb_mcp_url,
    build_knowledge_mcp_tool,
)


def test_mcp_url_shape():
    url = build_kb_mcp_url("https://s.search.windows.net/", "sop-kb")
    assert (
        url
        == "https://s.search.windows.net/knowledgebases/sop-kb/mcp?api-version=2026-05-01-preview"
    )


def test_build_mcp_tool_shape():
    tool = build_knowledge_mcp_tool(
        search_endpoint="https://s.search.windows.net",
        index_name="sop-kb",
        connection_id="sop-kb-remotetool",
    )
    assert tool is not None
    assert tool["type"] == "mcp"
    assert tool["server_label"] == "knowledge-base-sop-kb"
    assert tool["server_url"].endswith("/knowledgebases/sop-kb/mcp?api-version=2026-05-01-preview")
    assert tool["require_approval"] == "never"
    # Agent is filtered to the single KB retrieve tool.
    assert tool["allowed_tools"]["tool_names"] == [KB_MCP_TOOL_NAME]
    # Auth rides on the RemoteTool project connection (NOT a CognitiveSearch/ApiKey conn → 403).
    assert tool["project_connection_id"] == "sop-kb-remotetool"


def test_build_mcp_tool_none_when_unconfigured():
    assert build_knowledge_mcp_tool(search_endpoint="", index_name="") is None
    assert build_knowledge_mcp_tool(search_endpoint="https://s", index_name="") is None


def test_connection_id_omitted_is_none():
    tool = build_knowledge_mcp_tool(search_endpoint="https://s", index_name="kb")
    assert tool is not None
    assert tool["project_connection_id"] is None  # adapter resolves/creates it


def test_build_agent_tools_list_and_empty():
    tools = build_agent_tools(search_endpoint="https://s", index_name="kb", connection_id="c")
    assert len(tools) == 1 and tools[0]["type"] == "mcp"
    assert build_agent_tools(search_endpoint="", index_name="") == []


# --- agent project-endpoint scoping (live-caught 404 fix) ------------------


def test_project_endpoint_scoping():
    # The endpoint-scoping helper now lives in the shared foundry_client (Phase 2.2).
    from app.services.agents.foundry_client import project_endpoint

    # Bare Foundry endpoint + project → project-scoped form the SDK requires.
    assert (
        project_endpoint("https://acct.services.ai.azure.com/", "proj")
        == "https://acct.services.ai.azure.com/api/projects/proj"
    )
    # Already project-scoped → unchanged.
    already = "https://acct.services.ai.azure.com/api/projects/proj"
    assert project_endpoint(already, "proj") == already
    # No project → left as-is (caller owns whether it works).
    assert project_endpoint("https://acct.services.ai.azure.com/", "") == (
        "https://acct.services.ai.azure.com"
    )
