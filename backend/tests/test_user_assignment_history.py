"""Per-user interviewer + bank assignment, and the interview history (#187)."""

import uuid

import pytest
from sqlalchemy import select

from app.models.interview import InterviewSession
from app.models.user import User
from app.services import persona_service, question_service
from app.services.auth_service import create_access_token, get_password_hash
from tests.candidate_helpers import mint_candidate_headers

pytestmark = pytest.mark.asyncio

_HASH = get_password_hash("pw")
ANSWER = {"text": "I always follow the documented steps and confirm safety.", "source": "text"}


async def _user(db) -> User:
    name = f"cand-{uuid.uuid4().hex[:10]}"
    user = User(username=name, email=f"{name}@local", hashed_password=_HASH, role="user")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


async def _login(client, user: User) -> dict:
    """A fresh candidate session for this user → its ``X-Anon-Session`` header."""
    bearer = {"Authorization": f"Bearer {create_access_token(data={'sub': user.id})}"}
    resp = await client.post("/public/candidate/session", headers=bearer)
    assert resp.status_code == 200, resp.text
    return {"X-Anon-Session": resp.json()["token"]}


async def _bank(db, name: str, prompts: list[str], *, is_default: bool = False, enabled=True):
    bank = await question_service.create_bank(db, name=name, is_default=is_default, enabled=enabled)
    for i, text in enumerate(prompts):
        await question_service.add_question(db, bank_id=bank.id, text=text, order_index=i)
    await db.commit()
    return bank


