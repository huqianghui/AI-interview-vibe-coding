"""Foundry-agent knowledge-source tool definition (SPEC F1/P15) — pure shape, no Azure."""

from app.services.agents.knowledge_tool import (
    KNOWLEDGE_SOURCE_KIND,
    KNOWLEDGE_TOOL_TYPE,
    build_agent_tools,
    build_knowledge_tool,
)


def test_build_knowledge_tool_shape():
    tool = build_knowledge_tool(
        search_endpoint="https://s.search.windows.net",
        index_name="sop-kb",
        knowledge_source_name="sop-kb-ks",
    )
    assert tool is not None
    assert tool["type"] == KNOWLEDGE_TOOL_TYPE
    inner = tool[KNOWLEDGE_TOOL_TYPE]
    assert inner["endpoint"] == "https://s.search.windows.net"
    assert inner["index_name"] == "sop-kb"
    # F1-spike distinction: knowledge-source name is separate from the index/KB name.
    assert inner["knowledge_source"]["name"] == "sop-kb-ks"
    assert inner["knowledge_source"]["kind"] == KNOWLEDGE_SOURCE_KIND
    assert inner["auth_mode"] == "entra"  # resources disable key auth → entra default


def test_build_knowledge_tool_none_when_unconfigured():
    assert build_knowledge_tool(search_endpoint="", index_name="", knowledge_source_name="") is None
    # Any missing piece → no tool (a partial config must not produce a broken binding).
    assert (
        build_knowledge_tool(search_endpoint="https://s", index_name="kb", knowledge_source_name="")
        is None
    )


def test_build_agent_tools_list():
    tools = build_agent_tools(
        search_endpoint="https://s", index_name="kb", knowledge_source_name="ks"
    )
    assert len(tools) == 1
    assert tools[0]["type"] == KNOWLEDGE_TOOL_TYPE


def test_build_agent_tools_empty_when_unconfigured():
    # An unconfigured KB yields no tools, so the agent syncs ungrounded rather than failing.
    assert build_agent_tools(search_endpoint="", index_name="", knowledge_source_name="") == []


def test_auth_mode_override():
    tool = build_knowledge_tool(
        search_endpoint="https://s", index_name="kb", knowledge_source_name="ks", auth_mode="key"
    )
    assert tool is not None
    assert tool[KNOWLEDGE_TOOL_TYPE]["auth_mode"] == "key"
