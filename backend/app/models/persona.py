"""Interviewer digital-human persona model (SPEC F5).

Ported in shape from the reference ``AvatarPersona``: a persona is the interviewer's identity
(name, character, style), its per-locale voice + greeting maps, the prompt fragment that becomes
the Foundry agent's instructions, and the Voice Live knobs that get serialized into the agent's
``microsoft.voice-live.configuration`` metadata (see app.services.agents.voice_live_metadata).

Agent-sync bookkeeping (``agent_id`` / ``agent_version`` / ``agent_sync_status`` /
``agent_sync_error``) tracks the persona's binding to a synced Foundry prompt agent so a failed
sync is a recorded state, not a crash (SPEC F5 AC #4).

**Exactly one enabled default** is enforced at the DB level via a partial-unique index over
``is_default`` filtered to enabled defaults (SPEC F5 AC #3).

PUBLIC repo: no real persona content (client wording, voice names) is stored here — these are
schema definitions plus neutral defaults only.
"""

from sqlalchemy import Boolean, Float, Index, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.mixins import TimestampMixin

# Foundry agent sync lifecycle (SPEC F5): a persona is "none" until first sync is attempted.
AGENT_SYNC_STATUSES = ("none", "pending", "synced", "failed")


class InterviewerPersona(TimestampMixin, Base):
    __tablename__ = "interviewer_personas"

    # Identity ---------------------------------------------------------------
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    character: Mapped[str] = mapped_column(Text, default="", nullable=False)
    style: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # Instruction fragment injected into the Foundry prompt agent's instructions.
    prompt_fragment: Mapped[str] = mapped_column(Text, default="", nullable=False)

    # Per-locale maps (JSON: {"zh-CN": "...", "en-US": "..."}). Stored as text to keep the
    # model backend-agnostic (SQLite dev / any prod DB); serialized/parsed in the service layer.
    voice_map: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    greeting_map: Mapped[str] = mapped_column(Text, default="{}", nullable=False)

    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # Voice Live knobs (serialized into voice-live.configuration metadata) -----
    # `turn_detection` is the VAD type string; the fixed EOU model + interim vocab are owned by
    # the pure metadata builder (they're API constants, not per-persona config). `eou_detection`
    # is a bool toggle — the builder emits the end_of_utterance_detection sub-object on truthiness.
    turn_detection: Mapped[str] = mapped_column(
        String(64), default="azure_semantic_vad", nullable=False
    )
    eou_detection: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    noise_suppression: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    echo_cancellation: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    interim_response: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    proactive_engagement: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    voice_temperature: Mapped[float] = mapped_column(Float, default=0.8, nullable=False)
    playback_speed: Mapped[float] = mapped_column(Float, default=1.0, nullable=False)

    # Per-persona agent tools (SPEC F5) — JSON array of tool dicts synced into the Foundry prompt
    # agent's `tools`. Executed by the Foundry runtime, not here; this app only carries the config.
    # e.g. [{"type":"code_interpreter"},{"type":"web_search"},{"type":"mcp","server_url":...}].
    tools_config: Mapped[str] = mapped_column(Text, default="[]", nullable=False)

    # Foundry agent binding + sync bookkeeping --------------------------------
    agent_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    agent_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    agent_sync_status: Mapped[str] = mapped_column(String(16), default="none", nullable=False)
    agent_sync_error: Mapped[str | None] = mapped_column(Text, nullable=True)

    __table_args__ = (
        # SPEC F5 AC #3: at most one enabled default persona, enforced in the DB, not app code.
        # Partial index (SQLite + Postgres both honor the WHERE clause) so only enabled defaults
        # contend for the single slot; disabled or non-default rows are unconstrained.
        Index(
            "uq_one_enabled_default_persona",
            "is_default",
            unique=True,
            sqlite_where=text("enabled = 1 AND is_default = 1"),
            postgresql_where=text("enabled = true AND is_default = true"),
        ),
    )
