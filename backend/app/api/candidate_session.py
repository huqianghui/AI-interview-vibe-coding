"""Candidate session endpoints (#102: minting a session requires a logged-in candidate).

Auth model (SPEC §4): the candidate logs in with username/password (same ``/auth/login`` as the
admin, role ``user``) and presents that JWT ONLY here, to mint the anonymous-session token every
other interview call uses. ``require_candidate`` is deliberately NOT the generic ``require_role``:
an admin account gets a specific 403 the login card shows verbatim, so the owner can tell "wrong
account type" from "wrong password" during a demo.
"""

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.dependencies import get_current_user
from app.models.user import User
from app.services.anonymous_session_service import create_anonymous_session

router = APIRouter(prefix="/public/candidate", tags=["candidate-session"])

ADMIN_CANNOT_INTERVIEW = "Admin accounts cannot take interviews"


async def require_candidate(user: User = Depends(get_current_user)) -> User:
    """A valid, active JWT (else 401 from get_current_user) belonging to a ``user``-role account."""
    if user.role != "user":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=ADMIN_CANNOT_INTERVIEW)
    return user


class SessionCreateResponse(BaseModel):
    session_id: str
    token: str
    expires_at: str


@router.post("/session", response_model=SessionCreateResponse)
async def create_session(
    request: Request,
    candidate: User = Depends(require_candidate),
    db: AsyncSession = Depends(get_db),
) -> SessionCreateResponse:
    ip = request.client.host if request.client else ""
    session, token = await create_anonymous_session(db, ip_address=ip, user_id=candidate.id)
    return SessionCreateResponse(
        session_id=session.id,
        token=token,
        expires_at=session.expires_at.isoformat(),
    )
