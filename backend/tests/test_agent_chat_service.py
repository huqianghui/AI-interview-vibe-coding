"""Tests for the pure/testable pieces of agent_chat_service (Phase 2.3) — zero Azure.

The Responses-API calls need a live Foundry project (coverage-omitted); these tests pin the
fail-fast agent-reference validation and the settings-based runtime-config resolution, which
decide whether a request is even attempted and with which deployment.
"""

from unittest.mock import MagicMock, patch

import pytest

from app.services.agent_chat_service import (
    AgentChatError,
    _build_openai_request,
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


class TestBuildOpenAIRequest:
    """The kwargs-assembly logic: agent_reference shape, previous_response_id, agent-vs-plain mode.

    Mocks the runtime config + the (live) project client so the pure request shaping is exercised
    without Azure.
    """

    _CFG = ("https://ep.example", "proj", "key", "gpt-5.4")

    def _patches(self):
        mock_client = MagicMock()
        mock_client.get_openai_client.return_value = "openai-client-sentinel"
        return (
            patch(
                "app.services.agent_chat_service._foundry_runtime_config", return_value=self._CFG
            ),
            patch(
                "app.services.agents.foundry_client.build_project_client", return_value=mock_client
            ),
            patch(
                "app.services.agents.foundry_client.project_endpoint",
                return_value="https://ep.example/api/projects/proj",
            ),
        )

    def test_agent_mode_includes_agent_reference(self):
        p1, p2, p3 = self._patches()
        with p1, p2, p3:
            client, kwargs, endpoint = _build_openai_request("interviewer-1", "3", "hi", None)
        assert client == "openai-client-sentinel"
        assert endpoint == "https://ep.example"
        assert kwargs["model"] == "gpt-5.4"
        assert kwargs["input"] == [{"role": "user", "content": "hi"}]
        assert kwargs["extra_body"]["agent_reference"] == {
            "name": "interviewer-1",
            "version": "3",
            "type": "agent_reference",
        }
        assert "previous_response_id" not in kwargs

    def test_plain_model_mode_omits_agent_reference(self):
        p1, p2, p3 = self._patches()
        with p1, p2, p3:
            _, kwargs, _ = _build_openai_request(None, None, "hi", "resp_123")
        assert "extra_body" not in kwargs  # no agent_reference in plain-model mode
        assert kwargs["previous_response_id"] == "resp_123"

    def test_invalid_reference_raises_before_client_build(self):
        # A blank version fails fast in agent mode — before any client construction.
        p1, p2, p3 = self._patches()
        with p1, p2, p3, pytest.raises(AgentChatError, match="Agent version is required"):
            _build_openai_request("interviewer-1", "", "hi", None)
