"""The interviewer shown before an interview exists: sign-in (default), idle (the caller's own)."""

import uuid

import pytest

from app.models.user import User
from app.services import persona_service
from app.services.auth_service import create_access_token, get_password_hash

pytestmark = pytest.mark.asyncio

_HASH = get_password_hash("pw")


async def _login(client, db) -> tuple[User, dict]:
    name = f"cand-{uuid.uuid4().hex[:10]}"
    user = User(username=name, email=f"{name}@local", hashed_password=_HASH, role="user")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    bearer = {"Authorization": f"Bearer {create_access_token(data={'sub': user.id})}"}
    resp = await client.post("/public/candidate/session", headers=bearer)
    assert resp.status_code == 200, resp.text
    return user, {"X-Anon-Session": resp.json()["token"]}


async def test_public_returns_the_default_personas_character_without_auth(client, db_session):
    await persona_service.create_persona(db_session, name="Other", character="sakura")
    await persona_service.create_persona(
        db_session, name="Default", character=" Lisa ", is_default=True
    )

    resp = await client.get("/public/interviewer")

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"character": "lisa"}


async def test_public_is_blank_with_no_default_persona(client):
    resp = await client.get("/public/interviewer")
    assert resp.json() == {"character": ""}


async def test_candidate_gets_their_assigned_persona_not_the_default(
    client, db_session, admin_auth
):
    await persona_service.create_persona(
        db_session, name="Default", character="sakura", is_default=True
    )
    assigned = await persona_service.create_persona(db_session, name="X", character="lisa")
    user, headers = await _login(client, db_session)
    resp = await client.patch(
        f"/admin/users/{user.id}/assignment", headers=admin_auth, json={"persona_id": assigned.id}
    )
    assert resp.status_code == 200, resp.text

    mine = await client.get("/candidate/interviewer", headers=headers)
    assert mine.json() == {"character": "lisa"}
    # ...and it is the persona the interview then starts with.
    start = await client.post("/candidate/interview/start", headers=headers)
    assert start.json()["voice_avatar_character"] == "lisa"


async def test_candidate_without_an_assignment_gets_the_default(client, db_session):
    await persona_service.create_persona(
        db_session, name="Default", character="lisa", is_default=True
    )
    _, headers = await _login(client, db_session)

    resp = await client.get("/candidate/interviewer", headers=headers)
    assert resp.json() == {"character": "lisa"}


async def test_candidate_endpoint_requires_a_valid_session(client):
    assert (await client.get("/candidate/interviewer")).status_code == 401
    bogus = {"X-Anon-Session": "not-a-token"}
    assert (await client.get("/candidate/interviewer", headers=bogus)).status_code == 401


@pytest.mark.parametrize("gone", ["disabled", "deleted"])
async def test_an_unusable_assignment_falls_back_to_the_default(
    client, db_session, admin_auth, gone
):
    """The idle screen must name whoever a start would actually pin, not the stale assignment."""
    await persona_service.create_persona(
        db_session, name="Default", character="lisa", is_default=True
    )
    assigned = await persona_service.create_persona(db_session, name="X", character="harry")
    user, headers = await _login(client, db_session)
    await client.patch(
        f"/admin/users/{user.id}/assignment", headers=admin_auth, json={"persona_id": assigned.id}
    )
    if gone == "disabled":
        assigned.enabled = False
    else:
        await db_session.delete(assigned)
    await db_session.commit()

    resp = await client.get("/candidate/interviewer", headers=headers)
    assert resp.json() == {"character": "lisa"}


async def test_a_default_persona_without_a_character_reads_blank(client, db_session):
    """Blank tells the page to show the same default avatar the voice session falls back to."""
    await persona_service.create_persona(db_session, name="Default", is_default=True)
    assert (await client.get("/public/interviewer")).json() == {"character": ""}
