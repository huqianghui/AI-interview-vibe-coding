"""Anonymous candidate session endpoints."""

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.services.anonymous_session_service import create_anonymous_session

router = APIRouter(prefix="/public/candidate", tags=["candidate-session"])


class SessionCreateResponse(BaseModel):
    session_id: str
    token: str
    expires_at: str


@router.post("/session", response_model=SessionCreateResponse)
async def create_session(
    request: Request, db: AsyncSession = Depends(get_db)
) -> SessionCreateResponse:
    ip = request.client.host if request.client else ""
    session, token = await create_anonymous_session(db, ip_address=ip)
    return SessionCreateResponse(
        session_id=session.id,
        token=token,
        expires_at=session.expires_at.isoformat(),
    )
