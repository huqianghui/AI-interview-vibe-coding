"""Mock adapter + registry tests."""

import pytest

from app.services.agents.registry import get_llm_adapter, get_retrieval_adapter


@pytest.mark.asyncio
async def test_mock_llm_complete():
    adapter = get_llm_adapter("mock")
    assert adapter.name == "mock"
    text = await adapter.complete("hi")
    assert isinstance(text, str) and text


@pytest.mark.asyncio
async def test_mock_llm_json_mode():
    adapter = get_llm_adapter("mock")
    out = await adapter.complete("hi", json_mode=True)
    assert out.strip().startswith("{")


@pytest.mark.asyncio
async def test_mock_llm_stream():
    adapter = get_llm_adapter("mock")
    chunks = [c async for c in adapter.stream("hi")]
    assert "".join(chunks) == "This is a mock streamed response."


@pytest.mark.asyncio
async def test_mock_retrieval_citation_shape():
    adapter = get_retrieval_adapter("mock")
    citations = await adapter.retrieve_citations("what is the SOP?")
    assert citations, "mock should return at least one citation"
    for c in citations:
        assert set(c) == {"title", "url", "page"}


@pytest.mark.asyncio
async def test_retrieval_respects_max_citations():
    adapter = get_retrieval_adapter("mock")
    assert len(await adapter.retrieve_citations("q", max_citations=1)) == 1


def test_default_provider_is_mock():
    assert get_llm_adapter().name == "mock"
    assert get_retrieval_adapter().name == "mock"


def test_unknown_provider_raises():
    with pytest.raises(ValueError, match="Unknown LLM provider"):
        get_llm_adapter("nonexistent")


def test_configured_default_falls_back_to_mock(monkeypatch):
    # A configured default that isn't registered (e.g. azure_openai set in .env before the azure
    # LLM adapter is wired) must degrade to mock, not 500 every request. Explicit-name still raises.
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "default_llm_provider", "azure_openai")
    monkeypatch.setattr(get_settings(), "default_retrieval_provider", "azure")
    assert get_llm_adapter().name == "mock"
    assert get_retrieval_adapter().name == "mock"