async def _session_row(db, interview_id: str) -> InterviewSession:
    # populate_existing re-reads the row the API wrote without expiring the test's other objects.
    return (
        await db.execute(
            select(InterviewSession)
            .where(InterviewSession.id == interview_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()


async def _start(client, headers) -> dict:
    resp = await client.post("/candidate/interview/start", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _finish(client, headers, interview_id: str) -> None:
    body = {"status": "in_progress"}
    for _ in range(20):
        if body["status"] == "completed":
            return
        body = (
            await client.post(
                f"/candidate/interview/{interview_id}/answer", headers=headers, json=ANSWER
            )
        ).json()
    raise AssertionError("interview never completed")


async def _assign(client, admin_auth, user_id: str, **body):
    return await client.patch(f"/admin/users/{user_id}/assignment", headers=admin_auth, json=body)


# --- assignment at start (AC1-AC4) -----------------------------------------------------------


async def test_assigned_persona_and_bank_are_pinned_on_the_interview(
    client, db_session, admin_auth
):
    default_persona = await persona_service.create_persona(
        db_session, name="Default", is_default=True
    )
    persona_x = await persona_service.create_persona(db_session, name="X")
    await _bank(db_session, "Default bank", ["Default first?"], is_default=True)
    bank_y = await _bank(db_session, "Y", ["Y first?", "Y second?"])
    user = await _user(db_session)

    resp = await _assign(client, admin_auth, user.id, persona_id=persona_x.id, bank_id=bank_y.id)
    assert resp.status_code == 200, resp.text
    assert resp.json()["assigned_persona_id"] == persona_x.id
    assert resp.json()["assigned_bank_id"] == bank_y.id

    start = await _start(client, await _login(client, user))
    assert start["current_question"]["prompt"] == "Y first?"
    row = await _session_row(db_session, start["interview_session_id"])
    assert (row.persona_id, row.bank_id) == (persona_x.id, bank_y.id)
    assert row.persona_id != default_persona.id


async def test_unassigned_and_anonymous_candidates_get_the_default(client, db_session):
    persona = await persona_service.create_persona(db_session, name="Default", is_default=True)
    bank = await _bank(db_session, "Default bank", ["Default first?"], is_default=True)

    start = await _start(client, await _login(client, await _user(db_session)))
    assert start["current_question"]["prompt"] == "Default first?"
    row = await _session_row(db_session, start["interview_session_id"])
    assert (row.persona_id, row.bank_id) == (persona.id, bank.id)


async def test_a_disabled_assignment_falls_back_to_the_default_field_by_field(
    client, db_session, admin_auth
):
    default_persona = await persona_service.create_persona(
        db_session, name="Default", is_default=True
    )
    persona_x = await persona_service.create_persona(db_session, name="X")
    await _bank(db_session, "Default bank", ["Default first?"], is_default=True)
    bank_y = await _bank(db_session, "Y", ["Y first?"])
    user = await _user(db_session)
    await _assign(client, admin_auth, user.id, persona_id=persona_x.id, bank_id=bank_y.id)

    bank_y.enabled = False  # disabled after it was assigned
    await db_session.commit()

    start = await _start(client, await _login(client, user))
    assert start["current_question"]["prompt"] == "Default first?"
    row = await _session_row(db_session, start["interview_session_id"])
    assert row.persona_id == persona_x.id  # the persona is still valid, so it is kept
    assert row.persona_id != default_persona.id


async def test_reassigning_mid_interview_keeps_the_live_interview(client, db_session, admin_auth):
    await persona_service.create_persona(db_session, name="Default", is_default=True)
    bank_a = await _bank(db_session, "A", ["A first?", "A second?"], is_default=True)
    bank_b = await _bank(db_session, "B", ["B first?", "B second?"])
    user = await _user(db_session)
    await _assign(client, admin_auth, user.id, bank_id=bank_a.id)
    headers = await _login(client, user)
    interview_id = (await _start(client, headers))["interview_session_id"]

    await _assign(client, admin_auth, user.id, bank_id=bank_b.id)

    after = (
        await client.post(
            f"/candidate/interview/{interview_id}/answer", headers=headers, json=ANSWER
        )
    ).json()
    assert after["current_question"]["prompt"] == "A second?"


# --- assignment API (AC6) --------------------------------------------------------------------


async def test_assignment_api_guards(client, db_session, admin_auth):
    user = await _user(db_session)
    disabled = await _bank(db_session, "Off", ["?"], enabled=False)

    candidate_bearer = {"Authorization": f"Bearer {create_access_token(data={'sub': user.id})}"}
    assert (await _assign(client, candidate_bearer, user.id)).status_code == 403
    assert (await _assign(client, admin_auth, "no-such-user")).status_code == 404
    assert (await _assign(client, admin_auth, user.id, persona_id="nope")).status_code == 422
    assert (await _assign(client, admin_auth, user.id, bank_id=disabled.id)).status_code == 422

    cleared = await _assign(client, admin_auth, user.id, persona_id=None, bank_id=None)
    assert cleared.status_code == 200
    assert cleared.json()["assigned_persona_id"] is None


# --- history (AC7-AC11) ----------------------------------------------------------------------


async def test_history_lists_every_status_across_candidate_sessions(client, db_session):
    persona = await persona_service.create_persona(db_session, name="Interviewer", is_default=True)
    persona_name = persona.name
    await _bank(db_session, "Bank", ["Only question?"], is_default=True)
    user = await _user(db_session)
    user_id = user.id

    first = await _login(client, user)
    abandoned_id = (await _start(client, first))["interview_session_id"]
    restarted = await client.post(f"/candidate/interview/{abandoned_id}/restart", headers=first)
    live_id = restarted.json()["interview_session_id"]

    # A later login with a NEW candidate session must still see the older interviews.
    from app.models.anonymous_session import AnonymousCandidateSession

    for row in (
        await db_session.execute(
            select(AnonymousCandidateSession).where(AnonymousCandidateSession.user_id == user_id)
        )
    ).scalars():
        row.is_revoked = True
        row.active_user_id = None
    await db_session.commit()
    second = await _login(client, user)

    items = (await client.get("/candidate/interviews", headers=second)).json()
    by_id = {i["id"]: i for i in items}
    assert by_id[abandoned_id]["status"] == "abandoned"
    assert by_id[live_id]["status"] == "in_progress"
    assert by_id[live_id]["persona_name"] == persona_name
    assert by_id[live_id]["bank_name"] == "Bank"
    assert items[0]["id"] == live_id  # newest first


async def test_a_candidate_cannot_read_another_candidates_interview(client, db_session):
    await _bank(db_session, "Bank", ["Only question?"], is_default=True)
    owner = await mint_candidate_headers(client)
    other = await mint_candidate_headers(client)
    interview_id = (await _start(client, owner))["interview_session_id"]

    assert (
        await client.get(f"/candidate/interviews/{interview_id}", headers=owner)
    ).status_code == 200
    assert (
        await client.get(f"/candidate/interviews/{interview_id}", headers=other)
    ).status_code == 404
    assert (await client.get("/candidate/interviews", headers=other)).json() == []


async def test_scoring_saves_the_report_for_the_history(client, db_session, admin_auth):
    await _bank(db_session, "Bank", ["Only question?"], is_default=True)
    user = await _user(db_session)
    headers = await _login(client, user)
    interview_id = (await _start(client, headers))["interview_session_id"]
    await _finish(client, headers, interview_id)
    report = (
        await client.post(f"/candidate/interview/{interview_id}/report", headers=headers)
    ).json()

    mine = (await client.get(f"/candidate/interviews/{interview_id}", headers=headers)).json()
    assert mine["item"]["status"] == "scored"
    assert mine["item"]["has_report"] is True
    assert mine["report"]["total_score"] == report["total_score"]
    assert [t["role"] for t in mine["transcript"]][:2] == ["interviewer", "candidate"]

    listed = (
        await client.get("/admin/interviews", headers=admin_auth, params={"user_id": user.id})
    ).json()
    assert [i["id"] for i in listed["items"]] == [interview_id]
    assert listed["items"][0]["username"] == user.username
    admin_view = (await client.get(f"/admin/interviews/{interview_id}", headers=admin_auth)).json()
    assert admin_view["report"] == mine["report"]


async def test_admin_sees_an_in_progress_interview_and_can_generate_a_missing_report(
    client, db_session, admin_auth
):
    await _bank(db_session, "Bank", ["Only question?"], is_default=True)
    user = await _user(db_session)
    headers = await _login(client, user)
    interview_id = (await _start(client, headers))["interview_session_id"]

    live = (await client.get(f"/admin/interviews/{interview_id}", headers=admin_auth)).json()
    assert live["item"]["status"] == "in_progress"
    assert live["report"] is None
    assert live["transcript"][0]["content"] == "Only question?"
    # Not finished yet: nothing to score.
    early = await client.post(f"/admin/interviews/{interview_id}/report", headers=admin_auth)
    assert early.status_code == 409

    await _finish(client, headers, interview_id)  # completed, but the candidate never submitted
    started = await client.post(f"/admin/interviews/{interview_id}/report", headers=admin_auth)
    assert started.status_code == 202, started.text
    detail = await _until_scored(client, admin_auth, interview_id)
    assert detail["report"] is not None
    assert detail["item"]["has_report"] is True


async def _until_scored(client, admin_auth, interview_id: str) -> dict:
    """Poll the admin detail the way the page does until the background scoring has saved."""
    import asyncio

    for _ in range(200):
        detail = (await client.get(f"/admin/interviews/{interview_id}", headers=admin_auth)).json()
        if detail["item"]["status"] == "scored":
            return detail
        await asyncio.sleep(0.05)
    raise AssertionError("background scoring never finished")


async def test_a_second_generate_while_scoring_is_a_409(client, db_session, admin_auth):
    from app.api import admin_interviews

    await _bank(db_session, "Bank", ["Only question?"], is_default=True)
    headers = await mint_candidate_headers(client)
    interview_id = (await _start(client, headers))["interview_session_id"]
    await _finish(client, headers, interview_id)

    admin_interviews._SCORING.add(interview_id)  # a run already in flight
    try:
        again = await client.post(f"/admin/interviews/{interview_id}/report", headers=admin_auth)
        assert again.status_code == 409
        detail = (await client.get(f"/admin/interviews/{interview_id}", headers=admin_auth)).json()
        assert detail["scoring"] is True  # the page keeps polling while this is true
    finally:
        admin_interviews._SCORING.discard(interview_id)


async def test_a_rescore_that_grades_nothing_keeps_the_saved_report(
    client, db_session, monkeypatch
):
    from app.interview import state_machine

    await _bank(db_session, "Bank", ["Only question?"], is_default=True)
    headers = await mint_candidate_headers(client)
    interview_id = (await _start(client, headers))["interview_session_id"]
    await _finish(client, headers, interview_id)
    row = await _session_row(db_session, interview_id)
    row.report_json = '{"total_score": 80, "kept": true}'
    row.total_score = 80.0
    row.status = "scored"
    await db_session.commit()

    # Every question fails to grade: the run produces a stub with nothing graded.
    async def _no_checklist(*_a, **_k):
        return None

    monkeypatch.setattr(state_machine.scoring_service, "prepare_scoring", _no_checklist)
    await state_machine.score_and_finalize(db_session, row)

    row = await _session_row(db_session, interview_id)
    assert row.total_score == 80.0
    assert '"kept": true' in row.report_json


async def test_admin_history_routes_are_admin_only(client, db_session):
    user = await _user(db_session)
    bearer = {"Authorization": f"Bearer {create_access_token(data={'sub': user.id})}"}
    assert (await client.get("/admin/interviews", headers=bearer)).status_code == 403
    assert (await client.get("/admin/interviews/x", headers=bearer)).status_code == 403
    assert (await client.post("/admin/interviews/x/report", headers=bearer)).status_code == 403


async def test_admin_history_404s(client, admin_auth):
    assert (await client.get("/admin/interviews/nope", headers=admin_auth)).status_code == 404
    assert (
        await client.post("/admin/interviews/nope/report", headers=admin_auth)
    ).status_code == 404


async def test_history_sop_routes_only_serve_documents_the_report_cited(
    client, db_session, admin_auth
):
    await _bank(db_session, "Bank", ["Only question?"], is_default=True)
    owner = await mint_candidate_headers(client)
    other = await mint_candidate_headers(client)
    interview_id = (await _start(client, owner))["interview_session_id"]

    mine = f"/candidate/interviews/{interview_id}/sop/uncited"
    assert (await client.get(mine, headers=owner)).status_code == 404  # owned, but not cited
    assert (await client.get(mine, headers=other)).status_code == 404  # not owned
    admin_path = f"/admin/interviews/{interview_id}/sop/uncited"
    assert (await client.get(admin_path, headers=admin_auth)).status_code == 404
    gone = "/admin/interviews/nope/sop/x"
    assert (await client.get(gone, headers=admin_auth)).status_code == 404
    assert (await client.get("/candidate/interviews/nope/sop/x", headers=owner)).status_code == 404
