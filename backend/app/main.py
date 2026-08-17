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

    Finally, pre-warms the cached Entra credential in the BACKGROUND so the first Voice Live
    connect doesn't pay the 1-3s DefaultAzureCredential chain walk (env → IMDS/managed identity →
    az CLI) inline — a fire-and-forget task, so a slow/absent credential never delays boot.
    """
    import asyncio

    from app.db import async_session_factory
    from app.services.config_overlay import apply_master_config_to_settings
    from app.services.question_seed import seed_default_bank
    from app.services.user_seed import seed_default_admin

    try:
        async with async_session_factory() as session:
            await seed_default_bank(session)
    except Exception:  # noqa: BLE001 — seeding is best-effort; never block startup
        pass
    try:
        async with async_session_factory() as session:
            await seed_default_admin(session)
    except Exception:  # noqa: BLE001 — admin seed is best-effort; never block startup
        pass
    try:
        async with async_session_factory() as session:
            await apply_master_config_to_settings(session)
    except Exception:  # noqa: BLE001 — config overlay is best-effort; never block startup
        pass

    prewarm_task = asyncio.create_task(_prewarm_azure_credential())
    try:
        yield
    finally:
        # Don't leave a dangling task on shutdown; cancel if the pre-warm hasn't finished.
        if not prewarm_task.done():
            prewarm_task.cancel()


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
