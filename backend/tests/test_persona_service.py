"""Persona service (SPEC F5): CRUD + one-enabled-default invariant + sync bookkeeping."""

import pytest

from app.services import persona_service as svc


async def _mk(db, **kw):
    return await svc.create_persona(db, name=kw.pop("name", "P"), **kw)


async def test_create_and_get(db_session):
    p = await _mk(db_session, name="Ava", prompt_fragment="be kind")
    fetched = await svc.get_persona(db_session, p.id)
    assert fetched.name == "Ava"
    assert fetched.agent_sync_status == "none"


async def test_get_missing_raises(db_session):
    with pytest.raises(svc.PersonaNotFound):
        await svc.get_persona(db_session, "nope")


async def test_first_default_is_the_default(db_session):
    p = await _mk(db_session, name="D", is_default=True)
    assert (await svc.get_default_persona(db_session)).id == p.id


async def test_promoting_a_new_default_demotes_the_old_one(db_session):
    first = await _mk(db_session, name="first", is_default=True)
    second = await _mk(db_session, name="second", is_default=True)  # demotes first
    default = await svc.get_default_persona(db_session)
    assert default.id == second.id
    await db_session.refresh(first)
    assert first.is_default is False


async def test_set_default_switches_and_keeps_exactly_one(db_session):
    a = await _mk(db_session, name="a", is_default=True)
    b = await _mk(db_session, name="b")
    await svc.set_default(db_session, b.id)
    default = await svc.get_default_persona(db_session)
    assert default.id == b.id
    await db_session.refresh(a)
    assert a.is_default is False
    # exactly one enabled default overall
    all_enabled_defaults = [
        p for p in await svc.list_personas(db_session) if p.enabled and p.is_default
    ]
    assert len(all_enabled_defaults) == 1


async def test_disabled_default_frees_the_slot(db_session):
    # A disabled persona may keep is_default=True (exempt from the partial index); a new enabled
    # default can then coexist.
    old = await _mk(db_session, name="old", is_default=True)
    await svc.update_persona(db_session, old.id, enabled=False)  # disabled, still is_default
    new = await _mk(db_session, name="new", is_default=True)
    assert new.is_default and new.enabled
    await db_session.refresh(old)
    assert old.is_default is True and old.enabled is False


async def test_update_applies_arbitrary_fields(db_session):
    p = await _mk(db_session, name="x")
    updated = await svc.update_persona(
        db_session, p.id, voice_temperature=0.5, playback_speed=1.2, character="lisa"
    )
    assert updated.voice_temperature == 0.5
    assert updated.playback_speed == 1.2
    assert updated.character == "lisa"


async def test_list_enabled_only_filters_disabled(db_session):
    await _mk(db_session, name="on")
    off = await _mk(db_session, name="off")
    await svc.update_persona(db_session, off.id, enabled=False)
    enabled = await svc.list_personas(db_session, enabled_only=True)
    assert [p.name for p in enabled] == ["on"]
    assert len(await svc.list_personas(db_session)) == 2


async def test_update_can_promote_to_default(db_session):
    a = await _mk(db_session, name="a", is_default=True)
    b = await _mk(db_session, name="b")  # not default
    await svc.update_persona(db_session, b.id, is_default=True)  # promote via update
    default = await svc.get_default_persona(db_session)
    assert default.id == b.id
    await db_session.refresh(a)
    assert a.is_default is False


async def test_conflicting_enabled_defaults_translate_to_persona_conflict(db_session, monkeypatch):
    # Defense-in-depth: if the clear-first step is bypassed (e.g. a race), the DB partial-unique
    # index still fires and the service surfaces PersonaConflict, not a raw IntegrityError/500.
    await _mk(db_session, name="first", is_default=True)
    monkeypatch.setattr(svc, "_clear_enabled_defaults", _noop_clear)
    with pytest.raises(svc.PersonaConflict):
        await _mk(db_session, name="second", is_default=True)


