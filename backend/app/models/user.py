"""User ORM model for authentication and role-based access (admin / user).

Ported from AI-avatar-vibe-coding (same schema). This is the admin/user JWT auth system for the
agent-editor + config UI — SEPARATE from the candidate-facing ``AnonymousCandidateSession`` auth,
which is untouched. Uses this repo's ``Base`` (app.db) + ``TimestampMixin`` (app.models.mixins).
"""

from sqlalchemy import Boolean, ForeignKey, Integer, String
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
    # #187: the interviewer and question bank this user's interviews start with. NULL = the global
    # default. ``SET NULL`` on delete, and a disabled target is skipped at start, so a stale
    # assignment falls back to the default instead of failing (assignment_service).
    assigned_persona_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("interviewer_personas.id", ondelete="SET NULL"), nullable=True
    )
    assigned_bank_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("question_banks.id", ondelete="SET NULL"), nullable=True
    )
    # The published version of that bank (questions + rubric) this user's interviews use
    # (spec-bank-versioning). Assignment defaults it to the bank's latest published version and it
    # then stays pinned; a version of another bank is ignored at start.
    assigned_bank_version_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("bank_versions.id", ondelete="SET NULL"), nullable=True
    )
