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

    # Foundry project for interviewer-agent sync (SPEC F5). Empty in dev/CI → no agent sync.
    default_agent_sync_provider: str = "mock"
    foundry_project_endpoint: str = ""
    foundry_agent_model: str = "gpt-4o"
    foundry_api_key: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
