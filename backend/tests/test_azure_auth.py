"""Tests for the centralized Azure authentication module (Phase 2.1).

Ported from the reference project's ``test_azure_auth`` and extended for this project's two
extra helpers (:func:`get_sync_credential_probed`, :func:`get_azure_credential_cached`) and the
per-surface scope constants. All auth is mocked — zero Azure.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import app.services.azure_auth as azure_auth
from app.services.azure_auth import (
    ARM_SCOPE,
    COGNITIVE_SERVICES_SCOPE,
    FOUNDRY_SCOPE,
    SEARCH_SCOPE,
    get_auth_headers,
    get_azure_credential,
    get_azure_credential_cached,
    get_azure_openai_client,
    get_bearer_token,
    get_sync_credential_probed,
)


def _reset_caches() -> None:
    """Clear module-level credential singletons so tests don't leak into each other."""
    azure_auth._credential_instance = None
    azure_auth._credential_lock_time = 0.0
    azure_auth._async_credential_instance = None


class TestScopes:
    def test_all_four_surface_scopes_distinct(self):
        """The four surface scopes must be distinct — a wrong scope silently 401s a service."""
        scopes = {COGNITIVE_SERVICES_SCOPE, FOUNDRY_SCOPE, SEARCH_SCOPE, ARM_SCOPE}
        assert len(scopes) == 4
        assert FOUNDRY_SCOPE == "https://ai.azure.com/.default"
        assert SEARCH_SCOPE == "https://search.azure.com/.default"
        assert ARM_SCOPE == "https://management.azure.com/.default"


class TestGetAzureCredential:
    async def test_returns_credential_when_available(self):
        mock_cred = MagicMock()
        with patch("azure.identity.aio.DefaultAzureCredential", return_value=mock_cred):
            assert await get_azure_credential() is mock_cred

    async def test_returns_none_when_import_fails(self):
        with patch.dict("sys.modules", {"azure.identity.aio": None}):
            with patch("builtins.__import__", side_effect=ImportError("no module")):
                assert await get_azure_credential() is None


class TestGetBearerToken:
    async def test_returns_token_on_success(self):
        mock_token = MagicMock()
        mock_token.token = "test-aad-token"
        mock_cred = AsyncMock()
        mock_cred.get_token = AsyncMock(return_value=mock_token)
        mock_cred.close = AsyncMock()
        with patch(
            "app.services.azure_auth.get_azure_credential", new=AsyncMock(return_value=mock_cred)
        ):
            result = await get_bearer_token()
            assert result == "test-aad-token"
            mock_cred.get_token.assert_called_once_with(COGNITIVE_SERVICES_SCOPE)
            mock_cred.close.assert_called_once()

    async def test_returns_none_when_no_credential(self):
        with patch(
            "app.services.azure_auth.get_azure_credential", new=AsyncMock(return_value=None)
        ):
            assert await get_bearer_token() is None

    async def test_returns_none_on_token_error(self):
        mock_cred = AsyncMock()
        mock_cred.get_token = AsyncMock(side_effect=Exception("auth failed"))
        mock_cred.close = AsyncMock()
        with patch(
            "app.services.azure_auth.get_azure_credential", new=AsyncMock(return_value=mock_cred)
        ):
            assert await get_bearer_token() is None
            mock_cred.close.assert_called_once()

    async def test_custom_scope(self):
        mock_token = MagicMock()
        mock_token.token = "custom-token"
        mock_cred = AsyncMock()
        mock_cred.get_token = AsyncMock(return_value=mock_token)
        mock_cred.close = AsyncMock()
        with patch(
            "app.services.azure_auth.get_azure_credential", new=AsyncMock(return_value=mock_cred)
        ):
            result = await get_bearer_token(SEARCH_SCOPE)
            assert result == "custom-token"
            mock_cred.get_token.assert_called_once_with(SEARCH_SCOPE)


class TestGetSyncCredentialProbed:
    def teardown_method(self):
        _reset_caches()

    def test_returns_credential_when_probe_succeeds(self):
        mock_cred = MagicMock()
        mock_cred.get_token = MagicMock(return_value=MagicMock(token="tok"))
        with patch("app.services.azure_auth._get_credential_sync", return_value=mock_cred):
            result = get_sync_credential_probed(FOUNDRY_SCOPE)
            assert result is mock_cred
            mock_cred.get_token.assert_called_once_with(FOUNDRY_SCOPE)

    def test_returns_none_when_no_credential(self):
        with patch("app.services.azure_auth._get_credential_sync", return_value=None):
            assert get_sync_credential_probed() is None

    def test_returns_none_when_probe_raises(self):
        mock_cred = MagicMock()
        mock_cred.get_token = MagicMock(side_effect=Exception("no az login"))
        with patch("app.services.azure_auth._get_credential_sync", return_value=mock_cred):
            assert get_sync_credential_probed(FOUNDRY_SCOPE) is None


