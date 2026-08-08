"""Azure AI Search / Foundry IQ retrieval adapter (coverage-omitted — needs live env).

Registers only when the ``azure`` extra + credentials are present; CI + local dev run on
``MockRetrievalAdapter``. The call shape is a PREVIEW API contract
(``api-version=2026-05-01-preview``) and is the highest-risk external dependency in the
project — see docs/SPIKE-F1-foundry-iq.md.

Contract corrected against a LIVE KB during the F1 spike (the reference had all three wrong):
1. ``knowledgeSourceName`` is the KB's *knowledge source* name, NOT the index/KB name.
2. ``sourceData`` is ``null`` unless ``includeReferenceSourceData: true`` is sent.
3. ``sourceData`` fields are per-index (no universal title/url/page) — mapped via ``field_map``.

Field-gate logic is intentionally NOT duplicated here: it lives in the pure, CI-tested
``agents.citations.shape_citations`` so the invariant is verified without a live endpoint.
"""

import httpx

from app.services.agents.base import RetrievalAdapter
from app.services.agents.citations import (
    DEFAULT_MAX_CITATIONS,
    REQUIRED_CITATION_FIELDS,
    shape_citations,
)

# Keep in sync with the Foundry IQ / AI Search retrieve API version. PREVIEW — may change.
SEARCH_API_VERSION = "2026-05-01-preview"
_TIMEOUT_SECONDS = 15.0


def _build_retrieve_url(endpoint: str, kb_name: str) -> str:
    base = endpoint.rstrip("/")
    return f"{base}/knowledgebases/{kb_name}/retrieve?api-version={SEARCH_API_VERSION}"


class AzureRetrievalAdapter(RetrievalAdapter):
    """Retrieve SOP citations from a Foundry IQ knowledge base over the ``retrieve`` API."""

    name = "azure"

    def __init__(
        self,
        *,
        endpoint: str,
        kb_name: str,
        knowledge_source_name: str,
        api_key: str = "",
        required_fields: tuple[str, ...] = REQUIRED_CITATION_FIELDS,
        field_map: dict[str, str] | None = None,
    ) -> None:
        self._endpoint = endpoint
        self._kb_name = kb_name
        # Distinct from kb_name: the KB references a knowledge source by its own name.
        self._knowledge_source_name = knowledge_source_name
        self._api_key = api_key
        self._required_fields = required_fields
        # Maps canonical citation fields -> this index's sourceData field names.
        self._field_map = field_map or {}

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
                {
                    "knowledgeSourceName": self._knowledge_source_name,
                    "kind": "searchIndex",
                    # Required, or every reference comes back with sourceData=null.
                    "includeReferenceSourceData": True,
                }
            ],
        }
        async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS) as client:
            resp = await client.post(
                _build_retrieve_url(self._endpoint, self._kb_name),
                json=body,
                headers=self._headers(),
            )
            resp.raise_for_status()
        references = resp.json().get("references", []) or []
        # Strict full-field gate — shared, CI-tested logic. Never emits a partial citation.
        return shape_citations(
            references,
            required_fields=self._required_fields,
            field_map=self._field_map,
            max_citations=max_citations,
        )
