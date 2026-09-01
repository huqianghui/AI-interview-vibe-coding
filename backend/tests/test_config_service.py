"""Config service + encryption: master upsert, key round-trip, masking, preserve-on-empty."""

import pytest

from app.config import get_settings
from app.services import config_service
from app.services.config_service import InvalidEndpointError, validate_endpoint
from app.utils import encryption
from app.utils.encryption import EncryptionKeyMissing, decrypt_value, encrypt_value


@pytest.mark.parametrize(
    "endpoint",
    [
        "https://ai-foundry-x.services.ai.azure.com/",
        "https://x.openai.azure.com",
        "https://x.cognitiveservices.azure.com",
        "https://x.search.windows.net",
        "",  # empty clears config, allowed
    ],
)
def test_validate_endpoint_accepts_azure_hosts(endpoint):
    assert validate_endpoint(endpoint) == endpoint


@pytest.mark.parametrize(
    "endpoint",
    [
        "https://attacker.example.com",
        "http://169.254.169.254/metadata",  # metadata IP, and not https
        "https://x.services.ai.azure.com.evil.com",  # suffix-spoof
        "https://evil.com/x.services.ai.azure.com",  # path, not host
        "ftp://x.services.ai.azure.com",  # wrong scheme
    ],
)
def test_validate_endpoint_rejects_non_azure(endpoint):
    with pytest.raises(InvalidEndpointError):
        validate_endpoint(endpoint)


async def test_upsert_rejects_non_azure_endpoint_before_mutation(db_session):
    # Seed a valid config with a real key.
    await config_service.upsert_master_config(
        db_session,
        endpoint="https://good.services.ai.azure.com",
        api_key="original-key",
        default_project="p",
        model_or_deployment="gpt-4o-mini",
        updated_by="admin",
    )
    # Attempt the exfil shape: swap endpoint to attacker, empty key (would preserve the secret).
    with pytest.raises(InvalidEndpointError):
        await config_service.upsert_master_config(
            db_session,
            endpoint="https://attacker.example.com",
            api_key="",
            default_project="p",
            model_or_deployment="gpt-4o-mini",
            updated_by="admin",
        )
    # The stored row must be untouched — endpoint still the good one, key preserved.
    master = await config_service.get_master_config(db_session)
    assert master.endpoint == "https://good.services.ai.azure.com"
    assert await config_service.get_decrypted_key(db_session) == "original-key"


def test_encryption_fail_closed_when_not_debug(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "encryption_key", "")
    monkeypatch.setattr(s, "debug", False)
    encryption.reset_fernet_cache()
    with pytest.raises(EncryptionKeyMissing):
        encrypt_value("secret")
    encryption.reset_fernet_cache()  # clean up so later tests get a fresh instance


def test_encryption_round_trip_and_empty_passthrough():
    token = encrypt_value("super-secret")
    assert token and token != "super-secret"  # actually encrypted, not plaintext
    assert decrypt_value(token) == "super-secret"
    assert encrypt_value("") == ""
    assert decrypt_value("") == ""
    # A corrupt/unknown token degrades to empty instead of raising.
    assert decrypt_value("not-a-real-token") == ""


def test_mask_key():
    assert config_service.mask_key("") == ""
    assert config_service.mask_key("ab") == "****"
    assert config_service.mask_key("abcd1234") == "****1234"


async def test_upsert_creates_master_and_encrypts_key(db_session):
    master = await config_service.upsert_master_config(
        db_session,
        endpoint="https://foo.services.ai.azure.com",
        api_key="sekret-key-value",
        default_project="proj-x",
        model_or_deployment="gpt-4o-mini",
        updated_by="admin",
    )
    assert master.is_master is True
    assert master.is_active is True
    # Stored encrypted, not in plaintext.
    assert master.api_key_encrypted and master.api_key_encrypted != "sekret-key-value"
    assert await config_service.get_decrypted_key(db_session) == "sekret-key-value"


async def test_empty_api_key_preserves_existing_secret(db_session):
    await config_service.upsert_master_config(
        db_session,
        endpoint="https://foo.services.ai.azure.com",
        api_key="original-key",
        default_project="proj-x",
        model_or_deployment="gpt-4o-mini",
        updated_by="admin",
    )
    # Re-save other fields with an EMPTY api_key — the stored secret must survive.
    await config_service.upsert_master_config(
        db_session,
        endpoint="https://bar.services.ai.azure.com",
        api_key="",
        default_project="proj-y",
        model_or_deployment="gpt-5.4-mini",
        updated_by="admin",
    )
    master = await config_service.get_master_config(db_session)
    assert master is not None
    assert master.endpoint == "https://bar.services.ai.azure.com"  # other fields updated
    assert master.model_or_deployment == "gpt-5.4-mini"
    assert await config_service.get_decrypted_key(db_session) == "original-key"  # secret preserved


async def test_get_master_config_none_when_unconfigured(db_session):
    assert await config_service.get_master_config(db_session) is None
    assert await config_service.get_decrypted_key(db_session) == ""


async def test_seed_from_env_creates_row_when_absent(db_session, monkeypatch):
    """Ephemeral-SQLite boot: no row + Foundry env present → seed a key-less active master row."""
    s = get_settings()
    monkeypatch.setattr(s, "azure_foundry_endpoint", "https://seed.services.ai.azure.com")
    monkeypatch.setattr(s, "azure_foundry_default_project", "proj-boot")
    monkeypatch.setattr(s, "foundry_agent_model", "gpt-5.4-mini")

    master = await config_service.seed_master_config_from_env(db_session)
    assert master is not None
    assert master.endpoint == "https://seed.services.ai.azure.com"
    assert master.default_project == "proj-boot"
    assert master.model_or_deployment == "gpt-5.4-mini"
    assert master.is_active is True
    assert master.updated_by == "boot-seed"
    # Seeded key-less — the deployment authenticates to Foundry via managed identity.
    assert await config_service.get_decrypted_key(db_session) == ""


async def test_seed_from_env_is_noop_when_row_exists(db_session, monkeypatch):
    """Never clobber an operator's saved config (or a prior boot's seed)."""
    await config_service.upsert_master_config(
        db_session,
        endpoint="https://saved.services.ai.azure.com",
        api_key="operator-key",
        default_project="operator-proj",
        model_or_deployment="gpt-4o-mini",
        updated_by="admin",
    )
    s = get_settings()
    monkeypatch.setattr(s, "azure_foundry_endpoint", "https://seed.services.ai.azure.com")

    result = await config_service.seed_master_config_from_env(db_session)
    # Returns the existing row untouched — endpoint + key preserved.
    assert result is not None
    assert result.endpoint == "https://saved.services.ai.azure.com"
    assert await config_service.get_decrypted_key(db_session) == "operator-key"


async def test_seed_from_env_noop_without_foundry_endpoint(db_session, monkeypatch):
    """Mock / public-demo deploy (no Foundry env) stays unconfigured — no phantom row."""
    s = get_settings()
    monkeypatch.setattr(s, "azure_foundry_endpoint", "")
    monkeypatch.setattr(s, "foundry_project_endpoint", "")

    assert await config_service.seed_master_config_from_env(db_session) is None
    assert await config_service.get_master_config(db_session) is None
