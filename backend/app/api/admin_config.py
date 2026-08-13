"""Admin Azure config editor — the runtime source of truth for the AI Foundry connection.

An operator enters the AI Foundry endpoint / API key / project / model here; it's saved (key
encrypted) to the ``service_configs`` master row and overlaid onto the settings singleton so it
takes effect immediately (no restart) — see ``app.services.config_overlay``. This is what lets
production read the user's own config instead of ``.env``.

All routes require an admin JWT (``require_role("admin")`` — Phase 1 auth, same guard as the other
admin routers). The API key is write-only: responses return only a masked value, never the token.
"""

import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.dependencies import require_role
from app.services import config_service
from app.services.agents import foundry_connections
from app.services.config_overlay import apply_master_config_to_settings
from app.services.config_service import InvalidEndpointError

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/admin/config", tags=["admin-config"], dependencies=[Depends(require_role("admin"))]
)


class AiFoundryConfigIn(BaseModel):
    endpoint: str = Field(default="", max_length=500)
    # Write-only. Empty preserves the existing stored key (so saving from the masked UI is safe).
    api_key: str = ""
    default_project: str = Field(default="", max_length=200)
    model_or_deployment: str = Field(default="", max_length=100)
    knowledge_base: str = Field(default="", max_length=200)
    knowledge_source: str = Field(default="", max_length=200)


class AiFoundryConfigOut(BaseModel):
    endpoint: str
    masked_key: str
    default_project: str
    model_or_deployment: str
    knowledge_base: str
    knowledge_source: str
    is_active: bool


class ConnectionTestResult(BaseModel):
    success: bool
    message: str


class Option(BaseModel):
    value: str
    label: str


def _to_out(master, masked_key: str) -> AiFoundryConfigOut:
    if master is None:
        return AiFoundryConfigOut(
            endpoint="",
            masked_key="",
            default_project="",
            model_or_deployment="",
            knowledge_base="",
            knowledge_source="",
            is_active=False,
        )
    return AiFoundryConfigOut(
        endpoint=master.endpoint,
        masked_key=masked_key,
        default_project=master.default_project,
        model_or_deployment=master.model_or_deployment,
        knowledge_base=master.knowledge_base,
        knowledge_source=master.knowledge_source,
        is_active=master.is_active,
    )


@router.get("/ai-foundry", response_model=AiFoundryConfigOut)
async def get_ai_foundry_config(db: AsyncSession = Depends(get_db)) -> AiFoundryConfigOut:
    """Return the saved master AI Foundry config with a masked key (empty if never configured)."""
    master = await config_service.get_master_config(db)
    key = await config_service.get_decrypted_key(db)
    return _to_out(master, config_service.mask_key(key))


@router.put("/ai-foundry", response_model=AiFoundryConfigOut)
async def update_ai_foundry_config(
    body: AiFoundryConfigIn, db: AsyncSession = Depends(get_db)
) -> AiFoundryConfigOut:
    """Save the master config, commit, then overlay it onto settings so it takes effect now."""
    try:
        master = await config_service.upsert_master_config(
            db,
            endpoint=body.endpoint,
            api_key=body.api_key,
            default_project=body.default_project,
            model_or_deployment=body.model_or_deployment,
            knowledge_base=body.knowledge_base,
            knowledge_source=body.knowledge_source,
            updated_by="admin",
        )
    except InvalidEndpointError as exc:
        # Reject a non-Azure endpoint (key-exfil / SSRF guard) as a 422, without touching the row.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc
    await db.commit()
    await db.refresh(master)

    # Apply immediately (overlay onto settings + re-register azure adapters).
    await apply_master_config_to_settings(db)

    key = await config_service.get_decrypted_key(db)
    return _to_out(master, config_service.mask_key(key))


