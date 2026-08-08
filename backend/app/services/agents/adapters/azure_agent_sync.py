"""Foundry prompt-agent sync for interviewer personas (SPEC F5) — coverage-omitted.

Ported from the reference ``agent_sync_service``. Registers only when the ``azure`` extra +
a Foundry project endpoint are present; CI + local dev never import ``azure-ai-projects``.

Key contract facts (learned the hard way in the reference):

- Foundry agents are **immutable** — "update" means ``agents.create_version`` with a new version.
- **Creating a brand-new agent requires Entra ID** (``DefaultAzureCredential``). API-key auth
  returns HTTP 500 on create. So on a 500 we probe ``agents.get``: if the agent already exists
  (e.g. pre-created in the Portal) we fall back to an update; otherwise we surface a clear error
  telling the operator to pre-create it. API key is fine for read/update/delete of existing agents.
- The Voice Live metadata SHAPE is owned by the pure, CI-tested ``voice_live_metadata`` builder —
  this module only transports it. That split is why the demo-critical snake_case invariant is
  verified without a live Azure call (see docs/SPIKE-F1-foundry-iq.md Trigger C).

The SDK is synchronous; every call is wrapped in ``asyncio.to_thread`` so it never blocks the
event loop.
"""

import asyncio
import time
from typing import Any

from app.services.agents.voice_live_metadata import build_voice_live_metadata

# Entra scope used to probe for a usable DefaultAzureCredential before falling back to API key.
_FOUNDRY_SCOPE = "https://ai.azure.com/.default"
_MODEL_ENV_DEFAULT = "gpt-4o"


class AgentSyncError(RuntimeError):
    """Raised when a persona cannot be synced to a Foundry prompt agent."""


class _ApiKeyTokenCredential:
    """Minimal TokenCredential stub so AIProjectClient accepts API-key auth.

    The SDK constructor requires a ``get_token`` method; real request auth is handled by the
    AzureKeyCredentialPolicy header, so this only needs to return a well-formed AccessToken.
    """

    def __init__(self, api_key: str) -> None:
        self._api_key = api_key

    def get_token(self, *scopes: str, **kwargs: Any) -> Any:
        from azure.core.credentials import AccessToken

        # Far-future expiry; the token itself is never sent (header policy carries the key).
        return AccessToken(self._api_key, int(time.time()) + 3600)


class AzureAgentSyncAdapter:
    """Creates/updates the Foundry prompt agent backing an interviewer persona."""

    name = "azure"

    def __init__(
        self, *, endpoint: str, model: str = _MODEL_ENV_DEFAULT, api_key: str = ""
    ) -> None:
        self._endpoint = endpoint
        self._model = model
        self._api_key = api_key

    # -- public API ---------------------------------------------------------

    async def sync_persona(self, persona: Any, *, locale: str | None = None) -> dict[str, str]:
        """Create or update the persona's agent; return ``{agent_id, agent_version}``.

        ``persona.name`` is the stable agent name (Foundry versions are ``name:version``); the
        instructions come from ``persona.prompt_fragment``; the voice config rides in metadata.
        """
        agent_name = self._agent_name(persona)
        instructions = persona.prompt_fragment or f"You are {persona.name}, an interviewer."
        metadata = build_voice_live_metadata(persona, locale=locale, modified_at=int(time.time()))

        client = self._project_client()
        try:
            result = await self._create_version(client, agent_name, instructions, metadata)
        except Exception as exc:  # noqa: BLE001 — normalize any SDK error into a recovery attempt
            result = await self._recover_or_raise(client, agent_name, instructions, metadata, exc)

        return {
            "agent_id": str(result.get("id") or agent_name),
            "agent_version": str(result.get("version") or ""),
        }

    async def delete_persona_agent(self, persona: Any) -> None:
        """Best-effort delete of the persona's Foundry agent (used when a persona is removed)."""
        client = self._project_client()
        await asyncio.to_thread(client.agents.delete, agent_name=self._agent_name(persona))

    # -- internals ----------------------------------------------------------

    def _agent_name(self, persona: Any) -> str:
        return f"interviewer-{persona.id}"

    async def _create_version(
        self, client: Any, agent_name: str, instructions: str, metadata: dict[str, str]
    ) -> dict[str, Any]:
        from azure.ai.projects.models import PromptAgentDefinition

        created = await asyncio.to_thread(
            client.agents.create_version,
            agent_name=agent_name,
            definition=PromptAgentDefinition(model=self._model, instructions=instructions),
            metadata=metadata,
        )
        return {
            "id": getattr(created, "id", agent_name),
            "version": getattr(created, "version", ""),
        }

    async def _recover_or_raise(
        self,
        client: Any,
        agent_name: str,
        instructions: str,
        metadata: dict[str, str],
        original: Exception,
    ) -> dict[str, Any]:
        """On a create failure, if the agent already exists, retry as an update; else raise.

        This mirrors the reference's 500-on-create handling: API-key auth cannot create a new
        agent, but can update one pre-created in the Portal.
        """
        try:
            existing = await asyncio.to_thread(client.agents.get, agent_name=agent_name)
        except Exception:  # noqa: BLE001 — agent genuinely absent → the original error stands
            existing = None
        if existing is None:
            raise AgentSyncError(
                f"Could not create agent {agent_name!r}: {original}. "
                "Creating a new agent requires Entra ID (DefaultAzureCredential); "
                "with API-key auth, pre-create the agent in the Foundry Portal first."
            ) from original
        # Agent exists — a new version (update) is allowed under API-key auth.
        return await self._create_version(client, agent_name, instructions, metadata)

    def _project_client(self) -> Any:
        from azure.ai.projects import AIProjectClient

        # 1) Prefer Entra ID — required to create new agents.
        try:
            from azure.identity import DefaultAzureCredential

            credential = DefaultAzureCredential()
            credential.get_token(_FOUNDRY_SCOPE)  # probe; raises if unusable
            return AIProjectClient(endpoint=self._endpoint, credential=credential)
        except Exception:  # noqa: BLE001 — fall through to API key
            pass

        # 2) Fall back to API key (read/update/delete of existing agents only).
        if self._api_key:
            from azure.core.credentials import AzureKeyCredential
            from azure.core.pipeline.policies import AzureKeyCredentialPolicy

            # AIProjectClient's constructor type-checks for a TokenCredential (needs get_token).
            # Real auth happens via the AzureKeyCredentialPolicy header; this stub only satisfies
            # the constructor (ported from the reference's _ApiKeyTokenCredential).
            return AIProjectClient(
                endpoint=self._endpoint,
                credential=_ApiKeyTokenCredential(self._api_key),
                authentication_policy=AzureKeyCredentialPolicy(
                    credential=AzureKeyCredential(self._api_key), name="api-key"
                ),
            )
        raise AgentSyncError(
            "No usable Foundry credential: DefaultAzureCredential failed and no API key set."
        )
