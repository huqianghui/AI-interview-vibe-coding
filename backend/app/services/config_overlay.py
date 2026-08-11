"""Apply the DB master AI Foundry config onto the settings singleton at runtime.

This is what makes the precedence **DB > .env > code default** real. ``get_settings()`` is
``@lru_cache``d, so every module shares one ``Settings`` instance; overlaying the saved master row's
values onto that instance means every existing reader (registry at import, voice broker at request)
sees the DB values without any refactor. After overlaying, the Azure adapters are re-registered so a
saved config takes effect immediately — no restart.

Runs (a) at startup after migrations and (b) after each admin save. Best-effort at startup: a
missing table (first boot before migrate) or any error is swallowed so it never blocks boot.

Scope: the single master row maps to the **Foundry agent-sync** and **Voice Live** settings
(endpoint / key / project / model). LLM scoring and SOP retrieval use separate resources not carried
by this row, so their providers are left untouched here.
"""

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.services import config_service
from app.utils.encryption import decrypt_value

logger = logging.getLogger(__name__)


async def apply_master_config_to_settings(db: AsyncSession) -> bool:
    """Overlay the active master config onto settings + re-register adapters.

    Returns True when an active master row was applied, False otherwise (no row / inactive / error).
    """
    try:
        master = await config_service.get_master_config(db)
    except Exception:  # noqa: BLE001 — table may not exist yet on first boot
        logger.warning("Service config overlay skipped (table missing?)", exc_info=True)
        return False

    if master is None or not master.is_active or not master.endpoint:
        return False

    api_key = decrypt_value(master.api_key_encrypted)
    settings = get_settings()

    # Foundry agent-sync path: registry guards on foundry_project_endpoint and builds the
    # project-scoped URL from endpoint + project.
    settings.foundry_project_endpoint = master.endpoint
    settings.foundry_api_key = api_key
    settings.foundry_agent_model = master.model_or_deployment or settings.foundry_agent_model

    # Voice Live path (voice_broker reads these at request time).
    settings.azure_foundry_endpoint = master.endpoint
    settings.azure_foundry_api_key = api_key
    settings.azure_foundry_default_project = master.default_project
    settings.voice_live_default_model = (
        master.model_or_deployment or settings.voice_live_default_model
    )

    # SOP retrieval path (Foundry IQ). kb -> the URL path segment; ks -> the retrieve-body name.
    # Registry guards on endpoint/index/knowledge_source, so only overlay when kb+ks are set.
    if master.knowledge_base and master.knowledge_source:
        settings.azure_search_endpoint = master.endpoint
        settings.azure_search_api_key = api_key
        settings.azure_search_index = master.knowledge_base
        settings.azure_search_knowledge_source = master.knowledge_source

    # Flip the providers this row configures to their real adapters. The LLM provider drives scoring
    # + checklist drafting; Phase 5 backs it with the real Foundry Responses-API adapter (registered
    # as "azure" when the project endpoint is set), so a saved config scores against a real model.
    settings.default_voice_provider = "azure"
    settings.default_agent_sync_provider = "azure"
    settings.default_llm_provider = "azure"
    if master.knowledge_base and master.knowledge_source:
        settings.default_retrieval_provider = "azure"

    # Rebuild the Azure adapters against the freshly-overlaid settings.
    from app.services.agents.registry import refresh_azure_adapters

    refresh_azure_adapters()

    logger.info(
        "Applied master AI Foundry config (endpoint set, project=%s, model=%s, kb=%s)",
        master.default_project or "<none>",
        master.model_or_deployment or "<default>",
        master.knowledge_base or "<none>",
    )
    return True
