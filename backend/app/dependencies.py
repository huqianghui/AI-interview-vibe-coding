"""FastAPI dependencies for auth."""

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

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
