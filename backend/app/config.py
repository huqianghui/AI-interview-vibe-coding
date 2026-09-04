"""Application settings.

Runtime config precedence for Azure credentials/models is **DB > .env > code default**:
the ``service_configs`` master row (set via the admin config page) is overlaid onto this settings
singleton at startup and after each save (see ``services/config_overlay``), so production reads the
user's saved config; ``.env`` fills any gaps in dev; the code defaults below are the last resort.
Local dev runs fully on mock providers (see services/agents), so none of the Azure_* values are
required to boot.
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # App
    app_name: str = "AI Interview"
    debug: bool = False
    database_url: str = "sqlite+aiosqlite:///./ai_interview.db"

    # Auth
    secret_key: str = "dev-only-change-me"
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
    # Admin bearer token for persona/config admin routes (SPEC §67 role=admin). A single shared
    # token is enough for the PoC (no admin user-management UI yet); empty in dev disables the
    # guard's happy path so tests must set it explicitly. Never commit a real value (PUBLIC repo).
    admin_api_token: str = ""

    # Provider selection — mock keeps local dev + CI free of live Azure calls.
    default_llm_provider: str = "mock"
    default_voice_provider: str = "mock"
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
    # Azure resource. Neutral code default; the real value comes from the DB master config (admin
    # page) in prod, or FOUNDRY_AGENT_MODEL in .env for dev. NB: `gpt-4o` is NOT deployed on the
    # demo resource — set a deployed model (e.g. gpt-4o-mini, gpt-5.4-mini) via config or .env.
    foundry_agent_model: str = "gpt-4o"
    foundry_api_key: str = ""

    # Voice Live WebRTC broker (SPEC F9). The candidate's browser connects directly to Azure
    # Voice Live over WebRTC; the backend only brokers a short-lived credential (STS bearer) +
    # the signaling URL. Audio never transits the backend. `mock` keeps CI/dev free of Azure:
    # the broker returns a placeholder signaling config so the frontend flow is exercisable
    # without a live endpoint. `azure` does the real STS key→bearer exchange.
    # Provider selection reuses `default_voice_provider` (declared above).
    # Azure Foundry / Voice Live resource (same cognitive-services resource brokers voice).
    # Left empty in CI; the live values live only in the gitignored backend/.env.
    azure_foundry_endpoint: str = ""
    azure_foundry_api_key: str = ""
    azure_foundry_default_project: str = ""
    # Model Voice Live runs the session on. Same deployment constraint + precedence as
    # foundry_agent_model. Neutral code default; real value from DB master config or .env.
    voice_live_default_model: str = "gpt-4o"
    # Voice Live realtime api-version. Classic Foundry agents (what agent-sync currently creates)
    # require 2026-01-01-preview or 2025-10-01 — api-version 2026-04-10 and above reject them with
    # "Classic foundry agent is not supported" (live-verified 2026-08-11, swedencentral). The GA
    # 2026-07-15 value only works for model mode / migrated new-type agents.
    voice_live_api_version: str = "2026-01-01-preview"

    # External interview API/server (SPEC Phase 2, vendor-neutral). The backend drives the client's
    # interview brain turn-by-turn as an API client (never a Foundry-agent tool). Empty in CI/dev →
    # the mock external provider answers, so the flow is exercisable without a live gateway. Real
    # values live only in the gitignored backend/.env or the admin config UI (key Fernet-encrypted).
    # `user_tag` is a static per-deployment string prepended to the anonymized session id to form
    # the gateway `user` field, so the client can attribute traffic per environment.
    external_interviewer_endpoint: str = ""
    external_interviewer_api_key: str = ""
    external_interviewer_user_tag: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
