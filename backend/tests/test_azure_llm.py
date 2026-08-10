"""AzureLLMAdapter: complete() shape + json_mode + registry wiring (mocked client, no Azure)."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from app.services.agents.adapters.azure_llm import AzureLLMAdapter


def _fake_client(content: str):
    """A stand-in AsyncAzureOpenAI whose chat.completions.create returns `content`."""
    client = MagicMock()
    client.close = AsyncMock()
    message = SimpleNamespace(content=content)
    choice = SimpleNamespace(message=message)
    client.chat.completions.create = AsyncMock(return_value=SimpleNamespace(choices=[choice]))
    return client


async def test_complete_returns_content_and_closes(monkeypatch):
    adapter = AzureLLMAdapter(
        endpoint="https://x.openai.azure.com", deployment="gpt-4o-mini", api_key="k"
    )
    client = _fake_client("hello")
    monkeypatch.setattr(adapter, "_client", lambda: client)

    out = await adapter.complete("say hi")
    assert out == "hello"
    client.close.assert_awaited_once()  # client is always closed
    # Non-json call must NOT request a json response_format.
    _, kwargs = client.chat.completions.create.call_args
    assert "response_format" not in kwargs
    assert kwargs["model"] == "gpt-4o-mini"


async def test_complete_json_mode_sets_response_format(monkeypatch):
    adapter = AzureLLMAdapter(endpoint="https://x.openai.azure.com", deployment="d", api_key="k")
    client = _fake_client('{"items": []}')
    monkeypatch.setattr(adapter, "_client", lambda: client)

    out = await adapter.complete("draft a scoring checklist", json_mode=True)
    assert out == '{"items": []}'
    _, kwargs = client.chat.completions.create.call_args
    assert kwargs["response_format"] == {"type": "json_object"}


async def test_complete_handles_none_content(monkeypatch):
    adapter = AzureLLMAdapter(endpoint="https://x.openai.azure.com", deployment="d")
    client = _fake_client(None)  # API can return null content
    monkeypatch.setattr(adapter, "_client", lambda: client)
    assert await adapter.complete("x") == ""


def test_register_azure_llm_wires_adapter(monkeypatch):
    from app.config import get_settings
    from app.services.agents import registry

    s = get_settings()
    monkeypatch.setattr(s, "azure_openai_endpoint", "https://x.openai.azure.com")
    monkeypatch.setattr(s, "azure_openai_deployment", "gpt-4o-mini")
    monkeypatch.setattr(s, "azure_openai_api_key", "k")
    registry._LLM_ADAPTERS.pop("azure_openai", None)

    registry._register_azure_llm()
    assert "azure_openai" in registry._LLM_ADAPTERS
    assert registry.get_llm_adapter("azure_openai").name == "azure_openai"

    registry._LLM_ADAPTERS.pop("azure_openai", None)  # cleanup for other tests


def test_register_azure_llm_noop_when_unconfigured(monkeypatch):
    from app.config import get_settings
    from app.services.agents import registry

    s = get_settings()
    monkeypatch.setattr(s, "azure_openai_endpoint", "")
    monkeypatch.setattr(s, "azure_openai_deployment", "")
    registry._LLM_ADAPTERS.pop("azure_openai", None)

    registry._register_azure_llm()
    assert "azure_openai" not in registry._LLM_ADAPTERS
