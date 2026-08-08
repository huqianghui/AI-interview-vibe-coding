"""FastAPI dependencies for auth."""

import secrets

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_db
from app.models.anonymous_session import AnonymousCandidateSession
from app.services.anonymous_session_service import (
    AnonymousSessionError,
    verify_anonymous_token,
)


async def get_anonymous_session(
    x_anon_session: str | None = Header(None, alias="X-Anon-Session"),
    db: AsyncSession = Depends(get_db),
) -> AnonymousCandidateSession:
    if x_anon_session is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing anonymous session"
        )
    try:
        return await verify_anonymous_token(db, x_anon_session)
    except AnonymousSessionError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc


async def require_admin(
    authorization: str | None = Header(None, alias="Authorization"),
) -> None:
    """Guard admin-only routes with a shared bearer token (SPEC §67 role=admin, PoC scope).

    A full admin user store is out of scope for the demo; this gates persona/config management
    behind a single configured secret so candidate-facing anonymous sessions can never reach it.
    The token is required to be configured — an unset ``admin_api_token`` denies all access
    (fail closed), so a misconfigured deploy can't accidentally expose admin routes.
    """
    expected = get_settings().admin_api_token
    provided = ""
    if authorization and authorization.lower().startswith("bearer "):
        provided = authorization[7:]
    # Constant-time compare; also fail closed when no admin token is configured.
    if not expected or not secrets.compare_digest(provided, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Admin authorization required"
        )
