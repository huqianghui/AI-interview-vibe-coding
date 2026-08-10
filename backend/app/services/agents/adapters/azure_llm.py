"""Azure OpenAI LLM adapter — real chat completions for scoring + checklist drafting (F3/F4).

Implements the ``LLMAdapter`` protocol (``app.services.agents.base``): ``complete(prompt, *,
json_mode)`` runs an Azure OpenAI chat completion on the configured deployment and returns the raw
content string (a JSON string when ``json_mode`` — callers ``json.loads`` it). This is what replaces
the mock so a "scored" report reflects a real model judgment, not canned numbers.

Auth mirrors ``azure_agent_sync``: **API key first** (``AsyncAzureOpenAI(api_key=...)``), Entra
fallback via ``azure_ad_token_provider`` (``DefaultAzureCredential``, Cognitive Services scope) when
no key is set. api-version is pinned to the scoring value from SPEC §3 (2024-06-01).

Only registered when an endpoint + deployment are configured (see ``registry._register_azure_llm``),
so mock-only environments never construct a live client. Coverage-omitted (``azure_*.py``) like the
other live adapters — exercised against real Azure, not CI.
"""

from collections.abc import AsyncIterator

_COGNITIVE_SCOPE = "https://cognitiveservices.azure.com/.default"
_API_VERSION = "2024-06-01"


class AzureLLMAdapter:
    """LLMAdapter backed by Azure OpenAI chat completions."""

    # Matches the `DEFAULT_LLM_PROVIDER=azure_openai` convention + the azure_openai_* settings.
    name = "azure_openai"

    def __init__(self, *, endpoint: str, deployment: str, api_key: str = "") -> None:
        self._endpoint = endpoint
        self._deployment = deployment
        self._api_key = api_key

    def _client(self):
        """Build an AsyncAzureOpenAI client: API key if present, else Entra token provider."""
        from openai import AsyncAzureOpenAI

        if self._api_key:
            return AsyncAzureOpenAI(
                azure_endpoint=self._endpoint,
                api_key=self._api_key,
                api_version=_API_VERSION,
                timeout=30.0,
            )
        # Keyless: refreshing Entra token provider (avoids 401 on long-lived processes).
        from azure.identity import DefaultAzureCredential, get_bearer_token_provider

        token_provider = get_bearer_token_provider(DefaultAzureCredential(), _COGNITIVE_SCOPE)
        return AsyncAzureOpenAI(
            azure_endpoint=self._endpoint,
            azure_ad_token_provider=token_provider,
            api_version=_API_VERSION,
            timeout=30.0,
        )

    async def complete(self, prompt: str, *, json_mode: bool = False) -> str:
        """Return the model's completion text; a JSON string when ``json_mode`` is set."""
        client = self._client()
        kwargs: dict = {
            "model": self._deployment,
            "messages": [{"role": "user", "content": prompt}],
        }
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        try:
            resp = await client.chat.completions.create(**kwargs)
            return resp.choices[0].message.content or ""
        finally:
            await client.close()

    async def stream(self, prompt: str) -> AsyncIterator[str]:
        """Stream completion chunks. No caller in app/ today; provided for protocol completeness."""
        client = self._client()
        try:
            stream = await client.chat.completions.create(
                model=self._deployment,
                messages=[{"role": "user", "content": prompt}],
                stream=True,
            )
            async for chunk in stream:
                if chunk.choices and chunk.choices[0].delta.content:
                    yield chunk.choices[0].delta.content
        finally:
            await client.close()
