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


def get_llm_adapter(name: str | None = None) -> LLMAdapter:
    provider = name or get_settings().default_llm_provider
    adapter = _LLM_ADAPTERS.get(provider)
    if adapter is None:
        raise ValueError(f"Unknown LLM provider {provider!r}. Registered: {sorted(_LLM_ADAPTERS)}")
    return adapter


def get_retrieval_adapter(name: str | None = None) -> RetrievalAdapter:
    provider = name or get_settings().default_voice_provider
    adapter = _RETRIEVAL_ADAPTERS.get(provider)
    if adapter is None:
        raise ValueError(
            f"Unknown retrieval provider {provider!r}. Registered: {sorted(_RETRIEVAL_ADAPTERS)}"
        )
    return adapter
