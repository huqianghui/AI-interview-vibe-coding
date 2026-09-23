"""#102 — candidate login: derived passwords, the seeded accounts, the gated session endpoint,
the admin Users view, and the SECRET_KEY boot guard."""

import re
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.api.candidate_session import ADMIN_CANNOT_INTERVIEW
from app.config import Settings, get_settings
from app.models.anonymous_session import AnonymousCandidateSession
from app.models.user import User
from app.services.auth_service import (
    create_access_token,
    derive_candidate_password,
    get_password_hash,
    verify_password,
)
from app.services.user_seed import (
    CANDIDATE_USERNAMES,
    seed_default_candidates,
)

PW_RE = re.compile(r"^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$")


# ── derivation ──────────────────────────────────────────────────────────────────────────


def test_derived_password_is_deterministic_and_formatted():
    a = derive_candidate_password("user1", 1)
    assert a == derive_candidate_password("user1", 1)
    assert PW_RE.match(a), a


def test_derived_password_varies_by_user_generation_and_key(monkeypatch):
    base = derive_candidate_password("user1", 1)
    assert derive_candidate_password("user2", 1) != base
    assert derive_candidate_password("user1", 2) != base
    monkeypatch.setattr(get_settings(), "secret_key", "another-key-entirely")
    assert derive_candidate_password("user1", 1) != base


# ── SECRET_KEY guard ────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("bad", ["", "dev-only-change-me"])
def test_settings_refuse_missing_or_placeholder_secret_key(bad):
    with pytest.raises(ValueError, match="SECRET_KEY"):
        Settings(secret_key=bad, _env_file=None)


# ── seed ────────────────────────────────────────────────────────────────────────────────


async def test_seed_creates_three_candidates_with_derived_passwords(db_session):
    created = await seed_default_candidates(db_session)
    assert created == list(CANDIDATE_USERNAMES)
    rows = (await db_session.execute(select(User).where(User.role == "user"))).scalars().all()
    assert {u.username for u in rows} == set(CANDIDATE_USERNAMES)
    for u in rows:
        assert u.password_generation == 1 and u.is_active
        assert verify_password(derive_candidate_password(u.username, 1), u.hashed_password)


async def test_seed_is_idempotent_and_leaves_existing_rows_alone(db_session):
    db_session.add(
        User(
            username="user2",
            email="user2@local",
            hashed_password=get_password_hash("custom"),
            role="admin",
            is_active=False,
        )
    )
    await db_session.commit()
    created = await seed_default_candidates(db_session)
    assert created == ["user1", "user3"]
    assert await seed_default_candidates(db_session) == []
    user2 = (await db_session.execute(select(User).where(User.username == "user2"))).scalar_one()
    assert user2.role == "admin" and user2.is_active is False and user2.password_generation is None


# ── gated session endpoint ──────────────────────────────────────────────────────────────


async def test_session_401_without_or_with_invalid_bearer(client):
    assert (await client.post("/public/candidate/session")).status_code == 401
    bad = {"Authorization": "Bearer not-a-jwt"}
    assert (await client.post("/public/candidate/session", headers=bad)).status_code == 401


async def test_session_403_for_admin_account(client, admin_auth):
    resp = await client.post("/public/candidate/session", headers=admin_auth)
    assert resp.status_code == 403
    assert resp.json()["detail"] == ADMIN_CANNOT_INTERVIEW


