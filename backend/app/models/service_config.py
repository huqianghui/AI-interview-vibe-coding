"""Azure service configuration, persisted so an operator sets it at runtime (not just via .env).

A single **master** AI Foundry row (``service_name='ai_foundry'``, ``is_master=True``) holds the
shared endpoint, API key (Fernet-encrypted), default project, and the models. It is the runtime
source of truth: overlaid onto the settings singleton at startup and after each save (see
``app.services.config_overlay``), giving the precedence DB > .env > code default.

**Two models, not one.** ``model_or_deployment`` is the INFERENCE model (judge / scoring / the
Foundry agent) and must be a deployment in this resource; ``voice_model`` is the Voice Live SESSION
model and must be a name Voice Live hosts natively in the region, unless ``voice_model_mode`` says
``byom``. They were one field until v0.43 and that is exactly what produced "Model X is not
supported in this region" whenever an operator saved their own deployment.

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
    # The INFERENCE model: judge (judged-mode wait/nudge), scoring, checklist drafting, SOP
    # coverage, and the Foundry agent's own model all resolve to this (via
    # settings.foundry_agent_model, see config_overlay). It is a DEPLOYMENT NAME in this Foundry
    # resource — the Responses API and the Agents service address models by deployment.
    # It deliberately no longer feeds Voice Live: see voice_model below.
    model_or_deployment: Mapped[str] = mapped_column(String(100), default="", nullable=False)
    # The VOICE-SESSION model, split out from model_or_deployment in v0.43 because the two take
    # DIFFERENT legal values and one field could not express both. Voice Live's MODEL mode accepts
    # only models the service pre-deploys natively in the resource's region (its own hosting, which
    # creates NO deployment in your resource), so an own-deployment name there fails with
    # "Model X is not supported in this region" — measured: gpt-5.4-mini was a real agent chat
    # deployment yet Voice Live rejected it. Empty falls back to VOICE_LIVE_DEFAULT_MODEL.
    # On the WS this model is the session HOST, not a brain (candidate sessions never infer:
    # create_response=False), which is why pinning it to the inference model bought nothing.
    # See docs/voice-live-model-support.md §3.6.
    voice_model: Mapped[str] = mapped_column(String(100), default="", nullable=False)
    # How Voice Live reaches voice_model: "native" (path ①, the region's pre-deployed catalogue) or
    # "byom" (path ②, your own Foundry deployment + a profile). NOT inferable from the name — the
    # realtime-passthrough vs chat-cascade choice is an architecture decision, not a model property.
    voice_model_mode: Mapped[str] = mapped_column(String(16), default="native", nullable=False)
    # BYOM integration mode (the wire protocol Voice Live drives your deployment with), sent as
    # query={"profile": ...}. Only meaningful when voice_model_mode == "byom"; empty otherwise.
    voice_byom_profile: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    default_project: Mapped[str] = mapped_column(String(200), default="", nullable=False)
    # Foundry IQ knowledge base (F1 SOP retrieval). `knowledge_base` is the KB name (URL path
    # segment); `knowledge_source` is the KS name in the retrieve body (distinct from the KB name).
    knowledge_base: Mapped[str] = mapped_column(String(200), default="", nullable=False)
    knowledge_source: Mapped[str] = mapped_column(String(200), default="", nullable=False)
    is_master: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Who last saved it (admin identity; the shared-token PoC stores "admin").
    updated_by: Mapped[str] = mapped_column(String(36), default="", nullable=False)
