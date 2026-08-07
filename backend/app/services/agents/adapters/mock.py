"""Mock adapters — the default local-dev + CI providers (no Azure needed).

Deterministic outputs so tests can assert on them. The interview flow talks only to the
adapter protocols, so swapping in Azure adapters later changes nothing upstream.
"""

from collections.abc import AsyncIterator

from app.services.agents.base import LLMAdapter, RetrievalAdapter


class MockLLMAdapter(LLMAdapter):
    name = "mock"

    async def complete(self, prompt: str, *, json_mode: bool = False) -> str:
        if json_mode:
            return '{"result": "mock", "note": "deterministic mock completion"}'
        return "This is a mock interviewer response."

    async def stream(self, prompt: str) -> AsyncIterator[str]:
        for chunk in ("This ", "is ", "a ", "mock ", "streamed ", "response."):
            yield chunk


class MockRetrievalAdapter(RetrievalAdapter):
    name = "mock"

    async def retrieve_citations(self, query: str, *, max_citations: int = 3) -> list[dict]:
        # Canned citations in the {title, url, page} shape the strict gate expects.
        citations = [
            {"title": "SOP Handbook", "url": "sop://handbook#s1", "page": 3},
            {"title": "SOP Handbook", "url": "sop://handbook#s2", "page": 7},
        ]
        return citations[:max_citations]
