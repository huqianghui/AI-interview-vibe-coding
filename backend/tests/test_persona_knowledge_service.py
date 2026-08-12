"""Per-persona knowledge-config service (SPEC F5): CRUD + the adapter shape helper."""

import pytest

from app.services import persona_knowledge_service as kb
from app.services import persona_service as svc


async def _persona(db, name="P"):
    return await svc.create_persona(db, name=name)


async def test_add_and_list(db_session):
    p = await _persona(db_session)
    assert await kb.list_configs(db_session, p.id) == []

    cfg = await kb.add_config(
        db_session,
        p.id,
        connection_name="search-conn",
        connection_target="https://s.search.windows.net",
        index_name="sop-kb",
    )
    # server_label is derived from the index name.
    assert cfg.server_label == "knowledge-base-sop-kb"
    assert cfg.is_enabled is True

    listed = await kb.list_configs(db_session, p.id)
    assert [c.index_name for c in listed] == ["sop-kb"]


async def test_multiple_kbs_ordered(db_session):
    p = await _persona(db_session)
    await kb.add_config(
        db_session, p.id, connection_name="c", connection_target="t", index_name="a"
    )
    await kb.add_config(
        db_session, p.id, connection_name="c", connection_target="t", index_name="b"
    )
    listed = await kb.list_configs(db_session, p.id)
    assert [c.index_name for c in listed] == ["a", "b"]


async def test_remove(db_session):
    p = await _persona(db_session)
    cfg = await kb.add_config(
        db_session, p.id, connection_name="c", connection_target="t", index_name="kb"
    )
    removed = await kb.remove_config(db_session, cfg.id)
    assert removed.persona_id == p.id
    assert await kb.list_configs(db_session, p.id) == []


async def test_remove_missing_raises(db_session):
    with pytest.raises(kb.PersonaKnowledgeNotFound):
        await kb.remove_config(db_session, "nope")


async def test_get_missing_raises(db_session):
    with pytest.raises(kb.PersonaKnowledgeNotFound):
        await kb.get_config(db_session, "nope")


async def test_configs_as_dicts_shape(db_session):
    p = await _persona(db_session)
    await kb.add_config(
        db_session,
        p.id,
        connection_name="search-conn",
        connection_target="https://s",
        index_name="kb1",
    )
    dicts = kb.configs_as_dicts(await kb.list_configs(db_session, p.id))
    assert dicts == [
        {
            "connection_target": "https://s",
            "index_name": "kb1",
            "server_label": "knowledge-base-kb1",
            "is_enabled": True,
        }
    ]


async def test_configs_isolated_per_persona(db_session):
    p1 = await _persona(db_session, name="one")
    p2 = await _persona(db_session, name="two")
    await kb.add_config(
        db_session, p1.id, connection_name="c", connection_target="t", index_name="x"
    )
    assert [c.index_name for c in await kb.list_configs(db_session, p1.id)] == ["x"]
    assert await kb.list_configs(db_session, p2.id) == []
