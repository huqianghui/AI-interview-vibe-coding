"""Rubric versions (docs/planning/spec-rubric-versioning.md) and the editor's lost SOP links."""

import uuid

import pytest
from sqlalchemy import select

from app.interview import state_machine
from app.interview.checklist_draft import ChecklistDraft, DraftItem
from app.models.interview import InterviewSession
from app.models.sop import SopDocument
from app.models.user import User
from app.services import (
    checklist_service,
    question_service,
    rubric_version_service,
    scoring_service,
)
from app.services.auth_service import create_access_token, get_password_hash

pytestmark = pytest.mark.asyncio

_HASH = get_password_hash("pw")


async def _bank_with_rubric(db, *, name="Bank", is_default=True):
    """A bank with one question whose rubric cites an SOP and has an advisory forbidden item."""
    doc = SopDocument(name="Monitoring Plan.pdf", blob_path="", status="chunked")
    db.add(doc)
    bank = await question_service.create_bank(db, name=name, is_default=is_default)
    q = await question_service.add_question(
        db, bank_id=bank.id, text="How do you escalate an issue?", order_index=0
    )
    await db.commit()
    draft = ChecklistDraft(
        prompt_version="t1",
        items=[
            DraftItem(
                kind="required",
                text="Escalates within 24 hours",
                weight=100,
                source_quote="escalate within 24 hours",
                source_document_id=doc.id,
                source_page="4.2",
                order_index=0,
            ),
            DraftItem(
                kind="forbidden",
                text="Known source conflict",
                weight=0,
                advisory=True,
                order_index=1,
            ),
        ],
    )
    checklist = await checklist_service._persist_draft(db, q.id, draft)
    return bank, q, checklist, doc


async def _items(db, checklist_id):
    return list(await checklist_service.list_items(db, checklist_id))


# --- versions ------------------------------------------------------------------------------


async def test_saving_mints_a_version_only_when_the_rubric_changed(db_session):
    bank, _q, checklist, doc = await _bank_with_rubric(db_session)
    first = await rubric_version_service.latest(db_session, bank.id)
    assert first is not None and first.version_no == 1 and first.reason == "draft"

    same = [
        {
            "kind": "required",
            "text": "Escalates within 24 hours",
            "weight": 100,
            "source_quote": "escalate within 24 hours",
            "source_page": "4.2",
            "source_document_id": doc.id,
        },
        {"kind": "forbidden", "text": "Known source conflict", "advisory": True},
    ]
    await checklist_service.update_items(db_session, checklist.id, same)
    assert (await rubric_version_service.latest(db_session, bank.id)).version_no == 1

    same[0]["weight"] = 60
    same.append({"kind": "recommended", "text": "Documents it", "weight": 40})
    await checklist_service.update_items(db_session, checklist.id, same, created_by="admin-1")
    latest = await rubric_version_service.latest(db_session, bank.id)
    assert (latest.version_no, latest.reason, latest.created_by) == (2, "edit", "admin-1")
    assert [
        v.version_no for v in await rubric_version_service.list_versions(db_session, bank.id)
    ] == [2, 1]


async def test_an_editor_save_keeps_sop_links_and_advisory_flags(db_session):
    _bank, _q, checklist, doc = await _bank_with_rubric(db_session)
    # A tab running the old bundle sends neither field: both must survive, not be cleared.
    stale_tab = [
        {
            "kind": "required",
            "text": "Escalates within 24 hours",
            "weight": 100,
            "source_quote": "escalate within 24 hours",
            "source_page": "4.2",
        },
        {"kind": "forbidden", "text": "Known source conflict", "weight": 0, "source_quote": ""},
    ]
    await checklist_service.update_items(db_session, checklist.id, stale_tab)
    required, forbidden = await _items(db_session, checklist.id)
    assert required.source_document_id == doc.id
    assert forbidden.advisory is True


async def test_an_unknown_document_id_is_cleared_and_an_explicit_null_unlinks(db_session):
    _bank, _q, checklist, _doc = await _bank_with_rubric(db_session)
    await checklist_service.update_items(
        db_session,
        checklist.id,
        [
            {
                "kind": "required",
                "text": "Escalates within 24 hours",
                "weight": 50,
                "source_quote": "escalate within 24 hours",
                "source_document_id": "no-such-doc",
            },
            {"kind": "required", "text": "Other", "weight": 50, "source_document_id": None},
        ],
    )
    assert [i.source_document_id for i in await _items(db_session, checklist.id)] == [None, None]


