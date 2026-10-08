"""Health check endpoints.

``/health`` is liveness only: the process is up and serving. The deploy smoke check calls it, and it
deliberately does not touch the database, so a deploy is not failed by a database that happens to
be down at that moment.

``/health/db`` is the database on its own. A stopped or unreachable PostgreSQL server is the most
likely reason the live app breaks (every sign-in fails while ``/health`` stays green), so it gets a
check of its own that answers 503 with a reason. The DB keepalive workflow calls it end to end.
"""

import asyncio
import logging
import time
from typing import Literal

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import text

from app import db

logger = logging.getLogger(__name__)

router = APIRouter(tags=["health"])

# Long enough for a cold connect (Entra token + TLS), short enough that a probe never hangs.
DB_HEALTH_TIMEOUT_S = 8


class DatabaseHealth(BaseModel):
    status: Literal["ok", "unavailable"]
    latency_ms: int | None = None
    # The failure's kind (e.g. "TimeoutError"), never the host or a connection string.
    reason: str | None = None


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


async def _select_one() -> None:
    async with db.engine.connect() as conn:
        await conn.execute(text("SELECT 1"))


@router.get(
    "/health/db",
    response_model=DatabaseHealth,
    responses={503: {"model": DatabaseHealth, "description": "The database is unreachable"}},
)
async def health_db() -> DatabaseHealth | JSONResponse:
    """Run ``SELECT 1``; 200 with the round-trip time, or 503 with why it failed."""
    started = time.monotonic()
    try:
        await asyncio.wait_for(_select_one(), timeout=DB_HEALTH_TIMEOUT_S)
    except Exception as exc:  # noqa: BLE001 — any failure means "unavailable"; the kind is reported
        if isinstance(exc, TimeoutError):
            reason = f"no answer within {DB_HEALTH_TIMEOUT_S}s"
        else:
            reason = type(exc.__cause__ or exc).__name__
        logger.error("Database health check failed: %s (%r)", reason, exc)
        body = DatabaseHealth(status="unavailable", reason=reason)
        return JSONResponse(status_code=503, content=body.model_dump())
    return DatabaseHealth(status="ok", latency_ms=round((time.monotonic() - started) * 1000))