async def _noop_clear(db, *, exclude_id):
    return None


async def test_sync_status_transitions(db_session):
    p = await _mk(db_session, name="s")
    await svc.mark_sync_pending(db_session, p)
    assert p.agent_sync_status == "pending"
    await svc.mark_sync_succeeded(db_session, p, agent_id="agent-1", agent_version="3")
    assert p.agent_sync_status == "synced"
    assert p.agent_id == "agent-1" and p.agent_version == "3"
    assert p.agent_sync_error is None


async def test_sync_failure_records_capped_error(db_session):
    p = await _mk(db_session, name="s")
    await svc.mark_sync_failed(db_session, p, error="boom " * 300)
    assert p.agent_sync_status == "failed"
    assert len(p.agent_sync_error) == 500


# --- reverse reconcile (pull Portal edits back) ----------------------------


class _StubAdapter:
    """Stubs the agent-sync adapter's reverse-read for reconcile tests."""

    def __init__(self, remote):
        self._remote = remote

    async def fetch_remote_state(self, persona):
        return self._remote


def _stub_adapter(monkeypatch, remote):
    """Patch registry.get_agent_sync_adapter (imported lazily inside reconcile_persona)."""
    monkeypatch.setattr(
        "app.services.agents.registry.get_agent_sync_adapter",
        lambda name=None: _StubAdapter(remote),
    )


async def test_reconcile_noop_when_never_synced(db_session, monkeypatch):
    # An unsynced persona (no agent_id/version) has no remote to reconcile against — no adapter hit.
    called = {"hit": False}

    def _boom(name=None):
        called["hit"] = True
        raise AssertionError("adapter must not be consulted for an unsynced persona")

    monkeypatch.setattr("app.services.agents.registry.get_agent_sync_adapter", _boom)
    p = await _mk(db_session, name="fresh")
    out = await svc.reconcile_persona(db_session, p)
    assert out.model is None
    assert called["hit"] is False


async def test_reconcile_noop_when_versions_match_and_model_set(db_session, monkeypatch):
    p = await _mk(db_session, name="matched")
    await svc.mark_sync_succeeded(db_session, p, agent_id="a", agent_version="10")
    p.model = "gpt-5.4-mini"
    await db_session.commit()
    _stub_adapter(monkeypatch, {"agent_version": "10", "model": "gpt-5.4-mini"})
    out = await svc.reconcile_persona(db_session, p)
    assert out.agent_version == "10"
    assert out.model == "gpt-5.4-mini"


async def test_reconcile_pulls_on_version_mismatch(db_session, monkeypatch):
    p = await _mk(db_session, name="drifted")
    await svc.mark_sync_succeeded(db_session, p, agent_id="a", agent_version="10")
    p.model = "gpt-5.4-mini"
    await db_session.commit()
    # Portal bumped the agent to v11 running a different model.
    _stub_adapter(monkeypatch, {"agent_version": "11", "model": "gpt-5"})
    out = await svc.reconcile_persona(db_session, p)
    assert out.agent_version == "11"
    assert out.model == "gpt-5"
    assert out.agent_sync_status == "synced"


async def test_reconcile_backfills_empty_model_even_when_version_matches(db_session, monkeypatch):
    # A row synced before the per-persona model column existed: version matches but model is null.
    p = await _mk(db_session, name="legacy")
    await svc.mark_sync_succeeded(db_session, p, agent_id="a", agent_version="10")
    assert p.model is None
    _stub_adapter(monkeypatch, {"agent_version": "10", "model": "gpt-5.4-mini"})
    out = await svc.reconcile_persona(db_session, p)
    assert out.model == "gpt-5.4-mini"


async def test_reconcile_noop_when_remote_unavailable(db_session, monkeypatch):
    p = await _mk(db_session, name="offline")
    await svc.mark_sync_succeeded(db_session, p, agent_id="a", agent_version="10")
    p.model = "gpt-5.4-mini"
    await db_session.commit()
    _stub_adapter(monkeypatch, None)  # adapter couldn't read the live agent
    out = await svc.reconcile_persona(db_session, p)
    assert out.agent_version == "10"
    assert out.model == "gpt-5.4-mini"


