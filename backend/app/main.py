"""FastAPI application entrypoint."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api import (
    admin_checklist,
    admin_config,
    admin_personas,
    admin_questions,
    admin_sop,
    admin_users,
    auth,
    candidate_session,
    health,
    interview,
    voice_live_ws,
)
from app.config import get_settings

settings = get_settings()


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Seed the demo default question bank on boot (idempotent, best-effort).

    A no-op when a default bank already exists, so it's safe on every start. Wrapped so a seed
    failure (e.g. tables not yet migrated in an unusual boot order) never blocks app startup.

    Also overlays the saved DB master AI Foundry config onto settings (DB > .env > code default)
    so a previously-saved config is live on boot — also best-effort, never blocks startup.

    Seeds the default interviewer persona (fixed id → reuses one stable Foundry agent, never an
    orphan per boot) so voice works and the editor auto-selects it out of the box — its Foundry sync
    runs in the BACKGROUND (below) so a slow/absent Foundry never delays boot.

    Finally, pre-warms the cached Entra credential in the BACKGROUND so the first Voice Live
    connect doesn't pay the 1-3s DefaultAzureCredential chain walk (env → IMDS/managed identity →
    az CLI) inline — a fire-and-forget task, so a slow/absent credential never delays boot.
    """
    import asyncio

    from app.db import async_session_factory
    from app.services.config_overlay import apply_master_config_to_settings
    from app.services.config_service import seed_master_config_from_env
    from app.services.persona_seed import seed_default_persona
    from app.services.question_seed import seed_bundled_banks, seed_default_bank
    from app.services.user_seed import seed_default_admin

    try:
        async with async_session_factory() as session:
            await seed_default_bank(session)
    except Exception:  # noqa: BLE001 — seeding is best-effort; never block startup
        pass
    try:
        # Import the committed generic bank bundles (Demo / Deployment SOP / test) alongside the
        # default, so the ephemeral server presents the same multi-bank catalogue as a local
        # checkout. Idempotent-by-name; each bundle is non-default so it never fights the boot
        # importer's rf-CSM default. Separate try: a bad bundle must not block the rest of startup.
        async with async_session_factory() as session:
            await seed_bundled_banks(session)
    except Exception:  # noqa: BLE001 — bundle seed is best-effort; never block startup
        pass
    try:
        async with async_session_factory() as session:
            await seed_default_admin(session)
    except Exception:  # noqa: BLE001 — admin seed is best-effort; never block startup
        pass
    try:
        async with async_session_factory() as session:
            await seed_default_persona(session)
    except Exception:  # noqa: BLE001 — persona seed is best-effort; never block startup
        pass
    try:
        async with async_session_factory() as session:
            # Seed the master AI Foundry row from env when absent (ephemeral SQLite wiped it), so
            # the /admin/config panel reflects the live runtime config after a restart. No-op when
            # a row already exists (operator's saved config) or when env has no Foundry endpoint.
            await seed_master_config_from_env(session)
            await session.commit()
    except Exception:  # noqa: BLE001 — config seed is best-effort; never block startup
        pass
    try:
        async with async_session_factory() as session:
            await apply_master_config_to_settings(session)
    except Exception:  # noqa: BLE001 — config overlay is best-effort; never block startup
        pass

    prewarm_task = asyncio.create_task(_prewarm_azure_credential())
    persona_sync_task = asyncio.create_task(_sync_default_persona())
    try:
        yield
    finally:
        # Don't leave dangling tasks on shutdown; cancel any that haven't finished.
        for task in (prewarm_task, persona_sync_task):
            if not task.done():
                task.cancel()


async def _prewarm_azure_credential() -> None:
    """Probe the cached async Entra credential once so the first Voice Live connect is warm.

    Best-effort and background-only: any failure (no az login, no managed identity, azure-identity
    absent) is swallowed — the Voice Live proxy still resolves credentials Entra-first at connect
    time and falls back to an API key. This only moves the one-time cost off the critical path.
    """
    try:
        from app.services.azure_auth import (
            COGNITIVE_SERVICES_SCOPE,
            get_azure_credential_cached,
        )

        credential = get_azure_credential_cached()
        if credential is not None:
            await credential.get_token(COGNITIVE_SERVICES_SCOPE)
    except Exception:  # noqa: BLE001 — pre-warm is best-effort; never surface at startup
        pass


async def _sync_default_persona() -> None:
    """Sync the seeded default persona to Foundry in the background (never blocks boot).

    Voice's P5 gate needs ``agent_sync_status == "synced"``, so the seeded definition must be synced
    for the digital human to speak. Best-effort: any failure (no Foundry creds, network) leaves the
    persona ``failed`` — voice degrades to text — and is swallowed here. No-op when already synced.
    """
    try:
        from app.db import async_session_factory
        from app.services.persona_seed import sync_default_persona

        async with async_session_factory() as session:
            await sync_default_persona(session)
    except Exception:  # noqa: BLE001 — background sync is best-effort; never surface at startup
        pass


app = FastAPI(title=settings.app_name, debug=settings.debug, lifespan=lifespan)

app.include_router(health.router)
app.include_router(candidate_session.router)
app.include_router(interview.router)
app.include_router(admin_personas.router)
app.include_router(admin_sop.router)
app.include_router(admin_checklist.router)
app.include_router(admin_questions.router)
app.include_router(auth.router)
app.include_router(admin_users.router)
app.include_router(admin_config.router)
app.include_router(voice_live_ws.router)
