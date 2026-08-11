"""Shared AI Foundry project-client construction (Phase 2.2).

Both the agent-sync adapter and the connection-discovery service need an ``AIProjectClient``
built the same way: **Entra ID first** (required to create agents / RemoteTool connections),
**API key fallback** (read/update of existing resources on key-auth-enabled resources). This
module owns that single construction path plus the project-endpoint shaping, so the Entra-first
decision (via :mod:`app.services.azure_auth`) is not re-implemented per call site.

Coverage-omitted: every path needs the ``azure-ai-projects`` SDK + a live endpoint.
"""

from __future__ import annotations

import time
from typing import Any

from app.services.azure_auth import FOUNDRY_SCOPE, get_sync_credential_probed


class FoundryClientError(RuntimeError):
    """Raised when no usable Foundry credential is available to build a project client."""


class _ApiKeyTokenCredential:
    """Minimal ``TokenCredential`` stub so ``AIProjectClient`` accepts API-key auth.

    The SDK constructor requires a ``get_token`` method; real request auth is carried by the
    ``AzureKeyCredentialPolicy`` header, so this only needs to return a well-formed AccessToken.
    """

    def __init__(self, api_key: str) -> None:
        self._api_key = api_key

    def get_token(self, *scopes: str, **kwargs: Any) -> Any:
        from azure.core.credentials import AccessToken

        # Far-future expiry; the token itself is never sent (header policy carries the key).
        return AccessToken(self._api_key, int(time.time()) + 3600)


def project_endpoint(endpoint: str, project: str) -> str:
    """Return the project-scoped Foundry endpoint the SDK requires.

    ``https://{acct}.services.ai.azure.com/`` + project → ``…/api/projects/{project}``. Left as-is
    when already project-scoped or when no project is configured (the caller then owns whether that
    endpoint works). The bare account endpoint 404s on every agents/connections call (caught live).
    """
    base = (endpoint or "").rstrip("/")
    if not base or not project or "/api/projects/" in base:
        return base
    return f"{base}/api/projects/{project}"


def build_project_client(endpoint: str, api_key: str = "") -> Any:  # pragma: no cover
    """Build an ``AIProjectClient`` for ``endpoint`` — Entra ID first, API key fallback.

    ``endpoint`` must already be project-scoped (use :func:`project_endpoint`). Raises
    :class:`FoundryClientError` when neither Entra nor an API key can authenticate.
    """
    from azure.ai.projects import AIProjectClient

    # 1) Prefer Entra ID — required to create agents + RemoteTool connections.
    credential = get_sync_credential_probed(FOUNDRY_SCOPE)
    if credential is not None:
        return AIProjectClient(endpoint=endpoint, credential=credential)

    # 2) Fall back to API key (read/update/delete of existing resources only).
    if api_key:
        from azure.core.credentials import AzureKeyCredential
        from azure.core.pipeline.policies import AzureKeyCredentialPolicy

        return AIProjectClient(
            endpoint=endpoint,
            credential=_ApiKeyTokenCredential(api_key),
            authentication_policy=AzureKeyCredentialPolicy(
                credential=AzureKeyCredential(api_key), name="api-key"
            ),
        )
    raise FoundryClientError(
        "No usable Foundry credential: DefaultAzureCredential failed and no API key set."
    )