async def test_reconcile_pulls_portal_edited_instructions(db_session, monkeypatch):
    # The Portal's instructions differ from ours → a real Portal edit; pull it into prompt_fragment
    # even when the version happens to match (instructions alone can drift on a same-version read).
    p = await _mk(db_session, name="edited")
    await svc.mark_sync_succeeded(db_session, p, agent_id="a", agent_version="10")
    p.model = "gpt-5.4-mini"
    await db_session.commit()
    _stub_adapter(
        monkeypatch,
        {
            "agent_version": "11",
            "model": "gpt-5.4-mini",
            "instructions": "You are a strict interviewer. Ask follow-ups.",
        },
    )
    out = await svc.reconcile_persona(db_session, p)
    assert out.prompt_fragment == "You are a strict interviewer. Ask follow-ups."
    assert out.agent_version == "11"


async def test_reconcile_ignores_generated_default_instructions(db_session, monkeypatch):
    # The remote instructions equal the auto-generated fallback this app pushes for an empty
    # fragment — NOT a Portal edit. The fragment must stay empty (empty MEANS "using the default").
    from app.models.persona import default_instructions

    p = await _mk(db_session, name="Interviewer")
    await svc.mark_sync_succeeded(db_session, p, agent_id="a", agent_version="10")
    p.model = "gpt-5.4-mini"
    await db_session.commit()
    _stub_adapter(
        monkeypatch,
        {
            "agent_version": "10",
            "model": "gpt-5.4-mini",
            "instructions": default_instructions("Interviewer"),
        },
    )
    out = await svc.reconcile_persona(db_session, p)
    assert out.prompt_fragment == ""


async def test_reconcile_keeps_matching_instructions_untouched(db_session, monkeypatch):
    # Remote equals what we stored → nothing to pull (and no needless commit of the same value).
    p = await _mk(db_session, name="stable", prompt_fragment="Be kind but thorough.")
    await svc.mark_sync_succeeded(db_session, p, agent_id="a", agent_version="10")
    p.model = "gpt-5.4-mini"
    await db_session.commit()
    _stub_adapter(
        monkeypatch,
        {
            "agent_version": "10",
            "model": "gpt-5.4-mini",
            "instructions": "Be kind but thorough.",
        },
    )
    out = await svc.reconcile_persona(db_session, p)
    assert out.prompt_fragment == "Be kind but thorough."
    assert out.agent_version == "10"


async def test_reconcile_default_persona_propagates_model_to_master(db_session, monkeypatch):
    from app.services import config_service

    # A saved master row exists (endpoint/key/model). Reconciling the DEFAULT persona to a new model
    # must update the master row's model_or_deployment (runtime-override path).
    await config_service.upsert_master_config(
        db_session,
        endpoint="https://demo.services.ai.azure.com",
        api_key="k",
        default_project="demo-prj",
        model_or_deployment="gpt-5.4-mini",
        updated_by="admin",
    )
    await db_session.commit()

    p = await _mk(db_session, name="def", is_default=True)
    await svc.mark_sync_succeeded(db_session, p, agent_id="a", agent_version="10")
    p.model = "gpt-5.4-mini"
    await db_session.commit()

    # Overlay is a no-op-safe call in tests; stub it so we don't mutate the settings singleton.
    async def _noop_overlay(db):
        return True

    monkeypatch.setattr(
        "app.services.config_overlay.apply_master_config_to_settings", _noop_overlay
    )
    _stub_adapter(monkeypatch, {"agent_version": "11", "model": "gpt-5"})
    await svc.reconcile_persona(db_session, p)

    master = await config_service.get_master_config(db_session)
    assert master.model_or_deployment == "gpt-5"
