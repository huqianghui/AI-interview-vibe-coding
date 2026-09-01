"""Config service: read/write the master AI Foundry ``ServiceConfig`` row.

The master row is the runtime source of truth for Azure endpoint/key/project/model. The API key is
Fernet-encrypted at rest (see ``app.utils.encryption``); callers get either the decrypted value
(for the overlay / connection test) or a masked value (for API responses) — never the raw token.

Right-sized to a single master row (no per-service toggle rows). See
``app.services.config_overlay`` for how the saved row is applied to the settings singleton.
"""

from urllib.parse import urlparse

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.service_config import ServiceConfig
from app.utils.encryption import decrypt_value, encrypt_value

MASTER_SERVICE_NAME = "ai_foundry"
MASTER_DISPLAY_NAME = "Azure AI Foundry"

# The endpoint is where the saved API key gets sent (agent sync, Voice Live, the /test probe). An
# admin who could point it at an arbitrary host could exfiltrate the decrypted key or probe internal
# addresses (metadata IPs). Restrict it to first-party Azure hosts. Suffixes cover the resource
# shapes this app talks to: Foundry project, Azure OpenAI, Cognitive Services, AI Search.
_ALLOWED_ENDPOINT_SUFFIXES = (
    ".services.ai.azure.com",
    ".openai.azure.com",
    ".cognitiveservices.azure.com",
    ".search.windows.net",
)


class InvalidEndpointError(ValueError):
    """Raised when a configured endpoint is not an https first-party Azure host."""


def validate_endpoint(endpoint: str) -> str:
    """Return the endpoint unchanged if it's https + an allowlisted Azure host; else raise.

    Empty is allowed (clears the config). Anything else must be https and its host must end with an
    approved Azure suffix — this is the guardrail against key-exfil / SSRF via a swapped endpoint.
    """
    if not endpoint:
        return endpoint
    parsed = urlparse(endpoint)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not host:
        raise InvalidEndpointError("Endpoint must be an https URL.")
    if not any(host == s.lstrip(".") or host.endswith(s) for s in _ALLOWED_ENDPOINT_SUFFIXES):
        allowed = ", ".join(_ALLOWED_ENDPOINT_SUFFIXES)
        raise InvalidEndpointError(
            f"Endpoint host {host!r} is not an allowed Azure host "
            f"(must end with one of: {allowed})."
        )
    return endpoint


def mask_key(plaintext: str) -> str:
    """Mask a secret for display: keep the last 4 chars, star the rest. Empty stays empty."""
    if not plaintext:
        return ""
    if len(plaintext) <= 4:
        return "****"
    return "****" + plaintext[-4:]


async def get_master_config(db: AsyncSession) -> ServiceConfig | None:
    """Return the master AI Foundry config row, or None if never configured."""
    result = await db.execute(
        select(ServiceConfig).where(ServiceConfig.service_name == MASTER_SERVICE_NAME)
    )
    return result.scalar_one_or_none()


async def get_decrypted_key(db: AsyncSession) -> str:
    """Return the decrypted master API key, or empty string when unset/unconfigured."""
    master = await get_master_config(db)
    if master is None:
        return ""
    return decrypt_value(master.api_key_encrypted)


async def resolve_foundry_connection(db: AsyncSession) -> tuple[str, str, str, str]:
    """Resolve ``(endpoint, project, api_key, model)`` for Foundry discovery calls.

    The admin-saved ``service_configs`` master row is the source of truth WHEN PRESENT. But a fresh
    deploy (or dev machine) often has real Foundry creds only in ``.env`` and no saved row yet — in
    that case the discovery endpoints (model-deployment list, KB connection/knowledge-base list)
    must still work. So: prefer the DB master row; fall back field-by-field to ``get_settings()``
    (the ``.env`` values) when the row is absent or a field is blank. Returns empty strings only
    when neither source has a value (callers then degrade to an empty list, never error).
    """
    # Imported here (not at module top) to avoid a settings import cycle at load time.
    from app.config import get_settings

    settings = get_settings()
    master = await get_master_config(db)

    endpoint = (
        (master.endpoint if master else "")
        or settings.azure_foundry_endpoint
        or (settings.foundry_project_endpoint)
    )
    project = (master.default_project if master else "") or settings.azure_foundry_default_project
    api_key = (
        (await get_decrypted_key(db)) or settings.azure_foundry_api_key or settings.foundry_api_key
    )
    model = (master.model_or_deployment if master else "") or settings.foundry_agent_model
    return endpoint, project, api_key, model


