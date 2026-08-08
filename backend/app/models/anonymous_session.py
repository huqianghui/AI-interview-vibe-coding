"""Anonymous candidate session.

A candidate takes an interview without logging in. The DB row is authoritative for
expiry/revocation (the JWT is just a signed pointer via its `sid`), so a token can be
revoked server-side before its `exp`.
"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.mixins import TimestampMixin


class AnonymousCandidateSession(TimestampMixin, Base):
    __tablename__ = "anonymous_candidate_sessions"

    ip_address: Mapped[str] = mapped_column(String(64), default="")
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    last_activity_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    request_count: Mapped[int] = mapped_column(Integer, default=0)
    is_revoked: Mapped[bool] = mapped_column(Boolean, default=False)
