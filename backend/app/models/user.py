"""User ORM model for authentication and role-based access (admin / user).

Ported from AI-avatar-vibe-coding (same schema). This is the admin/user JWT auth system for the
agent-editor + config UI — SEPARATE from the candidate-facing ``AnonymousCandidateSession`` auth,
which is untouched. Uses this repo's ``Base`` (app.db) + ``TimestampMixin`` (app.models.mixins).
"""

from sqlalchemy import Boolean, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.mixins import TimestampMixin


class User(TimestampMixin, Base):
    """User with role-based access control. Roles are the string ``"admin"`` or ``"user"``."""

    __tablename__ = "users"

    username: Mapped[str] = mapped_column(String(100), unique=True, nullable=False, index=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    role: Mapped[str] = mapped_column(String(20), default="user", nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    preferred_language: Mapped[str] = mapped_column(String(10), default="en-US", nullable=False)
    business_unit: Mapped[str] = mapped_column(String(100), default="", nullable=False)
    # #102: non-NULL marks a SYSTEM-DERIVED password (seeded candidate accounts). The value is the
    # derivation generation (1 for the boot seed; a future reset would bump it). NULL = a self-set
    # password (the admin) that the server cannot show to anyone. See
    # auth_service.derive_candidate_password.
    password_generation: Mapped[int | None] = mapped_column(Integer, nullable=True)
