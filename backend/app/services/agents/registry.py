"""Adapter registry — selects a provider by name from settings.

Mock adapters are always registered. Azure adapters register only when their optional
dependency + credentials are present, so a bare `pip install -e .` (no azure extra) still
boots and runs on mocks.
"""

from app.config import get_settings
from app.services.agents.adapters.mock import MockLLMAdapter, MockRetrievalAdapter
from app.services.agents.base import LLMAdapter, RetrievalAdapter

_LLM_ADAPTERS: dict[str, LLMAdapter] = {"mock": MockLLMAdapter()}
_RETRIEVAL_ADAPTERS: dict[str, RetrievalAdapter] = {"mock": MockRetrievalAdapter()}


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


_register_azure_retrieval()


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
