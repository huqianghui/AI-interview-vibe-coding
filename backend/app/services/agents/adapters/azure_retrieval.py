"""Azure AI Search / Foundry IQ retrieval adapter (coverage-omitted — needs live env).

Ported from the reference ``avatar_search_service.retrieve_citations``. Registers only when
the ``azure`` extra + credentials are present; CI + local dev run on ``MockRetrievalAdapter``.

The call shape is a PREVIEW API contract (``api-version=2026-05-01-preview``) and is the
highest-risk external dependency in the project — see SPIKE.md for the fallback triggers.

Field-gate logic is intentionally NOT duplicated here: it lives in the pure, CI-tested
``agents.citations.shape_citations`` so the invariant is verified without a live endpoint.
"""

import httpx

from app.services.agents.base import RetrievalAdapter
from app.services.agents.citations import DEFAULT_MAX_CITATIONS, shape_citations

# Keep in sync with the Foundry IQ / AI Search retrieve API version. PREVIEW — may change.
SEARCH_API_VERSION = "2026-05-01-preview"
_TIMEOUT_SECONDS = 15.0


def _build_retrieve_url(endpoint: str, kb_name: str) -> str:
    base = endpoint.rstrip("/")
    return f"{base}/knowledgebases/{kb_name}/retrieve?api-version={SEARCH_API_VERSION}"


class AzureRetrievalAdapter(RetrievalAdapter):
    """Retrieve SOP citations from a Foundry IQ knowledge base over the ``retrieve`` API."""

    name = "azure"

    def __init__(self, *, endpoint: str, index_name: str, api_key: str = "") -> None:
        self._endpoint = endpoint
        self._index_name = index_name
        self._api_key = api_key

    def _headers(self) -> dict[str, str]:
        # API-key auth for the spike; production swaps to an Entra bearer token (search scope).
        headers = {"Content-Type": "application/json"}
        if self._api_key:
            headers["api-key"] = self._api_key
        return headers

    async def retrieve_citations(
        self, query: str, *, max_citations: int = DEFAULT_MAX_CITATIONS
    ) -> list[dict]:
        body = {
            "messages": [{"role": "user", "content": [{"type": "text", "text": query}]}],
            "knowledgeSourceParams": [
                {"knowledgeSourceName": self._index_name, "kind": "searchIndex"}
            ],
        }
        async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS) as client:
            resp = await client.post(
                _build_retrieve_url(self._endpoint, self._index_name),
                json=body,
                headers=self._headers(),
            )
            resp.raise_for_status()
        references = resp.json().get("references", []) or []
        # Strict full-field gate — shared, CI-tested logic. Never emits a partial citation.
        return shape_citations(references, max_citations=max_citations)
