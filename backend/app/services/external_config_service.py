"""Config service for the external interview API/server (SPEC Phase 2, vendor-neutral).

Mirrors :mod:`app.services.config_service` (the master AI Foundry row) but for a **separate**
``ServiceConfig`` row, ``service_name='external_interviewer'``, holding the client interview
brain's connection: endpoint URL, Fernet-encrypted API key, and a static per-deployment
**user-tag prefix** (stored in ``default_project``) that is prepended to the anonymized session id
to form the gateway ``user`` field. The API key is encrypted at rest; callers get either the
decrypted value (for a live call / the /test probe) or a masked value (for API responses).

Endpoint validation differs from the master row: the external gateway is NOT a first-party Azure
host, so the Azure suffix allowlist does not apply. Instead we require https and reject obvious
SSRF targets (loopback / private / link-local IP literals, ``localhost``) so an admin cannot point
the saved key at the metadata IP or an internal address to exfiltrate it.

Vendor-neutral by owner directive: nothing here names a product — only "external interview
API/server". PUBLIC repo: schema/logic only; real endpoints/keys live in the DB or gitignored .env.
"""

import ipaddress
from urllib.parse import urlparse

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.service_config import ServiceConfig
from app.services.config_service import mask_key
from app.utils.encryption import decrypt_value, encrypt_value

EXTERNAL_SERVICE_NAME = "external_interviewer"
EXTERNAL_DISPLAY_NAME = "External Interview API"

# Re-exported so callers/tests import masking from one place regardless of which config they hold.
__all__ = [
    "EXTERNAL_SERVICE_NAME",
    "InvalidExternalEndpointError",
    "get_external_config",
    "get_decrypted_external_key",
    "mask_key",
    "resolve_external_connection",
    "seed_external_config_from_env",
    "upsert_external_config",
    "validate_external_endpoint",
]


class InvalidExternalEndpointError(ValueError):
    """Raised when the external endpoint is not an https URL or targets a blocked internal host."""


def validate_external_endpoint(endpoint: str) -> str:
    """Return the endpoint unchanged if it's a safe https URL; else raise.

    Empty is allowed (clears the config). Otherwise the URL must be https with a host, and — when
    the host is an IP literal — must not be loopback / private / link-local / reserved (the SSRF /
    metadata-exfil guard). A DNS hostname is allowed as-is: the external gateway is a public host we
    cannot allowlist by suffix, and resolving here would only add a TOCTOU gap.
    """
    if not endpoint:
        return endpoint
    parsed = urlparse(endpoint)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not host:
        raise InvalidExternalEndpointError("Endpoint must be an https URL.")
    if host == "localhost":
        raise InvalidExternalEndpointError("Endpoint host must not be localhost.")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        # Not an IP literal — a DNS hostname (the expected public-gateway shape). Allow.
        return endpoint
    if ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_reserved or ip.is_multicast:
        raise InvalidExternalEndpointError(
            f"Endpoint host {host!r} is a blocked internal/reserved address."
        )
    return endpoint


async def get_external_config(db: AsyncSession) -> ServiceConfig | None:
    """Return the external interview API config row, or None if never configured."""
    result = await db.execute(
        select(ServiceConfig).where(ServiceConfig.service_name == EXTERNAL_SERVICE_NAME)
    )
    return result.scalar_one_or_none()


async def get_decrypted_external_key(db: AsyncSession) -> str:
    """Return the decrypted external API key, or empty string when unset/unconfigured."""
    row = await get_external_config(db)
    if row is None:
        return ""
    return decrypt_value(row.api_key_encrypted)


async def resolve_external_connection(db: AsyncSession) -> tuple[str, str, str]:
    """Resolve ``(endpoint, api_key, user_tag)`` for external interview calls.

    The saved ``service_configs`` row is the source of truth WHEN PRESENT; a fresh deploy (or dev
    machine) may carry the connection only in ``.env``, so fall back field-by-field to
    ``get_settings()``. Returns empty strings only when neither source has a value (the runner then
    degrades to the mock provider rather than erroring).
    """
    from app.config import get_settings

    settings = get_settings()
    row = await get_external_config(db)

    endpoint = (row.endpoint if row else "") or settings.external_interviewer_endpoint
    api_key = (await get_decrypted_external_key(db)) or settings.external_interviewer_api_key
    user_tag = (row.default_project if row else "") or settings.external_interviewer_user_tag
    return endpoint, api_key, user_tag


async def upsert_external_config(
    db: AsyncSession,
    *,
    endpoint: str,
    api_key: str,
    user_tag: str,
    updated_by: str,
) -> ServiceConfig:
    """Create or update the external interview API config row.

    A non-empty ``api_key`` is encrypted and stored; an empty ``api_key`` PRESERVES the existing
    encrypted key (so re-saving other fields from the masked UI never wipes the secret). Validates
    the endpoint BEFORE any mutation — a swapped endpoint + preserved key is the key-exfil path.
    Saving always marks the row active.
    """
    validate_external_endpoint(endpoint)

    row = await get_external_config(db)
    if row is None:
        row = ServiceConfig(
            service_name=EXTERNAL_SERVICE_NAME,
            display_name=EXTERNAL_DISPLAY_NAME,
            is_master=False,
        )
        db.add(row)

    row.endpoint = endpoint
    # user-tag prefix rides in default_project (no dedicated column; the field is otherwise unused
    # for this non-Foundry row). Documented here so a reader isn't surprised by the reuse.
    row.default_project = user_tag
    row.is_active = True
    row.updated_by = updated_by
    if api_key:
        row.api_key_encrypted = encrypt_value(api_key)

    await db.flush()
    return row


async def seed_external_config_from_env(db: AsyncSession) -> ServiceConfig | None:
    """Create the external config row from ``.env``/deployment env when none exists yet.

    Mirrors ``config_service.seed_master_config_from_env``: the ``service_configs`` table lives in
    ephemeral SQLite (reseeded every boot), so seeding the row from env on boot makes the admin
    panel reflect the live runtime config after a restart. Idempotent and non-destructive: a no-op
    when a row already exists (never clobbers an operator's saved config) and a no-op when env
    carries no external endpoint (mock/CI deploys stay unconfigured). Best-effort — callers wrap it
    so a failure never blocks startup. Unlike the Foundry row, this DOES seed the API key from env
    (the external gateway authenticates by bearer key, not managed identity).
    """
    from app.config import get_settings

    row = await get_external_config(db)
    if row is not None:
        return row

    settings = get_settings()
    endpoint = settings.external_interviewer_endpoint
    if not endpoint:
        return None

    row = ServiceConfig(
        service_name=EXTERNAL_SERVICE_NAME,
        display_name=EXTERNAL_DISPLAY_NAME,
        is_master=False,
        endpoint=endpoint,
        default_project=settings.external_interviewer_user_tag,
        is_active=True,
        updated_by="boot-seed",
    )
    if settings.external_interviewer_api_key:
        row.api_key_encrypted = encrypt_value(settings.external_interviewer_api_key)
    db.add(row)
    await db.flush()
    return row
