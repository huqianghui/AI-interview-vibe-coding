"""Admin "Interview results" list: every candidate's interviews, filtered, sorted, paged."""

from datetime import datetime

import pytest

from app.models.anonymous_session import AnonymousCandidateSession
from app.models.interview import InterviewSession
from app.models.user import User
from app.services import persona_service, question_service

pytestmark = pytest.mark.asyncio


async def _world(db):
    """Two users, two personas, two banks, and five interviews with known fields."""
    ava = await persona_service.create_persona(db, name="Ava")
    ben = await persona_service.create_persona(db, name="Ben")
    bank_a = await question_service.create_bank(db, name="Bank A")
    bank_b = await question_service.create_bank(db, name="Bank B")
    users = []
    for name in ("alice", "bob"):
        u = User(username=name, email=f"{name}@local", hashed_password="x", role="user")
        db.add(u)
        users.append(u)
    await db.flush()
    sessions = []
    for u in users:
        c = AnonymousCandidateSession(
            user_id=u.id, expires_at=datetime(2030, 1, 1), last_activity_at=datetime(2026, 1, 1)
        )
        db.add(c)
        sessions.append(c)
    anon = AnonymousCandidateSession(
        expires_at=datetime(2030, 1, 1), last_activity_at=datetime(2026, 1, 1)
    )
    db.add(anon)
    await db.flush()

    def iv(cand, day, status, persona, bank, score=None, outcome=None):
        return InterviewSession(
            candidate_session_id=cand.id,
            status=status,
            started_at=datetime(2026, 10, day, 9, 0),
            persona_id=persona.id if persona else None,
            bank_id=bank.id if bank else None,
            total_score=score,
            outcome=outcome,
            report_json="{}" if score is not None else None,
        )

    rows = {
        "a1": iv(sessions[0], 1, "scored", ava, bank_a, 82, "Meets Expectations"),
        "a2": iv(sessions[0], 3, "abandoned", ava, bank_b),
        "b1": iv(sessions[1], 2, "scored", ben, bank_a, 41, "Does Not Meet"),
        "b2": iv(sessions[1], 5, "in_progress", ben, bank_b),
        "x1": iv(anon, 4, "completed", None, None),
    }
    db.add_all(rows.values())
    await db.commit()
    return {"rows": rows, "users": users, "ava": ava, "bank_a": bank_a}


async def _ids(client, auth, **params):
    resp = await client.get("/admin/interviews", headers=auth, params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _keys(page, rows):
    by_id = {v.id: k for k, v in rows.items()}
    return [by_id[i["id"]] for i in page["items"]]


async def test_lists_everyone_newest_first_with_who_and_what(client, db_session, admin_auth):
    w = await _world(db_session)
    page = await _ids(client, admin_auth)
    assert page["total"] == 5
    assert _keys(page, w["rows"]) == ["b2", "x1", "a2", "b1", "a1"]
    first = page["items"][0]
    assert first["username"] == "bob" and first["persona_name"] == "Ben"
    assert first["bank_name"] == "Bank B"
    anon = page["items"][1]
    assert anon["user_id"] is None and anon["username"] is None  # anonymous candidate


async def test_every_filter_narrows_the_list(client, db_session, admin_auth):
    w = await _world(db_session)
    rows = w["rows"]
    alice = w["users"][0].id
    cases = [
        ({"user_id": alice}, ["a2", "a1"]),
        ({"status": ["scored", "abandoned"]}, ["a2", "b1", "a1"]),
        ({"persona_id": w["ava"].id}, ["a2", "a1"]),
        ({"bank_id": w["bank_a"].id}, ["b1", "a1"]),
        ({"started_from": "2026-10-02", "started_to": "2026-10-04"}, ["x1", "a2", "b1"]),
        ({"outcome": "Does Not Meet"}, ["b1"]),
        ({"score_min": 50}, ["a1"]),
        ({"score_max": 50}, ["b1"]),
        ({"user_id": alice, "status": "scored"}, ["a1"]),  # filters combine (AND)
    ]
    for params, expected in cases:
        page = await _ids(client, admin_auth, **params)
        assert _keys(page, rows) == expected, params
        assert page["total"] == len(expected)


async def test_sort_by_score_puts_unscored_last_both_ways(client, db_session, admin_auth):
    w = await _world(db_session)
    high = await _ids(client, admin_auth, sort="total_score", order="desc")
    assert _keys(high, w["rows"])[:2] == ["a1", "b1"]
    low = await _ids(client, admin_auth, sort="total_score", order="asc")
    assert _keys(low, w["rows"])[:2] == ["b1", "a1"]


async def test_pages_split_the_list_and_total_stays_the_same(client, db_session, admin_auth):
    w = await _world(db_session)
    p1 = await _ids(client, admin_auth, limit=2, offset=0)
    p2 = await _ids(client, admin_auth, limit=2, offset=2)
    p3 = await _ids(client, admin_auth, limit=2, offset=4)
    assert [p["total"] for p in (p1, p2, p3)] == [5, 5, 5]
    keys = _keys(p1, w["rows"]) + _keys(p2, w["rows"]) + _keys(p3, w["rows"])
    assert keys == ["b2", "x1", "a2", "b1", "a1"]  # no row twice, none missing


@pytest.mark.parametrize(
    "params",
    [
        {"status": "nope"},
        {"outcome": "Great"},
        {"started_from": "2026-10-05", "started_to": "2026-10-01"},
        {"score_min": 80, "score_max": 20},
        {"score_min": 120},
        {"sort": "name"},
        {"order": "up"},
        {"limit": 0},
        {"limit": 101},
        {"offset": -1},
    ],
)
async def test_bad_parameters_are_422(client, admin_auth, params):
    resp = await client.get("/admin/interviews", headers=admin_auth, params=params)
    assert resp.status_code == 422, params
