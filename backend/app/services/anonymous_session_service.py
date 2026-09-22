"""Anonymous candidate session lifecycle: create, verify, touch.

JWT payload is {"sid", "typ": "anon", "exp"}. verify re-checks the DB row's
is_revoked + expires_at (authoritative) rather than trusting the JWT alone.

#102: a session is minted for a logged-in candidate (``user_id``) and creation is idempotent per
user — an unexpired, unrevoked session is reused (fresh token, same row) so closing the tab and
logging in again resumes the same in-progress interview.
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


def _token_for(session: AnonymousCandidateSession) -> str:
    settings = get_settings()
    return jwt.encode(
        {"sid": session.id, "typ": ANON_TOKEN_TYPE, "exp": session.expires_at},
        settings.secret_key,
        algorithm=settings.algorithm,
    )


async def find_active_session_for_user(
    db: AsyncSession, user_id: str
) -> AnonymousCandidateSession | None:
    """The user's newest unexpired, unrevoked session, or None (#102 idempotent creation)."""
    return (
        await db.execute(
            select(AnonymousCandidateSession)
            .where(
                AnonymousCandidateSession.user_id == user_id,
                AnonymousCandidateSession.is_revoked.is_(False),
                AnonymousCandidateSession.expires_at > _now(),
            )
            .order_by(AnonymousCandidateSession.expires_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def create_anonymous_session(
    db: AsyncSession, ip_address: str = "", user_id: str | None = None
) -> tuple[AnonymousCandidateSession, str]:
    """Mint a candidate session (+ token) for ``user_id``; reuse the user's live one if any.

    Two devices on one account therefore share a session — documented usage rule: one account is
    used by one person at a time.
    """
    settings = get_settings()
    if user_id is not None:
        existing = await find_active_session_for_user(db, user_id)
        if existing is not None:
            return existing, _token_for(existing)
    now = _now()
    expires_at = now + timedelta(minutes=settings.anon_session_ttl_minutes)
    session = AnonymousCandidateSession(
        ip_address=ip_address,
        expires_at=expires_at,
        last_activity_at=now,
        request_count=0,
        is_revoked=False,
        user_id=user_id,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return session, _token_for(session)


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
