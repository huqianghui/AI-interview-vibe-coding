"""Adapter registry — selects a provider by name from settings.

Mock adapters are always registered. Azure adapters register only when their optional
dependency + credentials are present, so a bare `pip install -e .` (no azure extra) still
boots and runs on mocks.
"""

import logging

from app.config import get_settings
from app.services.agents.adapters.mock import (
    MockAgentSyncAdapter,
    MockLLMAdapter,
    MockRetrievalAdapter,
)
from app.services.agents.base import AgentSyncAdapter, LLMAdapter, RetrievalAdapter

logger = logging.getLogger(__name__)

_LLM_ADAPTERS: dict[str, LLMAdapter] = {"mock": MockLLMAdapter()}
_RETRIEVAL_ADAPTERS: dict[str, RetrievalAdapter] = {"mock": MockRetrievalAdapter()}
_AGENT_SYNC_ADAPTERS: dict[str, AgentSyncAdapter] = {"mock": MockAgentSyncAdapter()}


def _register_azure_retrieval() -> None:
    """Register the Azure retrieval adapter iff its deps + credentials are present.

    Import is deferred (httpx is always available, but the adapter is only meaningful with a
    configured endpoint) so mock-only environments never touch live Foundry IQ config.
    """
    settings = get_settings()
    if not (
        settings.azure_search_endpoint
        and settings.azure_search_index
        and settings.azure_search_knowledge_source
    ):
        return
    from app.services.agents.adapters.azure_retrieval import AzureRetrievalAdapter

    _RETRIEVAL_ADAPTERS["azure"] = AzureRetrievalAdapter(
        endpoint=settings.azure_search_endpoint,
        kb_name=settings.azure_search_index,
        knowledge_source_name=settings.azure_search_knowledge_source,
        api_key=settings.azure_search_api_key,
    )


def _register_azure_agent_sync() -> None:
    """Register the Azure agent-sync adapter iff a Foundry project endpoint is configured."""
    settings = get_settings()
    if not settings.foundry_project_endpoint:
        return
    from app.services.agents.adapters.azure_agent_sync import AzureAgentSyncAdapter

    _AGENT_SYNC_ADAPTERS["azure"] = AzureAgentSyncAdapter(
        endpoint=settings.foundry_project_endpoint,
        model=settings.foundry_agent_model,
        api_key=settings.foundry_api_key,
        # Bind the SOP knowledge base as an MCPTool so the agent's answers/follow-ups stay
        # SOP-grounded (P15). Reuses the F1 Search config; empty values → no tool (ungrounded).
        search_endpoint=settings.azure_search_endpoint,
        search_index=settings.azure_search_index,
        mcp_connection_id=settings.foundry_kb_mcp_connection,
    )


_register_azure_retrieval()
_register_azure_agent_sync()


def get_llm_adapter(name: str | None = None) -> LLMAdapter:
    """Resolve an LLM adapter by name, or by the configured default.

    A configured DEFAULT that isn't registered (e.g. ``azure_openai`` set in ``.env`` but the azure
    LLM adapter isn't wired/available yet) degrades to ``mock`` with a warning rather than 500ing
    every request. An EXPLICIT unknown ``name`` still raises — that's a programmer/typo error.
    """
    if name is not None:
        adapter = _LLM_ADAPTERS.get(name)
        if adapter is None:
            raise ValueError(f"Unknown LLM provider {name!r}. Registered: {sorted(_LLM_ADAPTERS)}")
        return adapter
    provider = get_settings().default_llm_provider
    adapter = _LLM_ADAPTERS.get(provider)
    if adapter is None:
        logger.warning(
            "Configured LLM provider %r is not registered; falling back to mock. Registered: %s",
            provider,
            sorted(_LLM_ADAPTERS),
        )
        return _LLM_ADAPTERS["mock"]
    return adapter


def get_retrieval_adapter(name: str | None = None) -> RetrievalAdapter:
    """Resolve a retrieval adapter by name, or by the configured default (mock fallback on the
    default path, explicit-unknown raises — same policy as :func:`get_llm_adapter`)."""
    if name is not None:
        adapter = _RETRIEVAL_ADAPTERS.get(name)
        if adapter is None:
            raise ValueError(
                f"Unknown retrieval provider {name!r}. Registered: {sorted(_RETRIEVAL_ADAPTERS)}"
            )
        return adapter
    provider = get_settings().default_retrieval_provider
    adapter = _RETRIEVAL_ADAPTERS.get(provider)
    if adapter is None:
        logger.warning(
            "Configured retrieval provider %r is not registered; falling back to mock.", provider
        )
        return _RETRIEVAL_ADAPTERS["mock"]
    return adapter


def get_agent_sync_adapter(name: str | None = None) -> AgentSyncAdapter:
    provider = name or get_settings().default_agent_sync_provider
    adapter = _AGENT_SYNC_ADAPTERS.get(provider)
    if adapter is None:
        raise ValueError(
            f"Unknown agent-sync provider {provider!r}. Registered: {sorted(_AGENT_SYNC_ADAPTERS)}"
        )
    return adapter
