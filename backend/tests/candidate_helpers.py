"""Test helper (#102): mint an anonymous candidate session the way the frontend now does.

Creating a session requires a logged-in role=user account, so each call creates a FRESH candidate
user (ownership tests rely on two calls yielding two different candidates — session creation is
idempotent per user, so reusing one user would hand back the same session).
"""

import uuid

from app.models.user import User
from app.services.auth_service import create_access_token, get_password_hash

_HASH = get_password_hash("pw")  # bcrypt once per module; the password itself never matters here


async def new_candidate_bearer(db_session) -> dict:
    """Create a unique role=user account and return its JWT auth header."""
    user = User(
        username=f"cand-{uuid.uuid4().hex[:10]}",
        email=f"cand-{uuid.uuid4().hex[:10]}@local",
        hashed_password=_HASH,
        role="user",
    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    return {"Authorization": f"Bearer {create_access_token(data={'sub': user.id})}"}


async def mint_candidate_headers(client, db_session=None) -> dict:
    """POST /public/candidate/session as a fresh candidate → ``{"X-Anon-Session": token}``.

    ``db_session`` may be omitted when ``client`` came from the conftest fixture (it carries the
    session as ``client._db_session``).
    """
    db = db_session if db_session is not None else client._db_session
    bearer = await new_candidate_bearer(db)
    resp = await client.post("/public/candidate/session", headers=bearer)
    assert resp.status_code == 200, resp.text
    return {"X-Anon-Session": resp.json()["token"]}