@router.post("/ai-foundry/test", response_model=ConnectionTestResult)
async def test_ai_foundry_config(db: AsyncSession = Depends(get_db)) -> ConnectionTestResult:
    """Lightweight connectivity probe against the saved endpoint/key.

    Lists deployments on the Azure OpenAI endpoint — enough to prove the endpoint + key are valid
    without needing a specific model. Never raises: returns a structured pass/fail either way.
    """
    master = await config_service.get_master_config(db)
    if master is None or not master.endpoint:
        return ConnectionTestResult(success=False, message="AI Foundry not configured.")
    api_key = await config_service.get_decrypted_key(db)
    if not api_key:
        return ConnectionTestResult(success=False, message="No API key saved.")

    base = master.endpoint.rstrip("/")
    url = f"{base}/openai/deployments?api-version=2024-10-21"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, headers={"api-key": api_key})
        if resp.status_code == 200:
            return ConnectionTestResult(success=True, message="Connection succeeded.")
        return ConnectionTestResult(success=False, message=f"Endpoint returned {resp.status_code}.")
    except httpx.HTTPError as exc:
        return ConnectionTestResult(success=False, message=f"Connection failed: {exc}")


@router.get("/ai-foundry/model-deployments", response_model=list[Option])
async def list_model_deployments(db: AsyncSession = Depends(get_db)) -> list[Option]:
    """List the resource's real model deployments for the config-page dropdown.

    Tries the AI Foundry project-scoped deployments API, then the legacy Azure OpenAI deployments
    API, then falls back to the saved model. Fail-soft: any error → saved model or []; never 500.
    """
    # Resolve from the saved master row, falling back to .env when no row exists yet (a fresh
    # deploy has creds only in .env). Without this fallback the dropdown is empty on day one.
    endpoint, project, api_key, model = await config_service.resolve_foundry_connection(db)
    if endpoint and api_key:
        base = endpoint.rstrip("/")
        headers = {"api-key": api_key}
        async with httpx.AsyncClient(timeout=10.0) as client:
            if project:
                try:
                    url = f"{base}/api/projects/{project}/deployments?api-version=v1"
                    r = await client.get(url, headers=headers)
                    if r.status_code == 200:
                        body = r.json()
                        items = body.get("data", body.get("value", []))
                        out = [
                            Option(value=d["name"], label=f"{d['name']} ({d.get('modelName', '')})")
                            for d in items
                            if d.get("name")
                        ]
                        if out:
                            return out
                except (httpx.HTTPError, KeyError, ValueError) as exc:
                    logger.warning("Foundry deployments API failed: %s", exc)
            try:
                url = f"{base}/openai/deployments?api-version=2024-10-21"
                r = await client.get(url, headers=headers)
                if r.status_code == 200:
                    return [
                        Option(value=d["id"], label=f"{d['id']} ({d.get('model', '')})")
                        for d in r.json().get("data", [])
                        if d.get("id")
                    ]
            except (httpx.HTTPError, KeyError, ValueError) as exc:
                logger.warning("Azure OpenAI deployments API failed: %s", exc)
    # Last resort: the configured model name (from DB or .env) as a single option.
    if model:
        return [Option(value=model, label=model)]
    return []


@router.get("/ai-foundry/knowledge-bases", response_model=list[Option])
async def list_knowledge_bases(db: AsyncSession = Depends(get_db)) -> list[Option]:
    """List the resource's Foundry IQ knowledge bases for the config-page dropdown.

    Delegates to :func:`foundry_connections.list_knowledge_bases` (Phase 2.2) — the shared
    discovery path (resolve the AI Search connection via the project client, then call the Search
    data-plane API with Entra-first / api-key-fallback auth). Fail-soft: any error → []; never 500.
    """
    endpoint, project, api_key, _model = await config_service.resolve_foundry_connection(db)
    if not endpoint:
        return []
    kbs = await foundry_connections.list_knowledge_bases(
        endpoint=endpoint, project=project, api_key=api_key
    )
    return [
        Option(value=kb["name"], label=kb.get("description") or kb["name"])
        for kb in kbs
        if kb.get("name")
    ]
