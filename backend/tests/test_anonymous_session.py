"""Anonymous candidate session tests.

Covers the DB-row-authoritative contract: a token that decodes fine is still rejected
if the DB row is revoked or expired.
"""

from datetime import UTC, datetime, timedelta

import pytest
from jose import jwt
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

import app.services.anonymous_session_service as svc
from app.config import get_settings
from app.models.user import User
from app.services.anonymous_session_service import (
    ANON_TOKEN_TYPE,
    AnonymousSessionError,
    create_anonymous_session,
    revoke_session,
    verify_anonymous_token,
)
from app.services.auth_service import create_access_token
from tests.candidate_helpers import new_candidate_bearer


def _naive_utc() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


async def _user(db, username: str) -> User:
    await new_candidate_bearer(db, username=username)
    return (await db.execute(select(User).where(User.username == username))).scalar_one()


@pytest.mark.asyncio
async def test_create_session_endpoint(client, candidate_auth):
    # #102: minting a session requires a logged-in role=user candidate.
    resp = await client.post("/public/candidate/session", headers=candidate_auth)
    assert resp.status_code == 200
    body = resp.json()
    assert body["session_id"] and body["token"] and body["expires_at"]


@pytest.mark.asyncio
async def test_create_session_requires_candidate_login(client):
    resp = await client.post("/public/candidate/session")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_verify_valid_token(db_session):
    session, token = await create_anonymous_session(db_session, ip_address="1.2.3.4")
    verified = await verify_anonymous_token(db_session, token)
    assert verified.id == session.id


@pytest.mark.asyncio
async def test_verify_rejects_garbage_token(db_session):
    with pytest.raises(AnonymousSessionError):
        await verify_anonymous_token(db_session, "not.a.jwt")


@pytest.mark.asyncio
async def test_revoked_session_rejected_even_with_valid_jwt(db_session):
    session, token = await create_anonymous_session(db_session)
    session.is_revoked = True
    await db_session.commit()
    with pytest.raises(AnonymousSessionError, match="revoked"):
        await verify_anonymous_token(db_session, token)


@pytest.mark.asyncio
async def test_expired_row_rejected(db_session):
    session, token = await create_anonymous_session(db_session)
    session.expires_at = _naive_utc() - timedelta(minutes=1)
    await db_session.commit()
    with pytest.raises(AnonymousSessionError, match="expired"):
        await verify_anonymous_token(db_session, token)


@pytest.mark.asyncio
async def test_get_anonymous_session_dependency_missing_header(db_session):
    from fastapi import HTTPException

    from app.dependencies import get_anonymous_session

    with pytest.raises(HTTPException) as exc:
        await get_anonymous_session(x_anon_session=None, db=db_session)
    assert exc.value.status_code == 401


@pytest.mark.asyncio
async def test_get_anonymous_session_dependency_valid(db_session):
    from app.dependencies import get_anonymous_session

    _, token = await create_anonymous_session(db_session)
    session = await get_anonymous_session(x_anon_session=token, db=db_session)
    assert session.id


# --- token shape + revocation -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_user_jwt_is_not_an_anonymous_token(db_session):
    # An admin/candidate login JWT decodes with the same key; only typ=anon may open a session.
    with pytest.raises(AnonymousSessionError, match="Wrong token type"):
        await verify_anonymous_token(db_session, create_access_token(data={"sub": "u1"}))


@pytest.mark.asyncio
async def test_an_anon_token_without_a_session_id_is_rejected(db_session):
    s = get_settings()
    token = jwt.encode({"typ": ANON_TOKEN_TYPE}, s.secret_key, algorithm=s.algorithm)
    with pytest.raises(AnonymousSessionError, match="missing sid"):
        await verify_anonymous_token(db_session, token)


@pytest.mark.asyncio
async def test_revoked_session_is_rejected_and_frees_the_seat(db_session):
    user = await _user(db_session, "revoker")
    first, token = await create_anonymous_session(db_session, user_id=user.id)
    await revoke_session(db_session, first)

    with pytest.raises(AnonymousSessionError, match="revoked"):
        await verify_anonymous_token(db_session, token)
    fresh, _ = await create_anonymous_session(db_session, user_id=user.id)
    assert fresh.id != first.id and fresh.active_user_id == user.id


# --- the seat race (review R2) ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_losing_the_seat_race_reuses_the_winners_session(db_session, monkeypatch):
    """Two first logins at once: the loser's insert hits the unique seat index, and it must come
    back with the WINNER's session instead of a 500 or a second live seat."""
    user = await _user(db_session, "racer")
    winner, _ = await create_anonymous_session(db_session, user_id=user.id)

    real_find = svc.find_active_session_for_user
    calls = {"n": 0}

    async def _blind_first_lookup(db, user_id):
        # The loser's lookup ran before the winner committed, so it saw no live session.
        calls["n"] += 1
        return None if calls["n"] == 1 else await real_find(db, user_id)

    monkeypatch.setattr(svc, "find_active_session_for_user", _blind_first_lookup)
    loser, _ = await create_anonymous_session(db_session, user_id=user.id)
    assert loser.id == winner.id


@pytest.mark.asyncio
async def test_an_insert_conflict_without_a_user_is_not_swallowed(db_session, monkeypatch):
    # Only the per-account seat race has a winner to fall back to; any other integrity error must
    # surface rather than return something that looks like a session.
    async def _conflict():
        raise IntegrityError("INSERT", {}, Exception("boom"))

    monkeypatch.setattr(db_session, "commit", _conflict)
    with pytest.raises(IntegrityError):
        await create_anonymous_session(db_session, ip_address="1.2.3.4")