async def test_the_editor_api_round_trips_links_and_reports_the_version(
    client, db_session, admin_auth
):
    _bank, q, checklist, doc = await _bank_with_rubric(db_session)
    body = (await client.get(f"/admin/checklists/questions/{q.id}", headers=admin_auth)).json()
    first = body["items"][0]
    assert (first["source_document_id"], first["source_document_name"]) == (doc.id, doc.name)
    assert body["items"][1]["advisory"] is True
    assert body["rubric_version_no"] == 1

    edited = [
        {
            k: it[k]
            for k in (
                "kind",
                "text",
                "weight",
                "source_quote",
                "source_page",
                "source_document_id",
                "advisory",
            )
        }
        for it in body["items"]
    ]
    # A real change (a lone required item's weight renormalizes back to 100, which is no change).
    edited[0]["text"] = "Escalates within one working day"
    resp = await client.put(
        f"/admin/checklists/{checklist.id}/items", headers=admin_auth, json={"items": edited}
    )
    assert resp.status_code == 200, resp.text
    saved = resp.json()
    assert saved["rubric_version_no"] == 2
    assert saved["items"][0]["source_document_id"] == doc.id
    assert saved["items"][1]["advisory"] is True


async def test_versions_endpoint_lists_newest_first(client, db_session, admin_auth):
    bank = await question_service.create_bank(db_session, name="Empty", is_default=False)
    await db_session.commit()
    # A bank with no version yet gets its first one, so the assignment picker is never empty.
    resp = await client.get(f"/admin/question-banks/{bank.id}/rubric-versions", headers=admin_auth)
    assert resp.status_code == 200
    (only,) = resp.json()
    assert (only["version_no"], only["is_latest"], only["question_count"]) == (1, True, 0)
    missing = await client.get("/admin/question-banks/nope/rubric-versions", headers=admin_auth)
    assert missing.status_code == 404


# --- assignment + pinning --------------------------------------------------------------------


async def _user(db) -> User:
    name = f"cand-{uuid.uuid4().hex[:10]}"
    user = User(username=name, email=f"{name}@local", hashed_password=_HASH, role="user")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


