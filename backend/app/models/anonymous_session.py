"""Anonymous candidate session.

Since #102 a candidate must LOG IN (username/password → JWT) to mint one of these; the interview
calls themselves still present only this session token. The DB row is authoritative for
expiry/revocation (the JWT is just a signed pointer via its `sid`), so a token can be
revoked server-side before its `exp`.
"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.mixins import TimestampMixin


class AnonymousCandidateSession(TimestampMixin, Base):
    __tablename__ = "anonymous_candidate_sessions"
    # #102 (review R2): DB-enforced "one live session per account". ``active_user_id`` mirrors
    # ``user_id`` while the session holds the account's seat and is NULLed once the seat is released
    # (expired / revoked / superseded); NULLs don't collide in a unique index, so any number of
    # historical rows may exist per account while at most one can be live. This makes the
    # find-then-insert in ``create_anonymous_session`` safe under concurrent first logins: the loser
    # gets an IntegrityError and reuses the winner's session instead of minting a second seat.
    __table_args__ = (UniqueConstraint("active_user_id", name="uq_anon_session_active_user"),)

    ip_address: Mapped[str] = mapped_column(String(64), default="")
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    last_activity_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    request_count: Mapped[int] = mapped_column(Integer, default=0)
    is_revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    # #102: the logged-in candidate this session was minted for. Nullable only for rows created
    # before the login gate shipped; every new session carries it, and creation is idempotent per
    # user (an unexpired, unrevoked session is reused) so resume survives a re-login.
    user_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id"), nullable=True, index=True
    )
    # Set to ``user_id`` while this session is the account's live seat; NULL once released. Guarded
    # by ``uq_anon_session_active_user`` (see __table_args__).
    active_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
