"""Tests for the pure/testable pieces of agent_chat_service (Phase 2.3) — zero Azure.

The Responses-API calls need a live Foundry project (coverage-omitted); these tests pin the
fail-fast agent-reference validation and the settings-based runtime-config resolution, which
decide whether a request is even attempted and with which deployment.
"""

import pytest

from app.services.agent_chat_service import (
    AgentChatError,
    _foundry_runtime_config,
    _validate_agent_reference,
)


class TestValidateAgentReference:
    def test_valid_reference_passes_through(self):
        assert _validate_agent_reference("  interviewer-1 ", " 3 ") == ("interviewer-1", "3")

    def test_missing_name_raises(self):
        with pytest.raises(AgentChatError, match="Agent name is required"):
            _validate_agent_reference("", "1")

    def test_classic_assistant_id_rejected(self):
        with pytest.raises(AgentChatError, match="hosted Prompt Agent"):
            _validate_agent_reference("asst_abc123", "1")

    def test_missing_version_raises(self):
        with pytest.raises(AgentChatError, match="Agent version is required"):
            _validate_agent_reference("interviewer-1", "")


class TestFoundryRuntimeConfig:
    def test_prefers_foundry_fields_then_falls_back(self, monkeypatch):
        """foundry_* fields win; azure_foundry_* fill gaps (mirrors registry precedence)."""
        from app.config import get_settings

        settings = get_settings()
        monkeypatch.setattr(settings, "foundry_project_endpoint", "https://proj.example", False)
        monkeypatch.setattr(settings, "azure_foundry_endpoint", "https://fallback.example", False)
        monkeypatch.setattr(settings, "azure_foundry_default_project", "proj", False)
        monkeypatch.setattr(settings, "foundry_api_key", "k-foundry", False)
        monkeypatch.setattr(settings, "azure_foundry_api_key", "k-azure", False)
        monkeypatch.setattr(settings, "foundry_agent_model", "gpt-5.4", False)

        endpoint, project, api_key, model = _foundry_runtime_config()
        assert endpoint == "https://proj.example"  # foundry_project_endpoint preferred
        assert project == "proj"
        assert api_key == "k-foundry"  # foundry_api_key preferred over azure_foundry_api_key
        assert model == "gpt-5.4"

    def test_falls_back_to_azure_fields_when_foundry_blank(self, monkeypatch):
        from app.config import get_settings

        settings = get_settings()
        monkeypatch.setattr(settings, "foundry_project_endpoint", "", False)
        monkeypatch.setattr(settings, "azure_foundry_endpoint", "https://fallback.example", False)
        monkeypatch.setattr(settings, "foundry_api_key", "", False)
        monkeypatch.setattr(settings, "azure_foundry_api_key", "k-azure", False)

        endpoint, _, api_key, _ = _foundry_runtime_config()
        assert endpoint == "https://fallback.example"
        assert api_key == "k-azure"
