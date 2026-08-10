"""Azure service configuration, persisted so an operator sets it at runtime (not just via .env).

A single **master** AI Foundry row (``service_name='ai_foundry'``, ``is_master=True``) holds the
shared endpoint, API key (Fernet-encrypted), default project, and model/deployment. It is the
runtime source of truth: overlaid onto the settings singleton at startup and after each save (see
``app.services.config_overlay``), giving the precedence DB > .env > code default.

Right-sized for this project's 4 services (LLM, retrieval, agent-sync, voice-live) — a single master
row, no per-service toggle rows (cf. the reference project's fuller multi-row design).

PUBLIC repo: this is schema only. Real endpoints/keys live in the DB at runtime and the API key is
stored encrypted, never in the repo.
"""

from sqlalchemy import Boolean, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.mixins import TimestampMixin


class ServiceConfig(TimestampMixin, Base):
    __tablename__ = "service_configs"

    service_name: Mapped[str] = mapped_column(String(50), unique=True, nullable=False, index=True)
    display_name: Mapped[str] = mapped_column(String(100), nullable=False, default="")
    endpoint: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    # Fernet token (see app.utils.encryption); never the plaintext key.
    api_key_encrypted: Mapped[str] = mapped_column(Text, default="", nullable=False)
    model_or_deployment: Mapped[str] = mapped_column(String(100), default="", nullable=False)
    default_project: Mapped[str] = mapped_column(String(200), default="", nullable=False)
    is_master: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Who last saved it (admin identity; the shared-token PoC stores "admin").
    updated_by: Mapped[str] = mapped_column(String(36), default="", nullable=False)
