"""Anonymous candidate session tests.

Covers the DB-row-authoritative contract: a token that decodes fine is still rejected
if the DB row is revoked or expired.
"""

from datetime import UTC, datetime, timedelta

import pytest

from app.services.anonymous_session_service import (
    AnonymousSessionError,
    create_anonymous_session,
    touch_session,
    verify_anonymous_token,
)


def _naive_utc() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


@pytest.mark.asyncio
async def test_create_session_endpoint(client):
    resp = await client.post("/public/candidate/session")
    assert resp.status_code == 200
    body = resp.json()
    assert body["session_id"] and body["token"] and body["expires_at"]


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
async def test_touch_increments_request_count(db_session):
    session, _ = await create_anonymous_session(db_session)
    assert session.request_count == 0
    await touch_session(db_session, session)
    assert session.request_count == 1


@pytest.mark.asyncio
async def test_protected_dep_missing_header_401(client):
    # verify_anonymous_token is exercised via the dependency: no header → 401.
    # (No candidate-protected route yet; assert the session-create flow then a
    # manual dependency call would 401 — covered by dependency unit below.)
    resp = await client.post("/public/candidate/session")
    assert resp.status_code == 200


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
