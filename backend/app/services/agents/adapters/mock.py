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
            # A checklist-drafting prompt (F3) gets a checklist-shaped JSON so the parse+normalize
            # path is exercised deterministically in CI; any other json_mode call gets the generic
            # stub. Detection is by the drafting prompt's own marker text, not the caller.
            if "scoring checklist" in prompt.lower():
                return (
                    '{"items": ['
                    '{"kind": "required", "text": "Identifies the correct procedure", '
                    '"weight": 50, "source_quote": "Follow the documented steps in order.", '
                    '"source_page": "p.1"}, '
                    '{"kind": "recommended", "text": "Explains the reasoning", "weight": 30}, '
                    '{"kind": "forbidden", "text": "Skips the safety check", '
                    '"source_quote": "Never bypass the safety check.", "source_page": "p.2"}'
                    "]}"
                )
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


class MockAgentSyncAdapter:
    """Default agent-sync provider — pretends to sync a persona, no Azure (SPEC F5).

    Lets the persona CRUD + sync-bookkeeping flow run end to end in dev/CI: the API can mark a
    persona synced with deterministic ids without a Foundry project. The real adapter
    (``AzureAgentSyncAdapter``) registers only when a Foundry endpoint is configured.
    """

    name = "mock"

    async def sync_persona(self, persona: object, *, locale: str | None = None) -> dict[str, str]:
        pid = getattr(persona, "id", "mock")
        return {"agent_id": f"mock-agent-{pid}", "agent_version": "1"}

    async def delete_persona_agent(self, persona: object) -> None:
        return None
