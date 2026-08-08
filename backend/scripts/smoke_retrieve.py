"""Live smoke test for the Foundry IQ / Azure AI Search `retrieve` contract (F1 spike).

NOT a pytest test — CI has no Azure creds, so this stays out of the suite and is run by hand
against a live KB to validate the spike's Trigger A (citation-retrieve shape stability).

Reads all connection info from the environment (never hardcoded — this repo is PUBLIC):

    AZURE_SEARCH_ENDPOINT           e.g. https://<resource>.search.windows.net/
    AZURE_SEARCH_INDEX              the knowledge base name (URL path segment)
    AZURE_SEARCH_KNOWLEDGE_SOURCE   the knowledge source name (retrieve body; ≠ index — spike)
    AZURE_SEARCH_API_KEY            (optional) admin/query key; if absent, an Entra bearer token
                                    is minted via `az account get-access-token --scope
                                    https://search.azure.com/.default`

Usage:
    cd backend
    set -a && source .env && set +a          # loads AZURE_SEARCH_* (gitignored)
    python scripts/smoke_retrieve.py "your query here"

It exercises the SAME `shape_citations` gate the app uses, so a green run validates the real
end-to-end contract: raw `retrieve` response -> strict full-field gate -> candidate citations.
"""

import asyncio
import json
import os
import subprocess
import sys

import httpx

# Import the shared gate + call-shape pieces from the app so the smoke test can't drift from it.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.services.agents.adapters.azure_retrieval import (  # noqa: E402
    SEARCH_API_VERSION,
    _build_retrieve_url,
)
from app.services.agents.citations import shape_citations  # noqa: E402


def _bearer_token() -> str:
    """Mint a search-scoped Entra token via the Azure CLI (no stored secret)."""
    out = subprocess.run(
        [
            "az",
            "account",
            "get-access-token",
            "--scope",
            "https://search.azure.com/.default",
            "--query",
            "accessToken",
            "-o",
            "tsv",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return out.stdout.strip()


async def main() -> int:
    endpoint = os.environ.get("AZURE_SEARCH_ENDPOINT", "").strip()
    index = os.environ.get("AZURE_SEARCH_INDEX", "").strip()
    knowledge_source = os.environ.get("AZURE_SEARCH_KNOWLEDGE_SOURCE", "").strip() or index
    api_key = os.environ.get("AZURE_SEARCH_API_KEY", "").strip()
    query = sys.argv[1] if len(sys.argv) > 1 else "What are the key product parameters?"

    if not endpoint or not index:
        print("ERROR: set AZURE_SEARCH_ENDPOINT and AZURE_SEARCH_INDEX (e.g. source .env).")
        return 2

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["api-key"] = api_key
        auth_mode = "api-key"
    else:
        headers["Authorization"] = f"Bearer {_bearer_token()}"
        auth_mode = "entra-bearer"

    url = _build_retrieve_url(endpoint, index)
    body = {
        "messages": [{"role": "user", "content": [{"type": "text", "text": query}]}],
        "knowledgeSourceParams": [
            {
                "knowledgeSourceName": knowledge_source,
                "kind": "searchIndex",
                "includeReferenceSourceData": True,
            }
        ],
    }

    print(f"POST {url}")
    print(f"  auth={auth_mode}  api-version={SEARCH_API_VERSION}  query={query!r}\n")

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(url, json=body, headers=headers)

    print(f"HTTP {resp.status_code}")
    if resp.status_code != 200:
        print(resp.text[:1000])
        return 1

    payload = resp.json()
    references = payload.get("references", []) or []
    print(f"raw references: {len(references)}")

    # Show the raw sourceData field presence so we can eyeball Trigger A (shape stability).
    for i, ref in enumerate(references[:5]):
        data = ref.get("sourceData") or {}
        present = {k: (k in data and bool(data.get(k))) for k in ("title", "url", "page")}
        print(f"  [{i}] sourceData keys={sorted(data.keys())} full-field={present}")

    # Optional canonical->sourceData field mapping (KBs rarely expose title/url/page directly).
    raw_map = os.environ.get("SMOKE_FIELD_MAP", "").strip()
    field_map = dict(pair.split("=", 1) for pair in raw_map.split(",") if "=" in pair)
    citations = shape_citations(references, field_map=field_map)
    print(f"\ngated citations ({len(citations)}) field_map={field_map or 'none'}:")
    print(json.dumps(citations, indent=2, ensure_ascii=False))

    if not references:
        print("\n(zero references — the 'no match' signal; try a query that matches the KB)")
    elif not citations:
        print("\nWARNING: references present but all dropped by the gate — Trigger A candidate.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
