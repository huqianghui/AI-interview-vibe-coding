"""Application settings.

DB-backed ServiceConfig is the source of truth for Azure credentials at runtime; these
env-backed settings are bootstrap/fallback plus non-secret app config. Local dev runs fully
on mock providers (see services/agents), so none of the Azure_* values are required to boot.
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
    algorithm: str = "HS256"
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

    # SOP blob storage (F1). Raw uploads live here, never in the DB and never handed to candidates
    # directly (P4). Local filesystem in dev/CI; a blob backend can be swapped in prod.
    default_storage_provider: str = "local"
    material_storage_path: str = "./_sop_storage"
    # Max upload size (MB) accepted by the SOP ingestion endpoint.
    material_max_size_mb: int = 25

    # Foundry project for interviewer-agent sync (SPEC F5). Empty in dev/CI → no agent sync.
    default_agent_sync_provider: str = "mock"
    foundry_project_endpoint: str = ""
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
    voice_live_default_model: str = "gpt-4o"
    # Voice Live / Foundry Agents GA api-version. Matches the reference project's proven value
    # (GA 2026-07-13, azure-ai-voicelive SDK 1.3.0) — do NOT regress to an older preview literal.
    voice_live_api_version: str = "2026-07-15"


@lru_cache
def get_settings() -> Settings:
    return Settings()
