"""Admin editor for the external interview API/server connection (SPEC Phase 2, vendor-neutral).

An operator enters the external interview endpoint, a bearer API key, and a per-deployment user-tag
prefix here; it is saved (key Fernet-encrypted) to the separate ``service_configs`` row
(``service_name='external_interviewer'``) via :mod:`app.services.external_config_service`. Unlike
the master AI Foundry row, this connection has no settings overlay — the runner resolves it live
from the DB (with an env fallback) on every turn — so saving takes effect on the next interview
with no restart.

All routes require an admin JWT (``require_role("admin")`` — same guard as the other admin routers).
The API key is write-only on the main GET (masked value only). A SEPARATE, explicit reveal route
returns the plaintext for a deliberate click-to-reveal — it never logs the key. The test route
health-probes the endpoint WITHOUT creating any interview rows.

Vendor-neutral by owner directive: nothing here names a product — only "external interview API".
"""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.dependencies import require_role
from app.interview import external_runner
from app.services import external_config_service
from app.services.external_config_service import InvalidExternalEndpointError

router = APIRouter(
    prefix="/admin/external-interviewer",
    tags=["admin-external-config"],
    dependencies=[Depends(require_role("admin"))],
)


class ExternalConfigIn(BaseModel):
    endpoint: str = Field(default="", max_length=500)
    # Write-only. Empty preserves the existing stored key (so saving from the masked UI is safe).
    api_key: str = ""
    # Static per-deployment prefix prepended to the anonymized session id to form the gateway
    # ``user`` field. No PII — a deployment label only.
    user_tag: str = Field(default="", max_length=100)


class ExternalConfigOut(BaseModel):
    endpoint: str
    masked_key: str
    user_tag: str
    is_active: bool


class RevealedKeyOut(BaseModel):
    """The plaintext external API key, for a deliberate admin click-to-reveal. Never logged."""

    api_key: str


class ConnectionTestResult(BaseModel):
    success: bool
    message: str


def _to_out(row, masked_key: str) -> ExternalConfigOut:
    if row is None:
        return ExternalConfigOut(endpoint="", masked_key="", user_tag="", is_active=False)
    return ExternalConfigOut(
        endpoint=row.endpoint or "",
        masked_key=masked_key,
        # The user-tag prefix rides in default_project on this non-Foundry row (see the service).
        user_tag=row.default_project or "",
        is_active=row.is_active,
    )


@router.get("", response_model=ExternalConfigOut)
async def get_external_config(db: AsyncSession = Depends(get_db)) -> ExternalConfigOut:
    """Return the saved external interview config with a MASKED key (empty if never configured)."""
    row = await external_config_service.get_external_config(db)
    key = await external_config_service.get_decrypted_external_key(db)
    return _to_out(row, external_config_service.mask_key(key))


@router.put("", response_model=ExternalConfigOut)
async def update_external_config(
    body: ExternalConfigIn, db: AsyncSession = Depends(get_db)
) -> ExternalConfigOut:
    """Save the external interview config and commit. Takes effect on the next interview turn."""
    try:
        row = await external_config_service.upsert_external_config(
            db,
            endpoint=body.endpoint,
            api_key=body.api_key,
            user_tag=body.user_tag,
            updated_by="admin",
        )
    except InvalidExternalEndpointError as exc:
        # Reject a non-https / internal-host endpoint (SSRF / key-exfil guard) as 422; no mutation.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc
    await db.commit()
    await db.refresh(row)
    key = await external_config_service.get_decrypted_external_key(db)
    return _to_out(row, external_config_service.mask_key(key))


@router.get("/reveal", response_model=RevealedKeyOut)
async def reveal_external_key(db: AsyncSession = Depends(get_db)) -> RevealedKeyOut:
    """Return the PLAINTEXT external API key for a deliberate admin click-to-reveal.

    Separate from the masked GET so the plaintext is only ever sent on an explicit request. The key
    is never logged here (no logger call touches it); it travels only in this response body over the
    admin-JWT-guarded, HTTPS transport. Empty string when unconfigured.
    """
    key = await external_config_service.get_decrypted_external_key(db)
    return RevealedKeyOut(api_key=key)


@router.post("/test", response_model=ConnectionTestResult)
async def test_external_config(db: AsyncSession = Depends(get_db)) -> ConnectionTestResult:
    """Health-probe the saved external endpoint/key WITHOUT creating any interview rows.

    Delegates to :func:`external_runner.probe_connection`, which sends a single ``start`` turn with
    a ``{user_tag}-healthcheck`` user id and creates no ``InterviewSession``/``InterviewTurn``. It
    never raises: returns a structured pass/fail either way.
    """
    ok, detail = await external_runner.probe_connection(db)
    return ConnectionTestResult(success=ok, message=detail)