async def test_session_401_for_deactivated_candidate(client, db_session):
    user = User(
        username="sleepy",
        email="sleepy@local",
        hashed_password=get_password_hash("pw"),
        role="user",
        is_active=False,
    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    hdr = {"Authorization": f"Bearer {create_access_token(data={'sub': user.id})}"}
    assert (await client.post("/public/candidate/session", headers=hdr)).status_code == 401


async def test_session_records_user_and_is_reused_while_active(client, candidate_auth, db_session):
    first = await client.post("/public/candidate/session", headers=candidate_auth)
    second = await client.post("/public/candidate/session", headers=candidate_auth)
    assert first.status_code == second.status_code == 200
    assert first.json()["session_id"] == second.json()["session_id"]
    row = (
        await db_session.execute(
            select(AnonymousCandidateSession).where(
                AnonymousCandidateSession.id == first.json()["session_id"]
            )
        )
    ).scalar_one()
    user = (
        await db_session.execute(select(User).where(User.username == "test-candidate"))
    ).scalar_one()
    assert row.user_id == user.id
    # both tokens are valid pointers to the same row
    for tok in (first.json()["token"], second.json()["token"]):
        r = await client.get("/candidate/interview/questions", headers={"X-Anon-Session": tok})
        assert r.status_code == 200


async def test_session_not_reused_when_expired_or_revoked(client, candidate_auth, db_session):
    first = (await client.post("/public/candidate/session", headers=candidate_auth)).json()
    row = (
        await db_session.execute(
            select(AnonymousCandidateSession).where(
                AnonymousCandidateSession.id == first["session_id"]
            )
        )
    ).scalar_one()
    row.expires_at = datetime.now(UTC).replace(tzinfo=None) - timedelta(minutes=1)
    await db_session.commit()
    second = (await client.post("/public/candidate/session", headers=candidate_auth)).json()
    assert second["session_id"] != first["session_id"]
    row2 = (
        await db_session.execute(
            select(AnonymousCandidateSession).where(
                AnonymousCandidateSession.id == second["session_id"]
            )
        )
    ).scalar_one()
    row2.is_revoked = True
    await db_session.commit()
    third = (await client.post("/public/candidate/session", headers=candidate_auth)).json()
    assert third["session_id"] not in {first["session_id"], second["session_id"]}


async def test_two_candidates_get_distinct_sessions(client, db_session):
    from tests.candidate_helpers import mint_candidate_headers

    a = await mint_candidate_headers(client, db_session)
    b = await mint_candidate_headers(client, db_session)
    assert a != b


# ── admin Users view ────────────────────────────────────────────────────────────────────


async def test_admin_list_shows_derived_password_only_for_seeded_candidates(
    client, admin_auth, db_session
):
    await seed_default_candidates(db_session)
    resp = await client.get("/admin/users", headers=admin_auth)
    assert resp.status_code == 200
    by_name = {u["username"]: u for u in resp.json()}
    for name in CANDIDATE_USERNAMES:
        assert by_name[name]["generated_password"] == derive_candidate_password(name, 1)
        assert by_name[name]["password_stale"] is False
    admin = by_name["test-admin"]
    assert admin["generated_password"] is None and admin["password_stale"] is False

    # SECRET_KEY rotated after seeding: the stored hash no longer matches today's derivation.
    # Simulated by re-hashing user1 with a different value (rotating the live key in-test would
    # also invalidate the admin JWT). No wrong password is ever shown — just "stale".
    user1_row = (
        await db_session.execute(select(User).where(User.username == "user1"))
    ).scalar_one()
    user1_row.hashed_password = get_password_hash("hash-from-the-previous-key")
    await db_session.commit()
    resp = await client.get("/admin/users", headers=admin_auth)
    assert resp.status_code == 200
    user1 = next(u for u in resp.json() if u["username"] == "user1")
    assert user1["generated_password"] is None and user1["password_stale"] is True


# ── login timing oracle (review R3) ─────────────────────────────────────────────────────


async def test_login_unknown_user_costs_a_bcrypt_verify_too(client, db_session):
    """Unknown username and wrong password both 401 and both pay one bcrypt check, so response
    time does not reveal whether an account exists (usernames user1..3 are public)."""
    import time

    db_session.add(
        User(username="known", email="known@local", hashed_password=get_password_hash("right"))
    )
    await db_session.commit()

    async def timed(username: str) -> tuple[int, float]:
        t0 = time.perf_counter()
        r = await client.post("/auth/login", json={"username": username, "password": "wrong"})
        return r.status_code, time.perf_counter() - t0

    s1, t_known = await timed("known")
    s2, t_unknown = await timed("nobody-here")
    assert s1 == s2 == 401
    # Both paths hash once; the unknown-user path must not be an order of magnitude faster.
    assert t_unknown > t_known / 4, (t_known, t_unknown)


# ── one live session per account, DB-enforced (review R2) ────────────────────────────────


async def test_second_live_session_for_one_account_is_refused_by_the_database(db_session):
    """The unique index on ``active_user_id`` is what makes idempotent creation race-safe."""
    from sqlalchemy.exc import IntegrityError

    from app.models.anonymous_session import AnonymousCandidateSession
    from app.services.anonymous_session_service import create_anonymous_session

    user = User(username="racer", email="racer@local", hashed_password=get_password_hash("pw"))
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)

    first, _ = await create_anonymous_session(db_session, user_id=user.id)
    assert first.active_user_id == user.id

    # Simulate the loser of the race: it already passed the "no live session" check, so it tries to
    # insert a second seat directly. The database must refuse it.
    db_session.add(
        AnonymousCandidateSession(
            ip_address="",
            expires_at=first.expires_at,
            last_activity_at=first.last_activity_at,
            request_count=0,
            is_revoked=False,
            user_id=user.id,
            active_user_id=user.id,
        )
    )
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


async def test_expired_seat_is_released_so_the_next_login_gets_a_fresh_session(db_session):
    """An expired row keeps ``active_user_id`` until the next login releases it — otherwise the
    unique index would turn "one live session" into "one session, ever"."""
    from app.services.anonymous_session_service import create_anonymous_session

    user = User(username="later", email="later@local", hashed_password=get_password_hash("pw"))
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)

    first, _ = await create_anonymous_session(db_session, user_id=user.id)
    first.expires_at = datetime.now(UTC).replace(tzinfo=None) - timedelta(minutes=1)
    await db_session.commit()

    second, _ = await create_anonymous_session(db_session, user_id=user.id)
    assert second.id != first.id
    assert second.active_user_id == user.id
    await db_session.refresh(first)
    assert first.active_user_id is None


async def test_revoking_releases_the_seat(db_session):
    from app.services.anonymous_session_service import create_anonymous_session, revoke_session

    user = User(username="revoked", email="revoked@local", hashed_password=get_password_hash("pw"))
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)

    first, _ = await create_anonymous_session(db_session, user_id=user.id)
    await revoke_session(db_session, first)
    assert first.active_user_id is None

    second, _ = await create_anonymous_session(db_session, user_id=user.id)
    assert second.id != first.id and second.active_user_id == user.id
