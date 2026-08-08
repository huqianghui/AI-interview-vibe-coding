"""Provider adapter protocols.

Two capabilities the interview flow needs from an LLM/agent provider:
- chat/scoring text generation (LLMAdapter)
- SOP citation retrieval for grounding (RetrievalAdapter)

Concrete adapters: a mock pair (local dev + CI, zero Azure) and, later, Azure-backed ones.
Selection is by name via the registry (get_llm_adapter / get_retrieval_adapter).
"""

from collections.abc import AsyncIterator
from typing import Protocol, runtime_checkable


@runtime_checkable
class LLMAdapter(Protocol):
    """Text generation for interviewer turns and scoring."""

    name: str

    async def complete(self, prompt: str, *, json_mode: bool = False) -> str:
        """Return a single completion string (non-streaming)."""
        ...

    def stream(self, prompt: str) -> AsyncIterator[str]:
        """Yield text chunks for a streamed interviewer turn."""
        ...


@runtime_checkable
class RetrievalAdapter(Protocol):
    """SOP citation retrieval. Returns citations shaped {title, url, page}."""

    name: str

    async def retrieve_citations(self, query: str, *, max_citations: int = 3) -> list[dict]: ...
