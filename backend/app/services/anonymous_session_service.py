"""Anonymous candidate session lifecycle: create, verify, touch.

JWT payload is {"sid", "typ": "anon", "exp"}. verify re-checks the DB row's
is_revoked + expires_at (authoritative) rather than trusting the JWT alone.

#102: a session is minted for a logged-in candidate (``user_id``) and creation is idempotent per
user — an unexpired, unrevoked session is reused (fresh token, same row) so closing the tab and
logging in again resumes the same in-progress interview.
"""

from datetime import UTC, datetime, timedelta

from jose import JWTError, jwt
from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError
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


async def _release_stale_seat(db: AsyncSession, user_id: str) -> None:
    """Free the account's seat when the row holding it is no longer live (review R2).

    ``active_user_id`` is what the unique index guards, and expiry is time-based, so a row can still
    hold the seat after it expired. Clearing those here keeps "one LIVE session per account" from
    turning into "one session per account, ever".
    """
    await db.execute(
        update(AnonymousCandidateSession)
        .where(
            AnonymousCandidateSession.active_user_id == user_id,
            or_(
                AnonymousCandidateSession.is_revoked.is_(True),
                AnonymousCandidateSession.expires_at <= _now(),
            ),
        )
        .values(active_user_id=None)
    )


async def create_anonymous_session(
    db: AsyncSession, ip_address: str = "", user_id: str | None = None
) -> tuple[AnonymousCandidateSession, str]:
    """Mint a candidate session (+ token) for ``user_id``; reuse the user's live one if any.

    Idempotent per account, and the database enforces it (review R2): the live row holds the
    account's seat via ``active_user_id``, guarded by ``uq_anon_session_active_user``. Two
    simultaneous first logins therefore cannot both mint a session — the loser hits the constraint,
    rolls back, and reuses the winner's row. Two devices on one account share that one session:
    documented usage rule is one account, one person at a time.
    """
    settings = get_settings()
    if user_id is not None:
        existing = await find_active_session_for_user(db, user_id)
        if existing is not None:
            return existing, _token_for(existing)
        # The seat may still be held by an expired/revoked row — release it before claiming.
        await _release_stale_seat(db, user_id)
    now = _now()
    expires_at = now + timedelta(minutes=settings.anon_session_ttl_minutes)
    session = AnonymousCandidateSession(
        ip_address=ip_address,
        expires_at=expires_at,
        last_activity_at=now,
        request_count=0,
        is_revoked=False,
        user_id=user_id,
        active_user_id=user_id,
    )
    db.add(session)
    try:
        await db.commit()
    except IntegrityError:
        # A concurrent request claimed the seat between our lookup and this insert. Roll back and
        # use the winner's session — never mint a second live seat for one account.
        await db.rollback()
        if user_id is None:
            raise
        winner = await find_active_session_for_user(db, user_id)
        if winner is None:
            raise
        return winner, _token_for(winner)
    await db.refresh(session)
    return session, _token_for(session)


async def revoke_session(db: AsyncSession, session: AnonymousCandidateSession) -> None:
    """Revoke a session and release the account's seat so the candidate can start a fresh one."""
    session.is_revoked = True
    session.active_user_id = None
    await db.commit()


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