async def upsert_master_config(
    db: AsyncSession,
    *,
    endpoint: str,
    api_key: str,
    default_project: str,
    model_or_deployment: str,
    updated_by: str,
    knowledge_base: str = "",
    knowledge_source: str = "",
) -> ServiceConfig:
    """Create or update the master AI Foundry row.

    A non-empty ``api_key`` is encrypted and stored; an empty ``api_key`` PRESERVES the existing
    encrypted key (so re-saving other fields from the masked UI never wipes the secret). Saving
    always marks the row active.
    """
    # Validate the endpoint BEFORE any mutation — a swapped endpoint + preserved key is the
    # key-exfil path (P1). Raises InvalidEndpointError (→ 422 at the API) on a non-Azure host.
    validate_endpoint(endpoint)

    master = await get_master_config(db)
    if master is None:
        master = ServiceConfig(
            service_name=MASTER_SERVICE_NAME,
            display_name=MASTER_DISPLAY_NAME,
            is_master=True,
        )
        db.add(master)

    master.endpoint = endpoint
    master.default_project = default_project
    master.model_or_deployment = model_or_deployment
    master.knowledge_base = knowledge_base
    master.knowledge_source = knowledge_source
    master.is_active = True
    master.updated_by = updated_by
    if api_key:
        master.api_key_encrypted = encrypt_value(api_key)

    await db.flush()
    return master


async def seed_master_config_from_env(db: AsyncSession) -> ServiceConfig | None:
    """Create the master config row from ``.env``/deployment env when none exists yet.

    The ``service_configs`` table lives in the deployment's **ephemeral SQLite**, so a saved config
    is wiped on every restart even though the real connection env vars (``AZURE_FOUNDRY_ENDPOINT`` /
    ``FOUNDRY_AGENT_MODEL`` / …) persist on the Container App. Runtime calls already fall back to
    env (see ``resolve_foundry_connection`` / the settings overlay), so the connection *works* — but
    the admin ``/admin/config`` panel reads only this row and would show "not configured" after
    every boot. Seeding the row from env on boot makes the panel reflect the live runtime config.

    Idempotent and non-destructive: a **no-op when a master row already exists** (never clobbers an
    operator's saved config), and a no-op when env carries no Foundry endpoint (public-demo / mock
    deploys stay unconfigured, exactly as before). Best-effort — callers wrap it so a failure never
    blocks startup. Does not set an API key: the deployment authenticates to Foundry via managed
    identity (keyless), so the row is seeded key-less and ``resolve``/overlay supply creds
    Entra-first.
    """
    from app.config import get_settings

    master = await get_master_config(db)
    if master is not None:
        # Operator (or a prior boot) already seeded it — leave it untouched.
        return master

    settings = get_settings()
    endpoint = settings.azure_foundry_endpoint or settings.foundry_project_endpoint
    if not endpoint:
        # No real Foundry configured (mock/public-demo) — nothing to seed.
        return None

    master = ServiceConfig(
        service_name=MASTER_SERVICE_NAME,
        display_name=MASTER_DISPLAY_NAME,
        is_master=True,
        endpoint=endpoint,
        default_project=settings.azure_foundry_default_project,
        model_or_deployment=settings.foundry_agent_model,
        is_active=True,
        updated_by="boot-seed",
    )
    db.add(master)
    await db.flush()
    return master
