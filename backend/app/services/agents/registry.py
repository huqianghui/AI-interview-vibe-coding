"""Adapter registry — selects a provider by name from settings.

Mock adapters are always registered. Azure adapters register only when their optional
dependency + credentials are present, so a bare `pip install -e .` (no azure extra) still
boots and runs on mocks.
"""

from app.config import get_settings
from app.services.agents.adapters.mock import (
    MockAgentSyncAdapter,
    MockLLMAdapter,
    MockRetrievalAdapter,
)
from app.services.agents.base import AgentSyncAdapter, LLMAdapter, RetrievalAdapter

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
    )


_register_azure_retrieval()
_register_azure_agent_sync()


def get_llm_adapter(name: str | None = None) -> LLMAdapter:
    provider = name or get_settings().default_llm_provider
    adapter = _LLM_ADAPTERS.get(provider)
    if adapter is None:
        raise ValueError(f"Unknown LLM provider {provider!r}. Registered: {sorted(_LLM_ADAPTERS)}")
    return adapter


def get_retrieval_adapter(name: str | None = None) -> RetrievalAdapter:
    provider = name or get_settings().default_retrieval_provider
    adapter = _RETRIEVAL_ADAPTERS.get(provider)
    if adapter is None:
        raise ValueError(
            f"Unknown retrieval provider {provider!r}. Registered: {sorted(_RETRIEVAL_ADAPTERS)}"
        )
    return adapter


def get_agent_sync_adapter(name: str | None = None) -> AgentSyncAdapter:
    provider = name or get_settings().default_agent_sync_provider
    adapter = _AGENT_SYNC_ADAPTERS.get(provider)
    if adapter is None:
        raise ValueError(
            f"Unknown agent-sync provider {provider!r}. Registered: {sorted(_AGENT_SYNC_ADAPTERS)}"
        )
    return adapter
