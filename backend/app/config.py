"""Application settings.

Runtime config precedence for Azure credentials/models is **DB > .env > code default**:
the ``service_configs`` master row (set via the admin config page) is overlaid onto this settings
singleton at startup and after each save (see ``services/config_overlay``), so production reads the
user's saved config; ``.env`` fills any gaps in dev; the code defaults below are the last resort.
Local dev runs fully on mock providers (see services/agents), so none of the Azure_* values are
required to boot.
"""

from functools import lru_cache

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # App
    app_name: str = "AI Interview"
    debug: bool = False
    database_url: str = "sqlite+aiosqlite:///./ai_interview.db"
    # How a PostgreSQL connection authenticates. "password" = whatever DATABASE_URL carries (local
    # dev). "entra" = Azure Database for PostgreSQL with password login disabled: every new
    # connection gets a fresh Microsoft Entra token for the managed identity (AZURE_CLIENT_ID) as
    # its password, over TLS. DATABASE_URL then names only the host, database and Entra user.
    database_auth: str = "password"

    # Auth. REQUIRED — no code default on purpose: SECRET_KEY signs every JWT AND (since #102) is
    # the key the seeded candidate passwords are derived from, so a well-known default would make
    # those passwords publicly computable from this (public) repo. Local dev: set it in the
    # gitignored backend/.env (see .env.example); Azure/client deploys inject it from bicep /
    # gen-secrets.sh.
    secret_key: str = ""
    # Fernet key (urlsafe-base64 32 bytes) encrypting at-rest secrets in `service_configs` (the
    # admin-saved Azure API key). Empty in dev → a key is derived from `secret_key` (dev-only, see
    # utils/encryption). Set a real ENCRYPTION_KEY in prod so secrets survive restarts/rotation.
    encryption_key: str = ""
    algorithm: str = "HS256"
    # JWT access-token lifetime for the user/admin auth system (default 24h).
    access_token_expire_minutes: int = 60 * 24
    # Default admin seeded on boot (only when password is set — avoids a known-credential admin).
    seed_admin_username: str = "admin"
    seed_admin_password: str = ""
    anon_session_ttl_minutes: int = 120

    # Provider selection — mock keeps local dev + CI free of live Azure calls.
    default_llm_provider: str = "mock"
    default_retrieval_provider: str = "mock"

    # Azure bootstrap/fallback (real values live in ServiceConfig DB table).
    azure_openai_endpoint: str = ""
    azure_openai_api_key: str = ""
    azure_openai_deployment: str = ""

    # Foundry IQ / Azure AI Search retrieval (SOP citations). Empty in dev/CI → mock only.
    azure_search_endpoint: str = ""
    azure_search_index: str = ""  # knowledge base name (URL path segment)
    azure_search_knowledge_source: str = ""  # KS name in the retrieve body (≠ index; see spike)
    azure_search_api_key: str = ""
    # RemoteTool project-connection name that authenticates the agent's MCP call to the KB (P15).
    # NOT a CognitiveSearch/ApiKey connection (those 403). Empty → adapter resolves/creates it.
    foundry_kb_mcp_connection: str = ""

    # Client-derived bank bundles, delivered out-of-band through the private-blob channel (see
    # entrypoint.sh) and imported on boot alongside the committed generic bundles. Points at a
    # directory of ``*.bank.json`` files — the client bundle extracts to ``/app/_client_bundle`` and
    # its ``extra_banks/`` subdir is the default. Empty/absent → no extra banks (public-demo mode).
    # These banks carry client SOP source_quotes, so they are NEVER committed to this public repo.
    client_banks_dir: str = "/app/_client_bundle/extra_banks"

    # SOP blob storage (F1). Raw uploads live here, never in the DB and never handed to candidates
    # directly (P4). Local filesystem in dev/CI; a blob backend can be swapped in prod.
    default_storage_provider: str = "local"
    material_storage_path: str = "./_sop_storage"
    # Max upload size (MB) accepted by the SOP ingestion endpoint.
    material_max_size_mb: int = 25

    # Foundry project for interviewer-agent sync (SPEC F5). Empty in dev/CI → no agent sync.
    default_agent_sync_provider: str = "mock"
    foundry_project_endpoint: str = ""
    # Model the interviewer Foundry agent runs on. MUST name a deployment that exists on the target
    # Azure resource. Project default is gpt-5-mini (second choice: gpt-4.1-mini); the real value
    # comes from the DB master config (admin page) in prod, or FOUNDRY_AGENT_MODEL in .env for dev.
    foundry_agent_model: str = "gpt-5-mini"
    foundry_api_key: str = ""

    # Azure Foundry / Voice Live resource. The browser never talks to it directly: the backend's
    # /voice-live/ws proxy holds the Voice Live SDK connection.
    # Left empty in CI; the live values live only in the gitignored backend/.env.
    azure_foundry_endpoint: str = ""
    azure_foundry_api_key: str = ""
    azure_foundry_default_project: str = ""
    # Model Voice Live runs the session on (MODEL mode). Voice Live only accepts models it hosts
    # natively in the resource's region (Learn: Speech regions → Voice Live tab) — NOT arbitrary
    # deployments. Project default gpt-5-mini (second choice gpt-4.1-mini); both live-verified on
    # Sweden Central 2026-09-23. gpt-5.6-luna/sol, gpt-5.4-mini and gpt-6-* are rejected there
    # ("Model X is not supported in this region"). Real value: persona.model → DB master → .env.
    voice_live_default_model: str = "gpt-5-mini"
    # Voice Live realtime api-version. Classic Foundry agents (what agent-sync currently creates)
    # require 2026-01-01-preview or 2025-10-01 — api-version 2026-04-10 and above reject them with
    # "Classic foundry agent is not supported" (live-verified 2026-08-11, swedencentral). The GA
    # 2026-07-15 value only works for model mode / migrated new-type agents.
    voice_live_api_version: str = "2026-01-01-preview"
    # Mic uplink sample rate (Hz) declared as the session's ``input_audio_sampling_rate``. Azure
    # accepts only 16000 or 24000 for pcm16 and DEFAULTS to 24000 — a value inherited from the
    # OpenAI Realtime wire format, where ``pcm16`` IS 24 kHz and the model ingests audio natively.
    # We run the CASCADED path (gpt-5-mini = "audio input through Azure speech to text"), whose
    # recogniser is a 16 kHz pipeline, so 24 kHz is downsampled by Azure and the extra 8-12 kHz band
    # discarded. Dropping to 16 kHz costs no transcription accuracy and cuts the uplink by a third
    # (measured 540-680 kbps at 24 kHz, which starved our own avatar signalling on a narrow office
    # uplink — docs/avatar-weaknet-probe.md §3.8, rationale docs/voice-live-control-notes.md §4).
    # MUST match the frontend's MIC_SAMPLE_RATE (frontend/src/hooks/useVoiceAudio.ts); the value is
    # echoed in ``proxy.connected`` so the page can detect drift. Cannot be changed mid-session.
    voice_live_input_sampling_rate: int = 16000
    # Optional cap on the avatar VIDEO bitrate (bits/s) sent in session.avatar.video.bitrate.
    # Azure's default is 2 Mbps for 1080p video avatars; the weak-network probe (2026-09-30) showed
    # the sender does NOT honour a receiver-side SDP b=AS cap, so this server-side knob is the only
    # bandwidth lever. None ⇒ omit the field (Azure default). Unset until the probe settles a value.
    voice_live_avatar_video_bitrate: int | None = None

    # External interview API/server (SPEC Phase 2, vendor-neutral). The backend drives the client's
    # interview brain turn-by-turn as an API client (never a Foundry-agent tool). Empty in CI/dev →
    # the mock external provider answers, so the flow is exercisable without a live gateway. Real
    # values live only in the gitignored backend/.env or the admin config UI (key Fernet-encrypted).
    # `user_tag` is a static per-deployment string prepended to the anonymized session id to form
    # the gateway `user` field, so the client can attribute traffic per environment.
    external_interviewer_endpoint: str = ""
    external_interviewer_api_key: str = ""
    external_interviewer_user_tag: str = ""

    # Boot-seeded default persona's interview brain. The ephemeral-SQLite deploy reseeds the
    # default persona on every boot, so a deployment whose normal operation is the EXTERNAL brain
    # sets SEED_PERSONA_BRAIN=external to come back up external-ready after a restart — otherwise
    # the seeded persona reverts to "bank" and an operator must re-toggle it in the editor. Values
    # outside app.models.interview.BRAIN_MODES fall back to "bank" (logged). The optional reader
    # prompt overrides the generated default reading contract for the seeded persona (empty = NULL
    # = use default_external_reader_prompt) — same env-seeding pattern as the external endpoint row.
    seed_persona_brain: str = "bank"
    seed_persona_reader_prompt: str = ""

    @model_validator(mode="after")
    def _require_secret_key(self) -> "Settings":
        """Refuse to boot with a missing/placeholder SECRET_KEY.

        Candidate passwords derive from it (see auth_service.derive_candidate_password).
        """
        if not self.secret_key or self.secret_key == "dev-only-change-me":
            raise ValueError(
                "SECRET_KEY is not set. It signs JWTs and derives the seeded candidate passwords, "
                "so a public default is not allowed. Generate one with `openssl rand -hex 32` and "
                "put it in backend/.env (see .env.example) or the deployment's secret store."
            )
        return self

    @model_validator(mode="after")
    def _require_supported_input_sampling_rate(self) -> "Settings":
        """Refuse to boot on a rate Azure will not accept.

        Azure takes only 16000 or 24000 for pcm16. A typo (22050) would boot fine and then
        break EVERY voice connection at ``session.update`` time, which reads as "voice is
        broken" rather than "config is wrong". The value must also match the browser's
        MIC_SAMPLE_RATE, so changing it live without a coordinated frontend build reproduces
        exactly the mismatch the page's drift guard exists to catch — which is why this field
        is deliberately NOT part of the DB ``service_configs`` overlay other Azure fields use.
        """
        allowed = (16000, 24000)
        if self.voice_live_input_sampling_rate not in allowed:
            raise ValueError(
                f"VOICE_LIVE_INPUT_SAMPLING_RATE={self.voice_live_input_sampling_rate} is not "
                f"supported. Azure accepts only {allowed[0]} or {allowed[1]} for pcm16, and the "
                "value must match MIC_SAMPLE_RATE in frontend/src/hooks/useVoiceAudio.ts."
            )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
