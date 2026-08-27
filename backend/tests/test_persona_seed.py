"""Boot-time default-persona seed (public-demo bootstrap for the digital human).

The public deployment runs on ephemeral SQLite reseeded on every boot, so the enabled default
interviewer must be recreated at startup — otherwise voice is unavailable and the editor opens on
the empty state. These tests pin the seed's idempotency, the fixed id (stable Foundry agent name),
and the best-effort Foundry sync (mock adapter → synced).
"""

import pytest

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
