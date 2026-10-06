"""Auth + user/admin: login, me, role gate, admin user CRUD (Phase 1)."""

import pytest

from app.models.user import User
from app.services.auth_service import create_access_token, get_password_hash


async def _make_user(db, *, username, password="pw", role="user", is_active=True):
    u = User(
        username=username,
        email=f"{username}@local",
        hashed_password=get_password_hash(password),
        role=role,
        is_active=is_active,
    )
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


def _bearer(user):
    return {"Authorization": f"Bearer {create_access_token(data={'sub': user.id})}"}


async def test_login_success_and_me(client, db_session):
    await _make_user(db_session, username="alice", password="secret", role="user")
    resp = await client.post("/auth/login", json={"username": "alice", "password": "secret"})
    assert resp.status_code == 200
    token = resp.json()["access_token"]
    me = await client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    assert me.json()["username"] == "alice"
    assert me.json()["role"] == "user"


async def test_login_wrong_password_401(client, db_session):
    await _make_user(db_session, username="bob", password="right")
    resp = await client.post("/auth/login", json={"username": "bob", "password": "wrong"})
    assert resp.status_code == 401


async def test_login_unknown_user_401(client):
    resp = await client.post("/auth/login", json={"username": "ghost", "password": "x"})
    assert resp.status_code == 401


async def test_me_without_token_401(client):
    assert (await client.get("/auth/me")).status_code == 401


async def test_me_invalid_token_401(client):
    assert (
        await client.get("/auth/me", headers={"Authorization": "Bearer garbage"})
    ).status_code == 401


async def test_inactive_user_rejected(client, db_session):
    u = await _make_user(db_session, username="frozen", is_active=False)
    assert (await client.get("/auth/me", headers=_bearer(u))).status_code == 401


# --- role gate on an admin-only route (using the migrated /admin/users) ---


async def test_admin_route_forbidden_for_user_role(client, db_session):
    user = await _make_user(db_session, username="plainuser", role="user")
    assert (await client.get("/admin/users", headers=_bearer(user))).status_code == 403


async def test_admin_route_allows_admin(client, db_session):
    admin = await _make_user(db_session, username="rootadmin", role="admin")
    resp = await client.get("/admin/users", headers=_bearer(admin))
    assert resp.status_code == 200
    assert any(u["username"] == "rootadmin" for u in resp.json())


# --- admin user listing ---


async def test_admin_users_requires_auth(client):
    assert (await client.get("/admin/users")).status_code == 401


@pytest.mark.parametrize("role", ["user", "admin"])
async def test_password_is_hashed_not_plaintext(db_session, role):
    u = await _make_user(db_session, username=f"h-{role}", password="plaintext", role=role)
    assert u.hashed_password != "plaintext"
    from app.services.auth_service import verify_password

    assert verify_password("plaintext", u.hashed_password)


async def test_admin_users_list_filters(client, db_session):
    admin = await _make_user(db_session, username="lister", role="admin")
    await _make_user(db_session, username="zed-user", role="user")
    await _make_user(db_session, username="zed-off", role="user", is_active=False)
    auth = _bearer(admin)

    async def names(**params):
        resp = await client.get("/admin/users", headers=auth, params=params)
        assert resp.status_code == 200
        return {u["username"] for u in resp.json()}

    assert await names(search="zed") == {"zed-user", "zed-off"}
    assert await names(search="zed", is_active="true") == {"zed-user"}
    assert await names(role="admin") == {"lister"}
