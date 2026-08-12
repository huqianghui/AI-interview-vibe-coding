"""Mock adapters — the default local-dev + CI providers (no Azure needed).

Deterministic outputs so tests can assert on them. The interview flow talks only to the
adapter protocols, so swapping in Azure adapters later changes nothing upstream.

The mock ``complete`` recognises the two structured prompts the app sends (checklist drafting,
answer scoring) by a marker in the prompt text and returns a correctly-shaped JSON for each, so the
real parse + validation paths (F3 weight normalization, F4 rails) run in CI with zero Azure. Any
other ``json_mode`` call gets a generic stub.
"""

import json
import re
from collections.abc import AsyncIterator

from app.services.agents.base import LLMAdapter, RetrievalAdapter

# item_id lines in the F4 scoring prompt look like: "[<id>] (<kind>) <text>".
_SCORING_ITEM_RE = re.compile(r"^\[([^\]]+)\]\s*\(([^)]+)\)", re.MULTILINE)


def _mock_checklist_draft() -> str:
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


def _mock_scoring_judgments(prompt: str) -> str:
    """Emit a judgment for every checklist item parsed from the scoring prompt.

    Deterministic: required/recommended → met, forbidden → not_met (nothing triggered). This
    exercises the F4 rails + weighting for real; tests that want other states inject their own LLM.
    """
    judgments = []
    for item_id, kind in _SCORING_ITEM_RE.findall(prompt):
        judgment = "not_met" if kind.strip() == "forbidden" else "met"
        judgments.append(
            {
                "item_id": item_id,
                "judgment": judgment,
                "rationale": "mock judgment",
                "answer_quote": "mock quote",
            }
        )
    return json.dumps({"judgments": judgments})


class MockLLMAdapter(LLMAdapter):
    name = "mock"

    async def complete(self, prompt: str, *, json_mode: bool = False) -> str:
        if json_mode:
            lowered = prompt.lower()
            if "scoring checklist" in lowered:
                return _mock_checklist_draft()
            if "scoring one interview answer" in lowered:
                return _mock_scoring_judgments(prompt)
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

    async def sync_persona(
        self,
        persona: object,
        *,
        locale: str | None = None,
        knowledge_configs: list[dict] | None = None,
    ) -> dict[str, str]:
        pid = getattr(persona, "id", "mock")
        return {"agent_id": f"mock-agent-{pid}", "agent_version": "1"}

    async def delete_persona_agent(self, persona: object) -> None:
        return None
