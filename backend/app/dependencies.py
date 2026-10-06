"""FastAPI dependencies for auth.

Two independent auth systems live here:
- **Candidate anonymous session** (`get_anonymous_session`) — the interview-facing path, unchanged.
- **User/admin JWT** (`get_current_user` / `require_role`) — the admin + agent-editor + config UI,
  ported from AI-avatar. (The shared-token `require_admin` it replaced was deleted in v0.46.0.0.)
"""

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