async def _session_row(db, interview_id: str) -> InterviewSession:
    return (
        await db.execute(
            select(InterviewSession)
            .where(InterviewSession.id == interview_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()


async def _start_as(client, user) -> str:
    bearer = {"Authorization": f"Bearer {create_access_token(data={'sub': user.id})}"}
    token = (await client.post("/public/candidate/session", headers=bearer)).json()["token"]
    resp = await client.post("/candidate/interview/start", headers={"X-Anon-Session": token})
    assert resp.status_code == 200, resp.text
    return resp.json()["interview_session_id"]


async def test_assignment_defaults_to_the_latest_version_and_rejects_another_banks(
    client, db_session, admin_auth
):
    bank, _q, _checklist, _doc = await _bank_with_rubric(db_session)
    other, *_ = await _bank_with_rubric(db_session, name="Other", is_default=False)
    user = await _user(db_session)
    url = f"/admin/users/{user.id}/assignment"

    resp = await client.patch(url, headers=admin_auth, json={"bank_id": bank.id})
    assert resp.status_code == 200, resp.text
    v1 = await rubric_version_service.latest(db_session, bank.id)
    assert resp.json()["assigned_rubric_version_id"] == v1.id
    assert resp.json()["assigned_rubric_version_no"] == 1

    other_v = await rubric_version_service.latest(db_session, other.id)
    bad = await client.patch(
        url, headers=admin_auth, json={"bank_id": bank.id, "rubric_version_id": other_v.id}
    )
    assert bad.status_code == 422

    cleared = await client.patch(url, headers=admin_auth, json={"bank_id": None})
    assert cleared.json()["assigned_rubric_version_id"] is None


async def test_an_interview_is_scored_against_the_version_it_started_with(
    client, db_session, admin_auth
):
    bank, q, checklist, doc = await _bank_with_rubric(db_session)
    user = await _user(db_session)
    await client.patch(
        f"/admin/users/{user.id}/assignment", headers=admin_auth, json={"bank_id": bank.id}
    )
    interview_id = await _start_as(client, user)
    session = await _session_row(db_session, interview_id)
    v1 = await rubric_version_service.latest(db_session, bank.id)
    assert session.rubric_version_id == v1.id

    # The rubric is rewritten after the interview started: a new version, no SOP link at all.
    await checklist_service.update_items(
        db_session,
        checklist.id,
        [{"kind": "required", "text": "Something else", "weight": 100, "source_document_id": None}],
    )
    assert (await rubric_version_service.latest(db_session, bank.id)).version_no == 2

    task = await scoring_service.prepare_scoring(
        db_session,
        question_id=q.id,
        question_text=q.text,
        answer_text="x",
        include_source_context=False,
        rubric_version_id=session.rubric_version_id,
    )
    assert [r.text for r in task.rubric] == ["Escalates within 24 hours", "Known source conflict"]
    assert task.rubric[1].advisory is True

    # The report's SOP link guard reads the same pinned version.
    await client.post(
        f"/candidate/interview/{interview_id}/answer",
        headers={
            "X-Anon-Session": (
                await client.post(
                    "/public/candidate/session",
                    headers={
                        "Authorization": f"Bearer {create_access_token(data={'sub': user.id})}"
                    },
                )
            ).json()["token"]
        },
        json={"text": "We escalate within a day.", "source": "text"},
    )
    session = await _session_row(db_session, interview_id)
    assert await state_machine.cited_document_ids(db_session, session) == {doc.id}


async def test_an_assigned_version_of_another_bank_falls_back_to_the_latest(db_session):
    bank, *_ = await _bank_with_rubric(db_session)
    other, *_ = await _bank_with_rubric(db_session, name="Other", is_default=False)
    other_v = await rubric_version_service.latest(db_session, other.id)
    pinned = await rubric_version_service.resolve_for_start(db_session, bank.id, other_v.id)
    assert pinned == (await rubric_version_service.latest(db_session, bank.id)).id
    assert await rubric_version_service.resolve_for_start(db_session, None, other_v.id) is None


async def test_an_interview_without_a_version_reads_the_live_rubric(db_session):
    _bank, q, _checklist, _doc = await _bank_with_rubric(db_session)
    rows = await rubric_version_service.rubric_rows(
        db_session, question_id=q.id, rubric_version_id=None
    )
    assert [r.text for r in rows] == ["Escalates within 24 hours", "Known source conflict"]


# --- review follow-ups (ship pre-landing review) ---------------------------------------------


async def test_an_old_tab_saving_the_interviewer_does_not_repin_the_rubric_version(
    client, db_session, admin_auth
):
    bank, _q, checklist, _doc = await _bank_with_rubric(db_session)
    v1 = await rubric_version_service.latest(db_session, bank.id)
    await checklist_service.update_items(
        db_session, checklist.id, [{"kind": "required", "text": "Changed", "weight": 100}]
    )
    user = await _user(db_session)
    url = f"/admin/users/{user.id}/assignment"
    await client.patch(
        url, headers=admin_auth, json={"bank_id": bank.id, "rubric_version_id": v1.id}
    )

    # A tab running the previous page never sends rubric_version_id at all.
    resp = await client.patch(
        url, headers=admin_auth, json={"persona_id": None, "bank_id": bank.id}
    )
    assert resp.json()["assigned_rubric_version_id"] == v1.id
    # A version with no bank is meaningless.
    bad = await client.patch(
        url, headers=admin_auth, json={"bank_id": None, "rubric_version_id": v1.id}
    )
    assert bad.status_code == 422
    unknown = await client.patch(
        url, headers=admin_auth, json={"bank_id": bank.id, "rubric_version_id": "nope"}
    )
    assert unknown.status_code == 422
    listed = {u["id"]: u for u in (await client.get("/admin/users", headers=admin_auth)).json()}
    assert listed[user.id]["assigned_rubric_version_no"] == 1


async def test_start_pins_the_rubric_as_it_is_now_even_if_a_snapshot_was_missed(db_session):
    """A rubric write commits before its snapshot; a missed one must not pin a stale version."""
    bank, q, checklist, _doc = await _bank_with_rubric(db_session)
    # Write the rubric behind the service's back, as a failed snapshot would leave it.
    (await _items(db_session, checklist.id))[0].text = "Edited without a snapshot"
    await db_session.commit()
    pinned = await rubric_version_service.resolve_for_start(db_session, bank.id, None)
    version = await rubric_version_service.get(db_session, pinned)
    assert (version.version_no, version.reason) == (2, "sync")
    rows = await rubric_version_service.rubric_rows(
        db_session, question_id=q.id, rubric_version_id=pinned
    )
    assert rows[0].text == "Edited without a snapshot"


async def test_a_bank_import_mints_one_version_for_the_whole_bank(db_session):
    from app.services import bank_bundle_service

    bank, *_ = await _bank_with_rubric(db_session, name="Imported")
    bundle = await bank_bundle_service.export_bank_bundle(db_session, bank.id)
    before = len(await rubric_version_service.list_versions(db_session, bank.id))
    result = await bank_bundle_service.import_bank_bundle(db_session, bundle)
    versions = await rubric_version_service.list_versions(db_session, result.bank_id)
    # Re-import replaces the questions (new ids), so the content differs: exactly one new version.
    assert len(versions) == before + 1
    assert versions[0].reason == "import"


async def test_the_judge_and_the_coverage_audit_read_the_pinned_version(
    client, db_session, scripted_judge, monkeypatch
):
    from app.interview import judge as judge_mod
    from app.interview import judge_flow
    from app.services import sop_coverage
    from tests.test_interview_api import _judged_setup

    _headers, iv, qid = await _judged_setup(client, db_session)
    session = await _session_row(db_session, iv)
    assert session.rubric_version_id is not None
    checklist = await checklist_service.get_default_checklist(db_session, qid)
    await checklist_service.update_items(
        db_session,
        checklist.id,
        [{"kind": "required", "text": "Edited after start", "weight": 100}],
    )

    seen: list = []

    async def capture(inp, _adapter):
        seen.append([i.text for i in inp.checklist])
        return await real_run(inp, _adapter)

    real_run = judge_mod.run_judge
    monkeypatch.setattr(judge_mod, "run_judge", capture)
    session = await _session_row(db_session, iv)
    await judge_flow.judge(
        db_session,
        session,
        question_id=qid,
        follow_ups_asked=0,
        draft_text="I log them and",
        trigger="voice_silence",
        dry_run=True,
    )
    assert seen == [["Documented every protocol deviation in the log"]]

    # The coverage audit needs a cited SOP passage; with none it reads the pinned rows and stops.
    assert (
        await sop_coverage.prepare_coverage(
            db_session,
            question_id=qid,
            question_text="q",
            rubric_version_id=session.rubric_version_id,
        )
        is None
    )


async def test_snapshot_rejects_an_unknown_reason_and_rows_fall_back_without_a_version(db_session):
    bank, q, _checklist, _doc = await _bank_with_rubric(db_session)
    with pytest.raises(ValueError):
        await rubric_version_service.snapshot(db_session, bank.id, reason="bogus")
    rows = await rubric_version_service.rubric_rows(
        db_session, question_id=q.id, rubric_version_id="no-such-version"
    )
    assert [r.text for r in rows] == ["Escalates within 24 hours", "Known source conflict"]
    assert (
        await rubric_version_service.rubric_rows(
            db_session, question_id="no-question", rubric_version_id=None
        )
        == []
    )


async def test_admin_detail_shows_the_version_and_the_candidate_view_hides_it(
    client, db_session, admin_auth
):
    from app.services import interview_history_service

    bank, *_ = await _bank_with_rubric(db_session)
    user = await _user(db_session)
    await client.patch(
        f"/admin/users/{user.id}/assignment", headers=admin_auth, json={"bank_id": bank.id}
    )
    iv = await _start_as(client, user)
    admin_view = (await client.get(f"/admin/interviews/{iv}", headers=admin_auth)).json()
    assert admin_view["rubric_version_no"] == 1
    page = (await client.get("/admin/interviews", headers=admin_auth)).json()
    assert {i["id"]: i for i in page["items"]}[iv]["rubric_version_no"] == 1
    session = await _session_row(db_session, iv)
    from app.models.anonymous_session import AnonymousCandidateSession

    candidate = await db_session.get(AnonymousCandidateSession, session.candidate_session_id)
    mine = await interview_history_service.get_detail(db_session, iv, candidate=candidate)
    assert mine is not None and mine.rubric_version_no is None


async def test_the_rubric_editor_is_admin_only(client, db_session, candidate_auth):
    _bank, _q, checklist, _doc = await _bank_with_rubric(db_session)
    resp = await client.put(
        f"/admin/checklists/{checklist.id}/items", headers=candidate_auth, json={"items": []}
    )
    assert resp.status_code == 403
