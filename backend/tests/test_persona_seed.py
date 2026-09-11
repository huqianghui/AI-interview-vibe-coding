"""Boot-time default-persona seed (public-demo bootstrap for the digital human).

The public deployment runs on ephemeral SQLite reseeded on every boot, so the enabled default
interviewer must be recreated at startup — otherwise voice is unavailable and the editor opens on
the empty state. These tests pin the seed's idempotency, the fixed id (stable Foundry agent name),
and the best-effort Foundry sync (mock adapter → synced).
"""

import pytest

from app.config import get_settings
from app.services import persona_service as svc
from app.services.persona_seed import (
    DEFAULT_PERSONA_ID,
    DEFAULT_PERSONA_NAME,
    seed_default_persona,
    sync_default_persona,
)


async def test_seed_creates_enabled_default_with_fixed_id(db_session):
    persona = await seed_default_persona(db_session)
    assert persona is not None
    # Fixed id ⇒ the sync adapter's agent name (interviewer-<id>) is stable across ephemeral-DB
    # reboots, so create-or-update reuses one Foundry agent instead of minting orphans.
    assert persona.id == DEFAULT_PERSONA_ID
    assert persona.name == DEFAULT_PERSONA_NAME
    assert persona.enabled is True and persona.is_default is True
    # It is THE default the voice broker / editor resolve.
    default = await svc.get_default_persona(db_session)
    assert default is not None and default.id == DEFAULT_PERSONA_ID
    # model left unset → runtime falls back to settings.foundry_agent_model (deployment param).
    assert persona.model is None
    # Not synced yet — sync_default_persona does that separately.
    assert persona.agent_sync_status == "none"


async def test_seed_is_idempotent(db_session):
    first = await seed_default_persona(db_session)
    again = await seed_default_persona(db_session)
    assert again is not None and again.id == first.id
    # No duplicate row.
    all_personas = await svc.list_personas(db_session)
    assert [p.id for p in all_personas].count(DEFAULT_PERSONA_ID) == 1


async def test_seed_is_noop_when_another_enabled_default_exists(db_session):
    # An operator already configured a different enabled default — the seed must respect it and not
    # fight the single-enabled-default invariant.
    other = await svc.create_persona(db_session, name="Ops default", is_default=True)
    result = await seed_default_persona(db_session)
    assert result is None
    default = await svc.get_default_persona(db_session)
    assert default is not None and default.id == other.id


# --- SEED_PERSONA_BRAIN / SEED_PERSONA_READER_PROMPT (env-driven brain for the seeded persona) ---
#
# Ephemeral SQLite reseeds the default persona every boot; without these, an external-brain
# deployment reverts to bank mode on every restart and needs a manual editor toggle. Mirrors the
# seed_external_config_from_env pattern for the endpoint row.


async def test_seed_defaults_to_bank_brain_with_no_reader_prompt(db_session):
    persona = await seed_default_persona(db_session)
    assert persona is not None
    assert persona.interview_brain == "bank"
    # NULL = "unset, use default_external_reader_prompt(name)" — never coerced to "".
    assert persona.external_reader_prompt is None


async def test_seed_persona_brain_env_makes_the_seeded_default_external(db_session, monkeypatch):
    monkeypatch.setattr(get_settings(), "seed_persona_brain", "external")
    persona = await seed_default_persona(db_session)
    assert persona is not None
    assert persona.interview_brain == "external"
    # Reader prompt not seeded → stays NULL → the proxy injects the generated default contract.
    assert persona.external_reader_prompt is None


async def test_seed_persona_reader_prompt_env_seeds_the_reading_contract(db_session, monkeypatch):
    monkeypatch.setattr(get_settings(), "seed_persona_brain", "external")
    monkeypatch.setattr(get_settings(), "seed_persona_reader_prompt", "read exactly, then wait")
    persona = await seed_default_persona(db_session)
    assert persona is not None
    assert persona.external_reader_prompt == "read exactly, then wait"


async def test_seed_persona_brain_invalid_value_falls_back_to_bank(db_session, monkeypatch, caplog):
    # A typo'd env var must not seed an invalid brain (the API validator would never allow it) —
    # fall back to bank and say so in the log, never crash boot.
    monkeypatch.setattr(get_settings(), "seed_persona_brain", "dify")
    persona = await seed_default_persona(db_session)
    assert persona is not None
    assert persona.interview_brain == "bank"
    assert "SEED_PERSONA_BRAIN" in caplog.text


async def test_sync_default_persona_marks_synced_via_mock_adapter(db_session):
    # The default adapter in tests is the mock (returns a synced mock-agent). After seed + sync the
    # persona is "synced", which is what the voice P5 gate requires.
    await seed_default_persona(db_session)
    await sync_default_persona(db_session)
    default = await svc.get_default_persona(db_session)
    assert default is not None
    assert default.agent_sync_status == "synced"
    assert default.agent_id and default.agent_id.startswith("mock-agent-")


async def test_sync_default_persona_is_noop_when_no_default(db_session):
    # Nothing seeded and no default configured → sync is a quiet no-op (never raises).
    await sync_default_persona(db_session)  # must not raise
    assert await svc.get_default_persona(db_session) is None


async def test_sync_default_persona_swallows_adapter_failure(db_session, monkeypatch):
    # A Foundry sync failure must be recorded as failed (text-only degrade), never propagate.
    await seed_default_persona(db_session)

    class _BoomAdapter:
        async def sync_persona(self, persona, *, knowledge_configs):
            raise RuntimeError("foundry unreachable")

    # _sync binds get_agent_sync_adapter at import in admin_personas, so patch it there.
    monkeypatch.setattr(
        "app.api.admin_personas.get_agent_sync_adapter", lambda name=None: _BoomAdapter()
    )
    await sync_default_persona(db_session)  # must not raise
    default = await svc.get_default_persona(db_session)
    assert default is not None
    assert default.agent_sync_status == "failed"
    assert "foundry unreachable" in (default.agent_sync_error or "")


@pytest.mark.parametrize("second_call", [False, True])
async def test_sync_skips_when_already_synced(db_session, second_call, monkeypatch):
    await seed_default_persona(db_session)
    await sync_default_persona(db_session)  # → synced via mock

    calls = {"n": 0}

    class _CountingAdapter:
        async def sync_persona(self, persona, *, knowledge_configs):
            calls["n"] += 1
            return {"agent_id": "mock-agent-x", "agent_version": "1"}

    monkeypatch.setattr(
        "app.api.admin_personas.get_agent_sync_adapter",
        lambda name=None: _CountingAdapter(),
    )
    if second_call:
        await sync_default_persona(db_session)
    # Already synced ⇒ the adapter is not consulted again.
    assert calls["n"] == 0
