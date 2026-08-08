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
