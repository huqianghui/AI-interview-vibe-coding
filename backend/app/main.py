"""FastAPI application entrypoint."""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.api import (
    admin_checklist,
    admin_config,
    admin_external_config,
    admin_interviews,
    admin_personas,
    admin_questions,
    admin_sop,
    admin_users,
    auth,
    candidate_history,
    candidate_session,
    health,
    interview,
    voice_live_ws,
)
from app.config import get_settings
from app.db import DatabaseUnavailableError

settings = get_settings()
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Run the idempotent boot seeds, then start the background warm-ups.

    Every seed is a no-op when its row already exists, so this is safe on every start. Each runs
    behind :func:`_best_effort`, so a failure (e.g. tables not yet migrated in an unusual boot
    order) is logged and never blocks app startup.

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
    from app.services.bank_version_service import publish_unversioned_banks
    from app.services.config_overlay import apply_master_config_to_settings
    from app.services.config_service import seed_master_config_from_env
    from app.services.external_config_service import seed_external_config_from_env
    from app.services.persona_seed import seed_default_persona
    from app.services.question_seed import (
        seed_bundled_banks,
        seed_client_banks,
        seed_default_bank,
    )
    from app.services.sop_file_repair import repair_missing_sop_files
    from app.services.user_seed import seed_default_admin, seed_default_candidates

    async def _seed_master_config(session) -> None:
        # Seed the master AI Foundry row from env when absent (ephemeral SQLite wiped it), so the
        # /admin/config panel reflects the live runtime config after a restart. No-op when a row
        # already exists (operator's saved config) or when env has no Foundry endpoint.
        await seed_master_config_from_env(session)
        await session.commit()

    async def _seed_external_config(session) -> None:
        # Same for the external-interview-brain row (Phase 2). Unlike Foundry, this DOES seed the
        # bearer key from env.
        await seed_external_config_from_env(session)
        await session.commit()

    # Each step gets its own session and its own failure boundary: a bad bundle or an unmigrated
    # table must not block the rest of startup, but it must not vanish either — a silently skipped
    # seed is how the server once came up with only the rubric-less demo bank.
    boot_steps = (
        # The committed generic bank bundles (Demo / Deployment SOP / test), so the server presents
        # the same catalogue as a local checkout. Each is non-default, so it never fights the boot
        # importer's rf-CSM default. Create-only: a bank that already exists is never replaced.
        # BEFORE the default bank: with nothing replaced any more, the rubric-carrying "Demo
        # interview bank" bundle must exist first so seed_default_bank promotes it rather than
        # creating the rubric-less programmatic one.
        ("bundled banks", seed_bundled_banks),
        # Client-derived bundles from the private-blob channel (CLIENT_BANKS_DIR). No-op when
        # absent (public-demo mode / CI). These carry client SOP quotes and are NEVER committed.
        ("client banks", seed_client_banks),
        # SOP rows whose stored bytes are gone (the pre-blob local disk did not survive revisions)
        # get them back from the originals in the client bundle. No-op once they live in blob.
        ("SOP file repair", repair_missing_sop_files),
        ("default bank", seed_default_bank),
        # After every bank writer above: a complete bank that has never been published gets v1, so
        # interviews on banks written straight to the draft (seeds, the client importer) are pinned.
        ("publish unversioned banks", publish_unversioned_banks),
        ("default admin", seed_default_admin),
        # #102: under the read-only Users tab this is the ONLY way candidate accounts come to exist,
        # so a failure here means nobody can take an interview until the next restart.
        ("candidate accounts", seed_default_candidates),
        ("default persona", seed_default_persona),
        ("master AI Foundry config", _seed_master_config),
        ("master config overlay", apply_master_config_to_settings),
        ("external interviewer config", _seed_external_config),
    )
    for label, step in boot_steps:
        await _best_effort(label, step, async_session_factory)

    prewarm_task = asyncio.create_task(_prewarm_azure_credential())
    persona_sync_task = asyncio.create_task(_sync_default_persona())
    # Issue #114: pre-build the judge/scoring LLM client in the background so the first judge call
    # after boot doesn't pay the cold credential probe inline (it timed out live at 8 s).
    from app.interview.judge import warm_adapter

    judge_warm_task = asyncio.create_task(warm_adapter())
    try:
        yield
    finally:
        # Don't leave dangling tasks on shutdown; cancel any that haven't finished.
        for task in (prewarm_task, persona_sync_task, judge_warm_task):
            if not task.done():
                task.cancel()


async def _best_effort(label: str, step, session_factory) -> None:
    """Run one boot step in its own session; log and carry on if it fails."""
    try:
        async with session_factory() as session:
            await step(session)
    except Exception:  # noqa: BLE001 — boot steps are best-effort; never block startup
        logger.exception("Boot step failed: %s — continuing startup without it", label)


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


@app.exception_handler(DatabaseUnavailableError)
async def _database_unavailable(_request: Request, exc: DatabaseUnavailableError) -> JSONResponse:
    """A 503 with a reason the page can show, instead of a bare 500 after a long hang."""
    logger.error("Database unavailable: %s", exc)
    return JSONResponse(
        status_code=503,
        content={"detail": "The database is unavailable. Please try again in a few minutes."},
    )


app.include_router(health.router)
app.include_router(candidate_session.router)
app.include_router(interview.router)
app.include_router(admin_personas.router)
app.include_router(admin_sop.router)
app.include_router(admin_checklist.router)
app.include_router(admin_questions.router)
app.include_router(auth.router)
app.include_router(admin_users.router)
app.include_router(admin_interviews.router)
app.include_router(candidate_history.router)
app.include_router(admin_config.router)
app.include_router(admin_external_config.router)
app.include_router(voice_live_ws.router)
