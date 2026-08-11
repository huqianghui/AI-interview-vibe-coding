"""Tests for the pure pieces of foundry_client (Phase 2.2) — zero Azure.

build_project_client itself needs the live SDK (coverage-omitted); the _ApiKeyTokenCredential
stub it uses is pure and testable — it wraps an API key in an AccessToken the SDK constructor
accepts, so a regression in its expiry math or key passthrough would break API-key auth silently.
"""

import time

import pytest

from app.services.agents.foundry_client import _ApiKeyTokenCredential

# These assert the real azure-core AccessToken's construction (token value + expiry), so they need
# the SDK. CI installs only ``.[dev]`` (no azure extra) — skip there; they run on a dev box set up
# for live-Azure testing. build_project_client itself is coverage-omitted for the same reason.
pytest.importorskip("azure.core.credentials")


class TestApiKeyTokenCredential:
    def test_get_token_returns_key_with_future_expiry(self):
        cred = _ApiKeyTokenCredential("my-key")
        token = cred.get_token("https://ai.azure.com/.default")
        assert token.token == "my-key"
        assert token.expires_on > time.time()

    def test_get_token_ignores_scopes_and_kwargs(self):
        # The SDK may call get_token with any scopes/kwargs; the stub returns the key regardless.
        cred = _ApiKeyTokenCredential("k2")
        token = cred.get_token("scope-a", "scope-b", enable_cae=True)
        assert token.token == "k2"
