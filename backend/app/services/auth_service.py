"""Authentication service: bcrypt password hashing, JWT tokens, user authentication.

Ported from AI-avatar-vibe-coding, adapted to this repo (FastAPI ``HTTPException`` instead of the
avatar project's ``AppException``). This is the admin/user JWT system, separate from candidate
anonymous-session auth.
"""

from datetime import UTC, datetime, timedelta

import bcrypt
from fastapi import HTTPException, status
from jose import jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.user import User

# Use the bcrypt library directly rather than passlib: passlib's backend-version detection breaks
# with bcrypt>=4.1/5.x (raises a spurious "password > 72 bytes"). bcrypt caps input at 72 bytes, so
# encode + truncate before hashing/checking (bcrypt only ever uses the first 72 bytes anyway).
_BCRYPT_MAX = 72


def _pw_bytes(password: str) -> bytes:
    return password.encode("utf-8")[:_BCRYPT_MAX]


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a plain password against a bcrypt hash."""
    try:
        return bcrypt.checkpw(_pw_bytes(plain_password), hashed_password.encode("utf-8"))
    except ValueError:
        return False


def get_password_hash(password: str) -> str:
    """Hash a password with bcrypt (utf-8, 72-byte cap)."""
    return bcrypt.hashpw(_pw_bytes(password), bcrypt.gensalt()).decode("utf-8")


def create_access_token(data: dict, expires_delta: timedelta | None = None) -> str:
    """Create a signed JWT access token (HS256), expiring per settings unless overridden."""
    settings = get_settings()
    to_encode = data.copy()
    expire = datetime.now(UTC) + (
        expires_delta or timedelta(minutes=settings.access_token_expire_minutes)
    )
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.secret_key, algorithm=settings.algorithm)


async def authenticate_user(db: AsyncSession, username: str, password: str) -> User:
    """Return the user if username+password match; else raise 401 (same message for both cases)."""
    result = await db.execute(select(User).where(User.username == username))
    user = result.scalar_one_or_none()
    if user is None or not verify_password(password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
        )
    return user
