"""Authentication API: login, me, refresh (admin/user JWT system)."""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.dependencies import get_current_user
from app.models.user import User
from app.schemas.auth import LoginRequest, TokenResponse, UserResponse
from app.services.auth_service import authenticate_user, create_access_token

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, db: AsyncSession = Depends(get_db)) -> TokenResponse:
    """Authenticate and return a JWT access token."""
    user = await authenticate_user(db, body.username, body.password)
    return TokenResponse(access_token=create_access_token(data={"sub": user.id}))


@router.get("/me", response_model=UserResponse)
async def get_me(current_user: User = Depends(get_current_user)) -> User:
    """Return the currently authenticated user's profile."""
    return current_user


@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(current_user: User = Depends(get_current_user)) -> TokenResponse:
    """Re-mint an access token for the currently-valid bearer (simple refresh, no rotation)."""
    return TokenResponse(access_token=create_access_token(data={"sub": current_user.id}))
