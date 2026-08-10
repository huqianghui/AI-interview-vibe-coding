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
    candidate_session,
    health,
    interview,
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
    """
    from app.db import async_session_factory
    from app.services.config_overlay import apply_master_config_to_settings
    from app.services.question_seed import seed_default_bank

    try:
        async with async_session_factory() as session:
            await seed_default_bank(session)
    except Exception:  # noqa: BLE001 — seeding is best-effort; never block startup
        pass
    try:
        async with async_session_factory() as session:
            await apply_master_config_to_settings(session)
    except Exception:  # noqa: BLE001 — config overlay is best-effort; never block startup
        pass
    yield


app = FastAPI(title=settings.app_name, debug=settings.debug, lifespan=lifespan)

app.include_router(health.router)
app.include_router(candidate_session.router)
app.include_router(interview.router)
app.include_router(admin_personas.router)
app.include_router(admin_sop.router)
app.include_router(admin_checklist.router)
app.include_router(admin_questions.router)
app.include_router(admin_config.router)
