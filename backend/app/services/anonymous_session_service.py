"""Anonymous candidate session lifecycle: create, verify, touch.

JWT payload is {"sid", "typ": "anon", "exp"}. verify re-checks the DB row's
is_revoked + expires_at (authoritative) rather than trusting the JWT alone.
"""

from datetime import UTC, datetime, timedelta

from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.anonymous_session import AnonymousCandidateSession

ANON_TOKEN_TYPE = "anon"


class AnonymousSessionError(Exception):
    """Raised when an anonymous token is missing, malformed, revoked, or expired."""


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


async def create_anonymous_session(
    db: AsyncSession, ip_address: str = ""
) -> tuple[AnonymousCandidateSession, str]:
    settings = get_settings()
    now = _now()
    expires_at = now + timedelta(minutes=settings.anon_session_ttl_minutes)
    session = AnonymousCandidateSession(
        ip_address=ip_address,
        expires_at=expires_at,
        last_activity_at=now,
        request_count=0,
        is_revoked=False,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)

    token = jwt.encode(
        {"sid": session.id, "typ": ANON_TOKEN_TYPE, "exp": expires_at},
        settings.secret_key,
        algorithm=settings.algorithm,
    )
    return session, token


async def verify_anonymous_token(db: AsyncSession, token: str) -> AnonymousCandidateSession:
    settings = get_settings()
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
    except JWTError as exc:
        raise AnonymousSessionError("Invalid anonymous token") from exc

    if payload.get("typ") != ANON_TOKEN_TYPE:
        raise AnonymousSessionError("Wrong token type")

    sid = payload.get("sid")
    if not sid:
        raise AnonymousSessionError("Token missing sid")

    session = (
        await db.execute(
            select(AnonymousCandidateSession).where(AnonymousCandidateSession.id == sid)
        )
    ).scalar_one_or_none()

    if session is None:
        raise AnonymousSessionError("Session not found")
    if session.is_revoked:
        raise AnonymousSessionError("Session revoked")
    if session.expires_at < _now():
        raise AnonymousSessionError("Session expired")
    return session


async def touch_session(db: AsyncSession, session: AnonymousCandidateSession) -> None:
    session.last_activity_at = _now()
    session.request_count += 1
    await db.commit()
