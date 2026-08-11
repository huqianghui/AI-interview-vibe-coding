"""Tests for the Foundry LLM adapter (Phase 5) — zero Azure.

The live ``responses.create`` call needs a real Foundry endpoint (coverage-omitted via the
pragma), but everything around it is unit-tested by patching the shared ``build_project_client``
seam — the same trick ``test_agent_chat_service`` uses — so no azure SDK is needed in CI.
"""

from unittest.mock import MagicMock, patch

import pytest

from app.services.agents.adapters.foundry_llm import (
    FoundryLLMAdapter,
    LLMAdapterError,
    _build_completion_kwargs,
)


class TestBuildCompletionKwargs:
    def test_json_mode_adds_text_format(self):
        kwargs = _build_completion_kwargs("gpt-5.4", "grade this", json_mode=True)
        assert kwargs["model"] == "gpt-5.4"
        assert kwargs["input"] == [{"role": "user", "content": "grade this"}]
        # Responses-API JSON mode (NOT chat-completions response_format).
        assert kwargs["text"] == {"format": {"type": "json_object"}}

    def test_non_json_mode_omits_text(self):
        kwargs = _build_completion_kwargs("gpt-5.4", "say hi", json_mode=False)
        assert "text" not in kwargs
        assert kwargs["input"][0]["content"] == "say hi"


class TestComplete:
    def _adapter(self):
        return FoundryLLMAdapter(
            endpoint="https://demo.services.ai.azure.com", project="p", api_key="k", model="gpt-5.4"
        )

    async def test_returns_output_text_and_passes_kwargs(self):
        mock_client = MagicMock()
        openai_client = mock_client.get_openai_client.return_value
        openai_client.responses.create.return_value = MagicMock(output_text='{"judgments": []}')
        with patch(
            "app.services.agents.adapters.foundry_llm.build_project_client",
            return_value=mock_client,
        ):
            out = await self._adapter().complete("scoring prompt", json_mode=True)
        assert out == '{"judgments": []}'
        call_kwargs = openai_client.responses.create.call_args.kwargs
        assert call_kwargs["model"] == "gpt-5.4"
        assert call_kwargs["input"] == [{"role": "user", "content": "scoring prompt"}]
        assert call_kwargs["text"] == {"format": {"type": "json_object"}}

    async def test_empty_output_text_becomes_empty_string(self):
        mock_client = MagicMock()
        mock_client.get_openai_client.return_value.responses.create.return_value = MagicMock(
            output_text=None
        )
        with patch(
            "app.services.agents.adapters.foundry_llm.build_project_client",
            return_value=mock_client,
        ):
            assert await self._adapter().complete("p") == ""

    async def test_failure_raises_llm_adapter_error(self):
        with patch(
            "app.services.agents.adapters.foundry_llm.build_project_client",
            side_effect=RuntimeError("no creds"),
        ):
            with pytest.raises(LLMAdapterError, match="Foundry LLM completion failed"):
                await self._adapter().complete("p")


class TestRegistration:
    """The registry registers the adapter under 'azure' only when a Foundry endpoint is set."""

    def teardown_method(self):
        from app.services.agents import registry

        registry._LLM_ADAPTERS.pop("azure", None)

    def test_registers_when_foundry_endpoint_set(self, monkeypatch):
        from app.config import get_settings
        from app.services.agents import registry

        settings = get_settings()
        monkeypatch.setattr(
            settings, "foundry_project_endpoint", "https://demo.services.ai.azure.com", False
        )
        registry._register_foundry_llm()
        assert registry._LLM_ADAPTERS.get("azure").__class__.__name__ == "FoundryLLMAdapter"

    def test_noop_without_endpoint(self, monkeypatch):
        from app.config import get_settings
        from app.services.agents import registry

        settings = get_settings()
        monkeypatch.setattr(settings, "foundry_project_endpoint", "", False)
        registry._LLM_ADAPTERS.pop("azure", None)
        registry._register_foundry_llm()
        assert "azure" not in registry._LLM_ADAPTERS
