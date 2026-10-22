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

# Code default for the inference model (judge + scoring); also used when JUDGE_MODEL is set blank.
JUDGE_MODEL_DEFAULT = "gpt-6-sol"


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
    # PostgreSQL connection pool, PER PROCESS (each uvicorn worker and the job runner has its own).
    # The server's limit is shared by all of them: processes × replicas × (size + overflow), doubled
    # while a revision swap runs both, must stay under max_connections minus Azure's 15 reserved.
    db_pool_size: int = 10
    db_max_overflow: int = 15
    # Where background jobs run (app/jobs, docs/planning/spec-jobs-and-scale-out.md). "embedded":
    # inside this process, a job started here runs here at once and a poller picks up the rest (dev,
    # e2e). "off": this process only enqueues; the job process (`python -m app.jobs.runner`, the
    # `jobs` container) runs them, so no web worker carrying voice sockets does heavy work.
    # "inline" (pytest only): the request runs the job to completion itself.
    job_runner_mode: str = "embedded"
    # Jobs one runner process works on at once.
    job_runner_concurrency: int = 4

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
    # directly (P4). "local" (dev/CI) writes under material_storage_path; "azure" writes to the
    # material_blob_container of azure_storage_account_url with the managed identity. Production
    # MUST be "azure": a Container App's disk does not survive a new revision (services/storage).
    default_storage_provider: str = "local"
    material_storage_path: str = "./_sop_storage"
    # Word SOPs are printed to PDF by LibreOffice and read by Document Intelligence. The backend
    # image installs LibreOffice and sets this, so a published image never falls back to the
    # in-house Word converter: a missing LibreOffice fails the conversion instead. Off in dev/CI.
    sop_require_libreoffice: bool = False
    # Word → PDF (LibreOffice) → Document Intelligence, the one pipeline for every format (owner,
    # 2026-10-09). The backend image turns it on; off (dev, CI) Word uses the in-house converter.
    sop_word_via_pdf: bool = False
    azure_storage_account_url: str = ""
    material_blob_container: str = "materials"
    # Candidate voice recordings (the microphone only, one WAV per question), in their own private
    # container whose lifecycle rule deletes them after 90 days (infra/azure/modules/storage.bicep).
    # Off = nothing is recorded and candidates are not told they are.
    candidate_audio_recording: bool = True
    recording_blob_container: str = "recordings"
    recording_retention_days: int = 90
    # Where boot looks for the original of an SOP whose stored bytes are missing (by file name).
    # The private client bundle extracts here (entrypoint.sh); absent in dev/CI → nothing to repair.
    sop_repair_source_dir: str = "/app/_client_bundle"
    # Max upload size (MB) accepted by the SOP ingestion endpoint.
    material_max_size_mb: int = 25

    # Foundry project for interviewer-agent sync (SPEC F5). Empty in dev/CI → no agent sync.
    default_agent_sync_provider: str = "mock"
    foundry_project_endpoint: str = ""
    # Fallback model for an interviewer agent whose persona has no model of its own. The agent's
    # model is chosen per persona in the agent editor; this env value is only the fallback and is
    # unrelated to the inference model below. MUST name a deployment on the target resource.
    foundry_agent_model: str = "gpt-6-luna"
    # The INFERENCE model: the in-interview judge and report scoring (and the SOP coverage audit /
    # document summaries, which share the same adapter). Independent of the agent's model. Real
    # value: the admin Connection tab's "Inference model" (DB) → JUDGE_MODEL in .env → this default.
    judge_model: str = JUDGE_MODEL_DEFAULT
    foundry_api_key: str = ""

    # Azure Foundry / Voice Live resource. The browser never talks to it directly: the backend's
    # /voice-live/ws proxy holds the Voice Live SDK connection.
    # Left empty in CI; the live values live only in the gitignored backend/.env.
    azure_foundry_endpoint: str = ""
    azure_foundry_api_key: str = ""
    azure_foundry_default_project: str = ""
    # Embedding model for SOP search (hybrid: BM25 + vectors, fused by rank). A deployment on the
    # AZURE_FOUNDRY_ENDPOINT resource; empty = keyword search only (dev and CI without Azure).
    sop_embedding_deployment: str = "text-embedding-3-small"
    sop_embedding_api_version: str = "2024-10-21"
    # Last-resort model Voice Live runs the session on (MODEL mode), after the Connection tab's
    # voice model override and the persona's own model (app.api.voice_live_ws.resolve_voice_model).
    # Voice Live only accepts models it hosts
    # natively in the resource's region (Learn: Speech regions → Voice Live tab) — NOT arbitrary
    # deployments. Project default gpt-6-luna; gpt-6-luna, gpt-6-sol and gpt-5-mini are all accepted
    # on Sweden Central (probed 2026-10-15, scripts/voice_live_model_probe.py — the list drifts, so
    # re-probe a new region). A rejected model fails with "Model X is not supported in this region".
    # Real value: persona.model → DB master → .env.
    voice_live_default_model: str = "gpt-6-luna"
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
    # Optional fixed avatar VIDEO bitrate (bits/s) for session.avatar.video.bitrate. Unset, the
    # backend picks it per session: a photo avatar on a weaker network (the page's hint: RTT over
    # 300 ms or loss over 0.5%) gets 300 kbit/s, everything else Azure's default (2 Mbps at 1080p):
    # voice_live_proxy.choose_avatar_bitrate, docs/network-grades.md. Set, it overrides that choice
    # for every session. The weak-network probe (2026-09-30) showed the sender ignores a
    # receiver-side SDP b=AS cap, so this is the only bandwidth lever, honoured at session creation.
    voice_live_avatar_video_bitrate: int | None = None
    # Voice Live closes a session after 900 s with no activity (error ``session_idle_timeout``,
    # measured live 2026-10-22: docs/avatar-rate-limit.md), and the candidate's silent microphone
    # audio does not count. After this many seconds without an event from Azure, the proxy sends
    # a no-op ``session.update`` (which does count) and keeps its echo from the browser. 0 turns
    # it off.
    voice_live_keepalive_seconds: int = 600

    # Application Insights in the Azure portal, for the admin Performance tab's links
    # (docs/planning/spec-admin-performance-tab.md). The deployment sets them
    # (container-apps.bicep); any one empty hides only the links that need it, so dev, CI and a
    # client tenant still work.
    monitor_tenant_id: str = ""
    monitor_subscription_id: str = ""
    monitor_resource_group: str = ""
    app_insights_name: str = ""
    # The Log Analytics workspace's customer id (a GUID). The end-to-end transaction link needs the
    # operation's first item, looked up through the Logs query API with the managed identity (role:
    # Log Analytics Data Reader on the workspace).
    log_analytics_workspace_id: str = ""
    # The Voice performance workbook's name (a GUID; voice-workbook.bicep). Empty hides its link.
    perf_workbook_id: str = ""

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
