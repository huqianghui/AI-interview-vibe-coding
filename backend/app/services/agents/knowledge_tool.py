"""Foundry-agent knowledge-source tool definition (SPEC F1/P15) — pure, CI-tested.

Binding the SOP knowledge base to the interviewer's Foundry prompt agent is what lets the agent's
answers and follow-ups stay grounded in the SOP (not just the candidate-facing retrieve API from
F1). Per SPEC P15, the agent↔knowledge-source connection is a distinct dependency from the
citation-retrieve shape, and it drifts across preview versions — so, exactly like the Voice Live
metadata, this module owns the **shape** of the tool definition and is verified in CI, while the
live SDK call that attaches it lives in the coverage-omitted azure adapter.

``build_knowledge_tool`` returns the tool-definition dict the agent create/version call carries
(Azure AI Search knowledge source: endpoint + index + knowledge-source name + auth mode). It
returns ``None`` when no KB is configured, so an agent syncs fine with no knowledge source (the
demo degrades to an ungrounded-but-working interviewer rather than failing).
"""

from __future__ import annotations

from typing import Any

# Tool type + kind strings for the Azure AI Search knowledge source. Isolated as constants because,
# like the Voice Live snake_case keys, a drift here silently unbinds the KB (P15/P16).
KNOWLEDGE_TOOL_TYPE = "azure_ai_search"
KNOWLEDGE_SOURCE_KIND = "search_index"


def build_knowledge_tool(
    *,
    search_endpoint: str,
    index_name: str,
    knowledge_source_name: str,
    auth_mode: str = "entra",
) -> dict[str, Any] | None:
    """Build the agent knowledge-source tool definition, or None if the KB isn't configured.

    ``index_name`` is the KB name in the URL path; ``knowledge_source_name`` is the distinct
    knowledge-source name used in the retrieve body (the F1-spike distinction — they are NOT the
    same, and conflating them 400s the live API). ``auth_mode`` is ``entra`` (managed identity /
    ``az login``) or ``key`` — the resources in play disable key auth, so entra is the default.
    """
    if not (search_endpoint and index_name and knowledge_source_name):
        return None
    return {
        "type": KNOWLEDGE_TOOL_TYPE,
        KNOWLEDGE_TOOL_TYPE: {
            "endpoint": search_endpoint,
            "index_name": index_name,
            "knowledge_source": {
                "name": knowledge_source_name,
                "kind": KNOWLEDGE_SOURCE_KIND,
            },
            "auth_mode": auth_mode,
        },
    }


def build_agent_tools(
    *,
    search_endpoint: str,
    index_name: str,
    knowledge_source_name: str,
    auth_mode: str = "entra",
) -> list[dict[str, Any]]:
    """The agent's ``tools`` list — a single knowledge-source tool when configured, else empty.

    A list (not the bare tool) so callers pass it straight to the agent definition's ``tools=``,
    and so a future second tool is an append, not a shape change.
    """
    tool = build_knowledge_tool(
        search_endpoint=search_endpoint,
        index_name=index_name,
        knowledge_source_name=knowledge_source_name,
        auth_mode=auth_mode,
    )
    return [tool] if tool else []
