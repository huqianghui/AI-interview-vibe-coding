"""Admin question-bank editor (SPEC F2b): CRUD, reorder, set-default over HTTP + auth guard."""

import pytest

# Populated per-test by the autouse fixture with a real admin JWT header (see conftest.admin_auth).
AUTH: dict = {}


@pytest.fixture(autouse=True)
def _admin_token(admin_auth):
    AUTH.clear()
    AUTH.update(admin_auth)
    yield


async def test_routes_require_a_token(client):
    assert (await client.get("/admin/question-banks")).status_code == 401
    assert (await client.post("/admin/question-banks", json={"name": "x"})).status_code == 401


async def test_bank_and_question_crud(client):
    # Create bank (default), add questions, list them.
    bank = (
        await client.post(
            "/admin/question-banks",
            headers=AUTH,
            json={"name": "Editor Bank", "is_default": True},
        )
    ).json()
    assert bank["is_default"] is True
    bank_id = bank["bank_id"]

    q1 = (
        await client.post(
            f"/admin/question-banks/{bank_id}/questions",
            headers=AUTH,
            json={"text": "Q one?", "expected_points": ["a"]},
        )
    ).json()
    q2 = (
        await client.post(
            f"/admin/question-banks/{bank_id}/questions",
            headers=AUTH,
            json={"text": "Q two?"},
        )
    ).json()
    assert q1["order_index"] == 0 and q2["order_index"] == 1
    # expected_points round-trips (admin surface — candidate API never shows it).
    assert q1["expected_points"] == ["a"]

    listing = (await client.get(f"/admin/question-banks/{bank_id}/questions", headers=AUTH)).json()
    assert [q["text"] for q in listing] == ["Q one?", "Q two?"]


async def test_edit_and_delete_question(client):
    bank = (await client.post("/admin/question-banks", headers=AUTH, json={"name": "B"})).json()
    bank_id = bank["bank_id"]
    q = (
        await client.post(
            f"/admin/question-banks/{bank_id}/questions", headers=AUTH, json={"text": "orig"}
        )
    ).json()
    qid = q["question_id"]

    edited = (
        await client.patch(
            f"/admin/question-banks/questions/{qid}",
            headers=AUTH,
            json={"text": "edited", "max_follow_ups": 2},
        )
    ).json()
    assert edited["text"] == "edited" and edited["max_follow_ups"] == 2

    assert (
        await client.delete(f"/admin/question-banks/questions/{qid}", headers=AUTH)
    ).status_code == 204
    listing = (await client.get(f"/admin/question-banks/{bank_id}/questions", headers=AUTH)).json()
    assert listing == []


async def test_add_question_auto_creates_checklist(client):
    # Design B: creating a question auto-drafts a non-empty checklist (mock LLM in CI). The
    # response and the listing both report a non-zero checklist_item_count.
    bank = (await client.post("/admin/question-banks", headers=AUTH, json={"name": "B"})).json()
    bank_id = bank["bank_id"]
    created = (
        await client.post(
            f"/admin/question-banks/{bank_id}/questions",
            headers=AUTH,
            json={"text": "Describe the safety procedure."},
        )
    ).json()
    assert created["checklist_item_count"] > 0

    listing = (await client.get(f"/admin/question-banks/{bank_id}/questions", headers=AUTH)).json()
    assert listing[0]["checklist_item_count"] == created["checklist_item_count"]

    # The auto-created checklist is fetchable and non-empty.
    got = await client.get(f"/admin/checklists/questions/{created['question_id']}", headers=AUTH)
    assert got.status_code == 200
    assert len(got.json()["items"]) > 0


async def test_reorder_questions(client):
    bank = (await client.post("/admin/question-banks", headers=AUTH, json={"name": "B"})).json()
    bank_id = bank["bank_id"]
    ids = []
    for t in ("a", "b", "c"):
        r = await client.post(
            f"/admin/question-banks/{bank_id}/questions", headers=AUTH, json={"text": t}
        )
        ids.append(r.json()["question_id"])

    # Reverse the order.
    resp = await client.post(
        f"/admin/question-banks/{bank_id}/reorder",
        headers=AUTH,
        json={"ordered_ids": list(reversed(ids))},
    )
    assert resp.status_code == 204
    listing = (await client.get(f"/admin/question-banks/{bank_id}/questions", headers=AUTH)).json()
    assert [q["text"] for q in listing] == ["c", "b", "a"]


async def test_set_default_switches(client):
    # Bank A starts as the default; switching to B must demote A (one-enabled-default invariant).
    await client.post("/admin/question-banks", headers=AUTH, json={"name": "A", "is_default": True})
    b = (await client.post("/admin/question-banks", headers=AUTH, json={"name": "B"})).json()
    resp = await client.post(f"/admin/question-banks/{b['bank_id']}/default", headers=AUTH)
    assert resp.status_code == 200 and resp.json()["is_default"] is True
    banks = (await client.get("/admin/question-banks", headers=AUTH)).json()
    defaults = [x for x in banks if x["is_default"] and x["enabled"]]
    assert len(defaults) == 1 and defaults[0]["bank_id"] == b["bank_id"]


async def test_add_question_unknown_bank_404(client):
    resp = await client.post(
        "/admin/question-banks/nope/questions", headers=AUTH, json={"text": "x"}
    )
    assert resp.status_code == 404


async def test_edit_unknown_question_404(client):
    resp = await client.patch(
        "/admin/question-banks/questions/nope", headers=AUTH, json={"text": "x"}
    )
    assert resp.status_code == 404
