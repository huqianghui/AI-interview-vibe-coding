"""Voice Live credential providers (SPEC F9).

The broker (:mod:`app.services.voice_broker`) needs one browser-safe credential per WebRTC
session: a short-lived **bearer token**, because Voice Live agent mode rejects raw API-key auth
("Key authentication is not supported in Agent mode"). Obtaining it is a network call to the
Cognitive Services STS ``issueToken`` endpoint — so it is isolated behind a provider protocol:

- :class:`MockVoiceProvider` — the CI/dev default. Returns a deterministic placeholder credential
  with no network, so the whole broker + frontend flow runs with zero Azure.
- :class:`AzureVoiceProvider` — the real STS key→bearer exchange. Coverage-omitted (needs a live
  endpoint), registered only when ``default_voice_provider="azure"``.

Selection mirrors the agent registry: :func:`get_voice_provider` resolves by name, defaulting to
``settings.default_voice_provider``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

from app.config import get_settings
from app.utils.azure_endpoints import endpoint_host


@dataclass(frozen=True)
class VoiceCredential:
    """A browser-safe, short-lived Voice Live credential + the host it's scoped to."""

    auth_token: str
    auth_type: str  # "bearer" (agent/model realtime) — key auth is never sent to the browser
    host: str | None = None


@runtime_checkable
class VoiceProvider(Protocol):
    name: str

    async def issue_credential(self, *, endpoint: str, api_key: str) -> VoiceCredential: ...


class MockVoiceProvider:
    """Deterministic placeholder credential — no Azure (CI + local dev default)."""

    name = "mock"

    async def issue_credential(self, *, endpoint: str, api_key: str) -> VoiceCredential:
        # A recognisable, obviously-fake token so a mock credential can never be mistaken for a
        # real bearer in logs or a demo. The host echoes the (possibly empty) configured endpoint.
        # `api_key` is unused by design here — the mock never authenticates — but the parameter
        # name is fixed by the VoiceProvider protocol.
        del api_key
        return VoiceCredential(
            auth_token="mock-voice-bearer-token",
            auth_type="bearer",
            host=endpoint_host(endpoint) or "voice-live.mock.local",
        )


# Azure Cognitive Services token scope — the audience Voice Live validates the bearer against.
COGNITIVE_SERVICES_SCOPE = "https://cognitiveservices.azure.com/.default"


class AzureVoiceProvider:
    """Real Voice Live credential issuance — **Entra (AAD) first, STS key fallback**.

    This mirrors the reference project's proven strategy (``azure_auth`` /
    ``voice_live_websocket``): many Foundry resources have **key-based auth disabled**, so an
    ``/sts/v1.0/issueToken`` exchange returns 403 ``AuthenticationTypeDisabled``. On those resources
    the browser must instead present a Microsoft Entra bearer token (``DefaultAzureCredential`` —
    ``az login`` locally, Managed Identity on Azure) scoped to ``cognitiveservices.azure.com``.

    Order:
    1. Try an AAD bearer via ``DefaultAzureCredential`` (works when the resource requires Entra).
    2. Fall back to the STS key→bearer exchange (works when key auth is enabled).

    Either way the browser attaches the returned bearer as the signaling ``Authorization`` query
    parameter (browsers can't set custom WebSocket headers). Coverage-omitted (needs live Azure).
    """

    name = "azure"

    def __init__(self) -> None:
        # Cached across calls: DefaultAzureCredential caches tokens internally until near expiry,
        # so reusing one instance avoids re-probing the whole credential chain (env → managed
        # identity/IMDS → CLI) on every session. Matters under the reconnect path, which can issue
        # several credentials in a burst. The registry keeps this provider a singleton.
        self._credential: Any = None

    # Azure-only paths below need a live endpoint, so they are coverage-omitted (pragma).
    async def issue_credential(  # pragma: no cover
        self, *, endpoint: str, api_key: str
    ) -> VoiceCredential:
        if not endpoint:
            raise ValueError("Azure voice provider requires an endpoint")

        aad = await self._try_entra_token()
        if aad is not None:
            return VoiceCredential(auth_token=aad, auth_type="bearer", host=endpoint_host(endpoint))

        if api_key:
            token = await self._sts_exchange(endpoint, api_key)
            return VoiceCredential(
                auth_token=token, auth_type="bearer", host=endpoint_host(endpoint)
            )

        raise ValueError(
            "No Voice Live credential available: Entra probe failed and no API key configured. "
            "Run 'az login' (or grant the identity Cognitive Services User), or enable key auth."
        )

    async def _try_entra_token(self) -> str | None:  # pragma: no cover
        """Get a Cognitive Services AAD bearer, or None if Entra auth is unavailable.

        Reuses a cached credential so azure-identity's internal token cache serves repeat calls
        without re-probing the credential chain. Not closed per-call (the instance is long-lived).
        """
        if self._credential is None:
            try:
                from azure.identity.aio import DefaultAzureCredential
            except ImportError:
                return None
            self._credential = DefaultAzureCredential()
        try:
            token = await self._credential.get_token(COGNITIVE_SERVICES_SCOPE)
            return token.token
        except Exception:
            return None

    async def _sts_exchange(self, endpoint: str, api_key: str) -> str:  # pragma: no cover
        """Exchange an API key for a ~10-minute STS bearer (only when key auth is enabled)."""
        import httpx

        sts_url = f"{endpoint.rstrip('/')}/sts/v1.0/issueToken"
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                sts_url, headers={"Ocp-Apim-Subscription-Key": api_key}, content=b""
            )
            resp.raise_for_status()
            return resp.text


_PROVIDERS: dict[str, VoiceProvider] = {"mock": MockVoiceProvider()}


def _register_azure() -> None:
    """Register the Azure provider iff a Foundry endpoint + key are configured."""
    settings = get_settings()
    if settings.azure_foundry_endpoint and settings.azure_foundry_api_key:
        _PROVIDERS["azure"] = AzureVoiceProvider()  # pragma: no cover


_register_azure()


def get_voice_provider(name: str | None = None) -> VoiceProvider:
    provider = name or get_settings().default_voice_provider
    adapter = _PROVIDERS.get(provider)
    if adapter is None:
        # Fall back to mock rather than 500 when "azure" is selected but unconfigured (CI safety).
        adapter = _PROVIDERS["mock"]
    return adapter
