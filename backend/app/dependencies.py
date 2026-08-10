"""FastAPI dependencies for auth.

Two independent auth systems live here:
- **Candidate anonymous session** (`get_anonymous_session`) — the interview-facing path, unchanged.
- **User/admin JWT** (`get_current_user` / `require_role`) — the admin + agent-editor + config UI,
  ported from AI-avatar. `require_admin` (shared-token) is retired once routes move to
  `require_role("admin")`.
"""

import secrets
from collections.abc import Callable

from fastapi import Depends, Header, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_db
from app.models.anonymous_session import AnonymousCandidateSession
from app.models.user import User
from app.services.anonymous_session_service import (
    AnonymousSessionError,
    verify_anonymous_token,
)

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")


async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Resolve the current user from a JWT bearer token; 401 on any failure."""
    settings = get_settings()
    unauthorized = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
    except JWTError:
        raise unauthorized from None
    user_id = payload.get("sub")
    if not user_id:
        raise unauthorized
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None or not user.is_active:
        raise unauthorized
    return user


def require_role(role: str) -> Callable:
    """Dependency factory: allow only users whose role matches (else 403)."""

    async def role_checker(user: User = Depends(get_current_user)) -> User:
        if user.role != role:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions"
            )
        return user

    return role_checker


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