class TestGetAzureCredentialCached:
    def teardown_method(self):
        _reset_caches()

    def test_caches_single_instance(self):
        mock_cred = MagicMock()
        with patch("azure.identity.aio.DefaultAzureCredential", return_value=mock_cred) as ctor:
            first = get_azure_credential_cached()
            second = get_azure_credential_cached()
            assert first is mock_cred
            assert second is mock_cred
            ctor.assert_called_once()  # second call reuses the cached instance

    def test_returns_none_when_import_fails(self):
        _reset_caches()
        with patch.dict("sys.modules", {"azure.identity.aio": None}):
            with patch("builtins.__import__", side_effect=ImportError("no module")):
                assert get_azure_credential_cached() is None


class TestGetAzureOpenAIClient:
    async def test_uses_aad_token_when_available(self):
        mock_cred = MagicMock()
        token_provider = MagicMock(return_value="aad-token-123")
        mock_client = MagicMock()
        with (
            patch("app.services.azure_auth._get_credential_sync", return_value=mock_cred),
            patch("azure.identity.get_bearer_token_provider", return_value=token_provider),
            patch("openai.AsyncAzureOpenAI", return_value=mock_client) as mock_cls,
        ):
            result = await get_azure_openai_client(
                endpoint="https://test.openai.azure.com", api_key="fallback-key"
            )
            assert result is mock_client
            call_kwargs = mock_cls.call_args.kwargs
            assert call_kwargs["azure_ad_token_provider"] is token_provider
            assert "api_key" not in call_kwargs
            token_provider.assert_called_once_with()

    async def test_falls_back_to_api_key(self):
        mock_cred = MagicMock()
        token_provider = MagicMock(side_effect=Exception("no az login"))
        mock_client = MagicMock()
        with (
            patch("app.services.azure_auth._get_credential_sync", return_value=mock_cred),
            patch("azure.identity.get_bearer_token_provider", return_value=token_provider),
            patch("openai.AsyncAzureOpenAI", return_value=mock_client) as mock_cls,
        ):
            result = await get_azure_openai_client(
                endpoint="https://test.openai.azure.com", api_key="my-api-key"
            )
            assert result is mock_client
            call_kwargs = mock_cls.call_args.kwargs
            assert call_kwargs["api_key"] == "my-api-key"
            assert "azure_ad_token_provider" not in call_kwargs

    async def test_raises_when_no_credentials(self):
        token_provider = MagicMock(side_effect=Exception("no cred"))
        with (
            patch("app.services.azure_auth._get_credential_sync", return_value=MagicMock()),
            patch("azure.identity.get_bearer_token_provider", return_value=token_provider),
        ):
            with pytest.raises(RuntimeError, match="No Azure credentials available"):
                await get_azure_openai_client(endpoint="https://test.openai.azure.com", api_key="")

    async def test_passes_api_version_and_timeout(self):
        token_provider = MagicMock(return_value="token")
        mock_client = MagicMock()
        with (
            patch("app.services.azure_auth._get_credential_sync", return_value=MagicMock()),
            patch("azure.identity.get_bearer_token_provider", return_value=token_provider),
            patch("openai.AsyncAzureOpenAI", return_value=mock_client) as mock_cls,
        ):
            await get_azure_openai_client(
                endpoint="https://test.openai.azure.com",
                api_version="2024-12-01-preview",
                timeout=10.0,
            )
            call_kwargs = mock_cls.call_args.kwargs
            assert call_kwargs["api_version"] == "2024-12-01-preview"
            assert call_kwargs["timeout"] == 10.0


class TestGetAuthHeaders:
    async def test_uses_aad_token_when_available(self):
        with patch(
            "app.services.azure_auth.get_bearer_token",
            new=AsyncMock(return_value="bearer-token-123"),
        ):
            headers = await get_auth_headers(api_key="fallback")
            assert headers["Authorization"] == "Bearer bearer-token-123"
            assert headers["Content-Type"] == "application/json"
            assert "Ocp-Apim-Subscription-Key" not in headers

    async def test_falls_back_to_api_key(self):
        with patch("app.services.azure_auth.get_bearer_token", new=AsyncMock(return_value=None)):
            headers = await get_auth_headers(api_key="my-key")
            assert headers["Ocp-Apim-Subscription-Key"] == "my-key"
            assert "Authorization" not in headers

    async def test_passes_custom_scope_to_bearer(self):
        mock_bearer = AsyncMock(return_value="tok")
        with patch("app.services.azure_auth.get_bearer_token", new=mock_bearer):
            await get_auth_headers(scope=ARM_SCOPE)
            mock_bearer.assert_awaited_once_with(ARM_SCOPE)

    async def test_raises_when_no_credentials(self):
        with patch("app.services.azure_auth.get_bearer_token", new=AsyncMock(return_value=None)):
            with pytest.raises(RuntimeError, match="No Azure credentials available"):
                await get_auth_headers(api_key="")
