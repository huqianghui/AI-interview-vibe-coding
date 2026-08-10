"""Admin checklist API (SPEC F3): auth guard, draft, read, and the AC invariants over HTTP."""

import json

import pytest

AUTH: dict = {}


@pytest.fixture(autouse=True)
def _admin_token(admin_auth):
    AUTH.clear()
    AUTH.update(admin_auth)
    yield


async def _seed_question(db_session, points=None):
    from app.services import question_service

    bank = await question_service.create_bank(db_session, name="B", is_default=True)
    q = await question_service.add_question(
        db_session,
        bank_id=bank.id,
        text="Describe the safety procedure.",
        order_index=0,
        expected_points=json.dumps(points or []),
    )
    return q.id


async def test_checklist_routes_require_a_token(client):
    assert (await client.post("/admin/checklists/questions/x/draft")).status_code == 401
    assert (await client.get("/admin/checklists/questions/x")).status_code == 401


async def test_draft_unknown_question_404(client):
    resp = await client.post("/admin/checklists/questions/nope/draft", headers=AUTH)
    assert resp.status_code == 404


async def test_draft_then_get_checklist(client, db_session):
    question_id = await _seed_question(db_session)

    draft = await client.post(f"/admin/checklists/questions/{question_id}/draft", headers=AUTH)
    assert draft.status_code == 201
    body = draft.json()
    # AC #3: weights sum to 100.
    assert body["weights_sum"] == 100
    assert body["question_id"] == question_id
    # AC #2: every item carries kind + weight; at least one is source-attributed.
    assert body["items"]
    for item in body["items"]:
        assert item["kind"] in ("required", "recommended", "forbidden")
        assert "weight" in item
    assert any(i["source_quote"] for i in body["items"])

    # Read it back.
    got = await client.get(f"/admin/checklists/questions/{question_id}", headers=AUTH)
    assert got.status_code == 200
    assert got.json()["checklist_id"] == body["checklist_id"]


async def test_get_before_draft_404(client, db_session):
    question_id = await _seed_question(db_session)
    resp = await client.get(f"/admin/checklists/questions/{question_id}", headers=AUTH)
    assert resp.status_code == 404


async def test_checklist_never_exposed_to_candidate(client, db_session):
    # SPEC P3: the candidate question list must never carry checklist/rubric content, even after a
    # checklist is drafted for the question.
    question_id = await _seed_question(db_session, points=["mentions PPE"])
    await client.post(f"/admin/checklists/questions/{question_id}/draft", headers=AUTH)

    sess = await client.post("/public/candidate/session")
    cand_headers = {"X-Anon-Session": sess.json()["token"]}
    listing = await client.get("/candidate/interview/questions", headers=cand_headers)
    flat = str(listing.json()).lower()
    for leaked in ("checklist", "rubric", "weight", "source_quote", "forbidden", "expected_points"):
        assert leaked not in flat


# --- F3b editing (AC F3 #4) ------------------------------------------------


async def test_edit_checklist_items_renormalizes_and_round_trips(client, db_session):
    question_id = await _seed_question(db_session)
    draft = await client.post(f"/admin/checklists/questions/{question_id}/draft", headers=AUTH)
    checklist_id = draft.json()["checklist_id"]

    # Replace items with an edited set whose weights don't sum to 100; server re-normalizes.
    resp = await client.put(
        f"/admin/checklists/{checklist_id}/items",
        headers=AUTH,
        json={
            "items": [
                {
                    "kind": "required",
                    "text": "cites the SOP step",
                    "weight": 3,
                    "source_quote": "Follow the steps.",
                    "source_page": "p.1",
                },
                {"kind": "required", "text": "verifies the outcome", "weight": 1},
                {"kind": "forbidden", "text": "skips the check", "weight": 50},
            ]
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["weights_sum"] == 100  # re-normalized
    forbidden = [i for i in body["items"] if i["kind"] == "forbidden"]
    assert forbidden and forbidden[0]["weight"] == 0

    # Round-trip: GET returns the edited set.
    got = (await client.get(f"/admin/checklists/questions/{question_id}", headers=AUTH)).json()
    assert [i["text"] for i in got["items"]] == [
        "cites the SOP step",
        "verifies the outcome",
        "skips the check",
    ]


async def test_edit_items_requires_token(client):
    assert (await client.put("/admin/checklists/x/items", json={"items": []})).status_code == 401


async def test_edit_unknown_checklist_404(client):
    resp = await client.put("/admin/checklists/nope/items", headers=AUTH, json={"items": []})
    assert resp.status_code == 404
