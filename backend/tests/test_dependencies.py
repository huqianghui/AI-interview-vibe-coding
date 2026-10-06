"""Request guards in ``app.dependencies`` and the SQLite connect hook in ``app.db``.

Every admin route and every candidate route sits behind one of these, so each rejection branch is
pinned directly: a token that decodes but names nobody, a deactivated account, the wrong role, a
missing or unknown candidate session.
"""

import pytest
from fastapi import HTTPException

from app.db import _sqlite_enable_foreign_keys
from app.dependencies import get_anonymous_session, get_current_user, require_role
from app.models.user import User
from app.services.auth_service import create_access_token, get_password_hash


async def _user(db, *, role: str = "admin", active: bool = True) -> User:
    user = User(
        username=f"{role}-{active}",
        email=f"{role}-{active}@local",
        hashed_password=get_password_hash("pw"),
        role=role,
        is_active=active,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


async def test_a_valid_token_resolves_its_user(db_session):
    user = await _user(db_session)
    token = create_access_token(data={"sub": user.id})
    assert (await get_current_user(token=token, db=db_session)).id == user.id


@pytest.mark.parametrize(
    "token",
    [
        "not-a-jwt",
        create_access_token(data={}),  # decodes, but names no user
        create_access_token(data={"sub": "no-such-user"}),
    ],
)
async def test_unresolvable_tokens_are_401(db_session, token):
    with pytest.raises(HTTPException) as exc:
        await get_current_user(token=token, db=db_session)
    assert exc.value.status_code == 401
    assert exc.value.headers == {"WWW-Authenticate": "Bearer"}


async def test_a_deactivated_account_is_401(db_session):
    user = await _user(db_session, active=False)
    with pytest.raises(HTTPException) as exc:
        await get_current_user(token=create_access_token(data={"sub": user.id}), db=db_session)
    assert exc.value.status_code == 401


async def test_the_wrong_role_is_403(db_session):
    candidate = await _user(db_session, role="user")
    with pytest.raises(HTTPException) as exc:
        await require_role("admin")(user=candidate)
    assert exc.value.status_code == 403


async def test_the_right_role_passes(db_session):
    admin = await _user(db_session)
    assert await require_role("admin")(user=admin) is admin


async def test_a_missing_candidate_session_header_is_401(db_session):
    with pytest.raises(HTTPException) as exc:
        await get_anonymous_session(x_anon_session=None, db=db_session)
    assert exc.value.status_code == 401


async def test_an_unknown_candidate_session_is_401(db_session):
    with pytest.raises(HTTPException) as exc:
        await get_anonymous_session(x_anon_session="garbage", db=db_session)
    assert exc.value.status_code == 401
    assert exc.value.detail == "Invalid anonymous token"


def test_sqlite_connections_enforce_foreign_keys_and_wait_on_locks():
    # Without foreign_keys SQLite silently ignores every FK; without busy_timeout a second writer
    # fails instantly with "database is locked" instead of waiting for the external-runner CAS.
    executed: list[str] = []

    class _Cursor:
        def execute(self, sql):
            executed.append(sql)

        def close(self):
            pass

    class _Conn:
        def cursor(self):
            return _Cursor()

    _sqlite_enable_foreign_keys(_Conn(), None)
    assert executed == ["PRAGMA foreign_keys=ON", "PRAGMA busy_timeout=5000"]
