"""Centralized Azure authentication (Phase 2.1).

ALL Azure service auth goes through this module so the Entra-first / API-key-fallback
strategy lives in exactly one place. Ported from the reference project's ``azure_auth``,
right-sized to this project's four Azure surfaces.

Strategy: **Entra ID (DefaultAzureCredential) first, API key fallback.**
  - Local dev: ``az login`` provides credentials via DefaultAzureCredential.
  - Server (Azure): Managed Identity provides them via DefaultAzureCredential.
  - Fallback: an API key from the admin config (only for resources that keep key auth on).

The demo Foundry resource has API-key auth **disabled**, so Entra is the real path there;
the key fallback exists only for resources that still allow it.

Scopes — the audience each token is validated against, one per Azure surface. Callers pass
the scope matching the API they're hitting; this is the single source of truth for them:
  - ``COGNITIVE_SERVICES_SCOPE`` — Azure OpenAI / Speech / Voice Live.
  - ``FOUNDRY_SCOPE``            — AI Foundry project + model-deployment control plane.
  - ``SEARCH_SCOPE``            — Azure AI Search (Foundry IQ knowledge bases).
  - ``ARM_SCOPE``              — Azure Resource Manager (RemoteTool connection creation).

Helpers:
  - :func:`get_bearer_token` — one-shot async bearer for REST calls (creates + closes a cred).
  - :func:`get_azure_credential_cached` — long-lived async cred reused across bursts (Voice Live).
  - :func:`get_sync_credential_probed` — cached *sync* cred, returned only if a scope probe passes
    (for SDK clients like ``AIProjectClient`` that take a sync ``TokenCredential``).
"""

from __future__ import annotations

import logging
import time
from typing import Any

logger = logging.getLogger(__name__)

# --- scopes (single source of truth for every Azure surface this app touches) ---
COGNITIVE_SERVICES_SCOPE = "https://cognitiveservices.azure.com/.default"
FOUNDRY_SCOPE = "https://ai.azure.com/.default"
SEARCH_SCOPE = "https://search.azure.com/.default"
ARM_SCOPE = "https://management.azure.com/.default"

# Cached sync credential singleton (recreated after a TTL to pick up refreshed tokens).
_credential_instance: Any = None
_credential_lock_time: float = 0.0
_CREDENTIAL_TTL_SECONDS = 1800  # 30 min

# Cached long-lived async credential (process-lifetime; azure-identity caches tokens internally).
_async_credential_instance: Any = None


def _get_credential_sync() -> Any:
    """Get or create a cached sync ``DefaultAzureCredential``.

    Returns the credential, or ``None`` if azure-identity is not installed / fails to init.
    """
    global _credential_instance, _credential_lock_time

    now = time.time()
    if _credential_instance is not None and (now - _credential_lock_time) < _CREDENTIAL_TTL_SECONDS:
        return _credential_instance

    try:
        from azure.identity import DefaultAzureCredential

        _credential_instance = DefaultAzureCredential()
        _credential_lock_time = now
        logger.debug("azure_auth: DefaultAzureCredential (sync) initialized")
        return _credential_instance
    except Exception as exc:  # noqa: BLE001 — any init failure degrades to "no Entra"
        logger.debug("azure_auth: failed to init sync DefaultAzureCredential: %s", exc)
        _credential_instance = None
        return None


def get_sync_credential_probed(scope: str = FOUNDRY_SCOPE) -> Any:
    """Return the cached sync credential **iff** a token for ``scope`` can be obtained, else None.

    This is the Entra-first decision point for SDK clients (e.g. ``AIProjectClient``) that take a
    sync ``TokenCredential``: a successful probe means "use Entra"; ``None`` means "fall back to
    API key". Returning the same instance that was probed lets the caller hand it straight to the
    SDK. Centralizes the probe that ``azure_agent_sync`` (and the Phase 2.2 connection helpers) do.
    """
    cred = _get_credential_sync()
    if cred is None:
        return None
    try:
        cred.get_token(scope)  # probe; raises if the credential can't serve this scope
        return cred
    except Exception as exc:  # noqa: BLE001 — probe failure → caller falls back to API key
        logger.debug("azure_auth: sync credential probe failed for %s: %s", scope, exc)
        return None


def get_azure_credential_cached() -> Any:
    """Return a long-lived async ``DefaultAzureCredential``, reused across calls.

    For burst scenarios (Voice Live reconnect issues several credentials in a row) where
    re-probing the credential chain (env → managed identity/IMDS → CLI) per call is wasteful.
    azure-identity caches tokens internally, so one instance serves repeat ``get_token`` calls.
    Process-lifetime; deliberately not closed per-call. Returns ``None`` if azure-identity is
    unavailable.
    """
    global _async_credential_instance
    if _async_credential_instance is not None:
        return _async_credential_instance
    try:
        from azure.identity.aio import DefaultAzureCredential
    except ImportError:
        return None
    _async_credential_instance = DefaultAzureCredential()
    logger.debug("azure_auth: async DefaultAzureCredential (cached) initialized")
    return _async_credential_instance


async def get_azure_credential() -> Any:
    """Create a fresh async ``DefaultAzureCredential`` (caller owns closing it).

    Used by :func:`get_bearer_token` for one-shot REST calls. Returns ``None`` if unavailable.
    """
    try:
        from azure.identity.aio import DefaultAzureCredential as AsyncDefaultAzureCredential

        return AsyncDefaultAzureCredential()
    except Exception as exc:  # noqa: BLE001
        logger.debug("azure_auth: failed to init async DefaultAzureCredential: %s", exc)
        return None


async def get_bearer_token(scope: str = COGNITIVE_SERVICES_SCOPE) -> str | None:
    """Get a one-shot bearer token for ``scope`` via Entra, or ``None`` if Entra is unavailable.

    Creates and closes a fresh async credential — appropriate for occasional REST calls (e.g.
    Foundry IQ knowledge-base listing, ARM connection creation). For bursty flows prefer
    :func:`get_azure_credential_cached`.
    """
    credential = await get_azure_credential()
    if credential is None:
        return None
    try:
        token = await credential.get_token(scope)
        logger.debug("azure_auth: obtained bearer token for scope %s", scope)
        return token.token
    except Exception as exc:  # noqa: BLE001
        logger.debug("azure_auth: get_bearer_token failed for %s: %s", scope, exc)
        return None
    finally:
        await credential.close()
