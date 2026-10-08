"""Bank versions (docs/planning/spec-bank-versioning.md): questions + rubric published as one unit,
pinned per assignment and per interview; and the editor's lost SOP links."""

import uuid

import pytest
from sqlalchemy import select

from app.interview import state_machine
from app.interview.checklist_draft import ChecklistDraft, DraftItem
from app.interview.questions import resolve_questions
from app.models.interview import InterviewSession
from app.models.sop import SopDocument
from app.models.user import User
from app.services import bank_version_service, checklist_service, question_service, scoring_service
from app.services.auth_service import create_access_token, get_password_hash

pytestmark = pytest.mark.asyncio

_HASH = get_password_hash("pw")


async def _bank(db, *, name="Bank", is_default=True, publish=True):
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
            DraftItem(kind="forbidden", text="Known source conflict", advisory=True, order_index=1),
        ],
    )
    checklist = await checklist_service._persist_draft(db, q.id, draft)
    if publish:
        assert (await bank_version_service.publish(db, bank.id)).created
    return bank, q, checklist, doc


async def _items(db, checklist_id):
    return list(await checklist_service.list_items(db, checklist_id))


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


async def _headers(client, user) -> dict:
    bearer = {"Authorization": f"Bearer {create_access_token(data={'sub': user.id})}"}
    token = (await client.post("/public/candidate/session", headers=bearer)).json()["token"]
    return {"X-Anon-Session": token}


async def _start(client, headers) -> str:
    resp = await client.post("/candidate/interview/start", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()["interview_session_id"]


# --- publishing ------------------------------------------------------------------------------


async def test_publish_freezes_a_complete_draft_once(db_session):
    bank, q, checklist, _doc = await _bank(db_session)
    v1 = await bank_version_service.latest(db_session, bank.id)
    assert (v1.version_no, v1.reason, v1.bank_name) == (1, "publish", "Bank")
    assert [x["text"] for x in bank_version_service.questions_of(v1)] == [q.text]

    # An unchanged draft publishes nothing new.
    again = await bank_version_service.publish(db_session, bank.id)
    assert (again.created, again.version.id) == (False, v1.id)
    assert not await bank_version_service.has_unpublished_changes(db_session, bank.id)

    # Editing the draft changes nothing an interview reads until it is published.
    await question_service.update_question(db_session, q.id, text="How do you escalate?")
    assert await bank_version_service.has_unpublished_changes(db_session, bank.id)
    assert (await bank_version_service.latest(db_session, bank.id)).id == v1.id
    v2 = (await bank_version_service.publish(db_session, bank.id, created_by="a1")).version
    assert (v2.version_no, v2.created_by) == (2, "a1")


async def test_an_incomplete_draft_is_refused_with_every_reason(db_session):
    bank, _q, checklist, _doc = await _bank(db_session, publish=False)
    await question_service.add_question(
        db_session, bank_id=bank.id, text="No rubric?", order_index=1
    )
    await checklist_service.update_items(
        db_session, checklist.id, [{"kind": "forbidden", "text": "Only a forbidden item"}]
    )
    result = await bank_version_service.publish(db_session, bank.id)
    assert result.version is None
    assert [(p.code, p.question_no) for p in result.problems] == [("weights", 1), ("no_rubric", 2)]
    empty = await question_service.create_bank(db_session, name="Empty", is_default=False)
    await db_session.commit()
    (none,) = (await bank_version_service.publish(db_session, empty.id)).problems
    assert none.code == "no_questions"
    with pytest.raises(ValueError):
        await bank_version_service.publish(db_session, bank.id, reason="bogus")


async def test_publish_api_reports_problems_and_versions(client, db_session, admin_auth):
    bank, *_ = await _bank(db_session, publish=False)
    resp = await client.post(f"/admin/question-banks/{bank.id}/publish", headers=admin_auth)
    assert resp.json() == {"published": True, "created": True, "version_no": 1, "problems": []}
    banks = {
        b["bank_id"]: b
        for b in (await client.get("/admin/question-banks", headers=admin_auth)).json()
    }
    assert (banks[bank.id]["latest_version_no"], banks[bank.id]["has_unpublished_changes"]) == (
        1,
        False,
    )
    (v,) = (
        await client.get(f"/admin/question-banks/{bank.id}/versions", headers=admin_auth)
    ).json()
    assert (v["version_no"], v["is_latest"], v["question_count"]) == (1, True, 1)

    bad = await question_service.create_bank(db_session, name="Bad", is_default=False)
    await question_service.add_question(db_session, bank_id=bad.id, text="Q?", order_index=0)
    await db_session.commit()
    refused = (
        await client.post(f"/admin/question-banks/{bad.id}/publish", headers=admin_auth)
    ).json()
    assert refused["published"] is False
    assert refused["problems"][0] == {
        "code": "no_rubric",
        "question_no": 1,
        "question_text": "Q?",
        "weights_sum": None,
    }
    # Read-only: listing a never-published bank's versions creates none.
    assert (
        await client.get(f"/admin/question-banks/{bad.id}/versions", headers=admin_auth)
    ).json() == []
    assert (
        await client.post("/admin/question-banks/nope/publish", headers=admin_auth)
    ).status_code == 404


# --- the editor keeps SOP links and advisory flags --------------------------------------------


async def test_an_editor_save_keeps_sop_links_and_advisory_flags(db_session):
    _bank_, _q, checklist, doc = await _bank(db_session)
    # A tab running an older page sends neither field: both must survive, not be cleared.
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
    _bank_, _q, checklist, _doc = await _bank(db_session)
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


async def test_the_editor_api_round_trips_links(client, db_session, admin_auth):
    _bank_, q, checklist, doc = await _bank(db_session)
    body = (await client.get(f"/admin/checklists/questions/{q.id}", headers=admin_auth)).json()
    first = body["items"][0]
    assert (first["source_document_id"], first["source_document_name"]) == (doc.id, doc.name)
    assert body["items"][1]["advisory"] is True
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
    edited[0]["text"] = "Escalates within one working day"
    saved = (
        await client.put(
            f"/admin/checklists/{checklist.id}/items", headers=admin_auth, json={"items": edited}
        )
    ).json()
    assert saved["items"][0]["source_document_id"] == doc.id
    assert saved["items"][1]["advisory"] is True


async def test_the_rubric_editor_is_admin_only(client, db_session, candidate_auth):
    _bank_, _q, checklist, _doc = await _bank(db_session)
    resp = await client.put(
        f"/admin/checklists/{checklist.id}/items", headers=candidate_auth, json={"items": []}
    )
    assert resp.status_code == 403


# --- assignment -------------------------------------------------------------------------------


async def test_assignment_defaults_to_the_latest_published_version(client, db_session, admin_auth):
    bank, *_ = await _bank(db_session)
    other, *_ = await _bank(db_session, name="Other", is_default=False)
    user = await _user(db_session)
    url = f"/admin/users/{user.id}/assignment"
    v1 = await bank_version_service.latest(db_session, bank.id)

    resp = await client.patch(url, headers=admin_auth, json={"bank_id": bank.id})
    assert (resp.json()["assigned_bank_version_id"], resp.json()["assigned_bank_version_no"]) == (
        v1.id,
        1,
    )
    other_v = await bank_version_service.latest(db_session, other.id)
    bad = await client.patch(
        url, headers=admin_auth, json={"bank_id": bank.id, "bank_version_id": other_v.id}
    )
    assert bad.status_code == 422
    assert (
        await client.patch(
            url, headers=admin_auth, json={"bank_id": None, "bank_version_id": v1.id}
        )
    ).status_code == 422
    assert (
        await client.patch(
            url, headers=admin_auth, json={"bank_id": bank.id, "bank_version_id": "nope"}
        )
    ).status_code == 422
    cleared = await client.patch(url, headers=admin_auth, json={"bank_id": None})
    assert cleared.json()["assigned_bank_version_id"] is None

    # A bank never published has no version to assign: the interview will read its draft.
    draft_only, *_ = await _bank(db_session, name="Draft only", is_default=False, publish=False)
    resp = await client.patch(url, headers=admin_auth, json={"bank_id": draft_only.id})
    assert resp.json()["assigned_bank_version_id"] is None


async def test_an_old_tab_saving_the_interviewer_does_not_repin_the_version(
    client, db_session, admin_auth
):
    bank, q, _checklist, _doc = await _bank(db_session)
    v1 = await bank_version_service.latest(db_session, bank.id)
    await question_service.update_question(db_session, q.id, text="Changed")
    await bank_version_service.publish(db_session, bank.id)
    user = await _user(db_session)
    url = f"/admin/users/{user.id}/assignment"
    await client.patch(url, headers=admin_auth, json={"bank_id": bank.id, "bank_version_id": v1.id})
    # A tab running the previous page never sends bank_version_id at all.
    resp = await client.patch(
        url, headers=admin_auth, json={"persona_id": None, "bank_id": bank.id}
    )
    assert resp.json()["assigned_bank_version_id"] == v1.id
    listed = {u["id"]: u for u in (await client.get("/admin/users", headers=admin_auth)).json()}
    assert listed[user.id]["assigned_bank_version_no"] == 1


# --- an interview reads only its pinned version -----------------------------------------------


async def test_an_interview_asks_and_scores_from_the_version_it_started_on(
    client, db_session, admin_auth
):
    bank, q, checklist, doc = await _bank(db_session)
    user = await _user(db_session)
    await client.patch(
        f"/admin/users/{user.id}/assignment", headers=admin_auth, json={"bank_id": bank.id}
    )
    headers = await _headers(client, user)
    interview_id = await _start(client, headers)
    session = await _session_row(db_session, interview_id)
    v1 = await bank_version_service.latest(db_session, bank.id)
    assert session.bank_version_id == v1.id

    # After it started: the question is reworded, a second one added, the rubric replaced (no SOP
    # link), and all of it published as v2.
    await question_service.update_question(db_session, q.id, text="Reworded after start")
    q2 = await question_service.add_question(
        db_session, bank_id=bank.id, text="Added later?", order_index=1
    )
    await checklist_service.update_items(
        db_session, checklist.id, [{"kind": "required", "text": "Something else", "weight": 100}]
    )
    await checklist_service._persist_draft(
        db_session, q2.id, ChecklistDraft("t", [DraftItem(kind="required", text="x", weight=100)])
    )
    assert (await bank_version_service.publish(db_session, bank.id)).version.version_no == 2

    asked = await resolve_questions(db_session, session.bank_id, session.bank_version_id)
    assert [x.prompt for x in asked] == ["How do you escalate an issue?"]
    body = (await client.get(f"/candidate/interview/{interview_id}", headers=headers)).json()
    assert body["current_question"]["prompt"] == "How do you escalate an issue?"
    assert body["current_question"]["total"] == 1

    task = await scoring_service.prepare_scoring(
        db_session,
        question_id=q.id,
        question_text=q.text,
        answer_text="x",
        include_source_context=False,
        bank_version_id=session.bank_version_id,
    )
    assert [r.text for r in task.rubric] == ["Escalates within 24 hours", "Known source conflict"]
    assert task.rubric[1].advisory is True

    await client.post(
        f"/candidate/interview/{interview_id}/answer",
        headers=headers,
        json={"text": "We escalate within a day.", "source": "text"},
    )
    session = await _session_row(db_session, interview_id)
    assert await state_machine.cited_document_ids(db_session, session) == {doc.id}


async def test_a_reimport_keeps_assigned_users_on_their_complete_old_version(db_session):
    from app.services import bank_bundle_service

    bank, q, *_ = await _bank(db_session, name="Synced")
    v1 = await bank_version_service.latest(db_session, bank.id)
    bundle = await bank_bundle_service.export_bank_bundle(db_session, bank.id)
    bundle["questions"][0]["text"] = "Reworded by the sync"
    result = await bank_bundle_service.import_bank_bundle(db_session, bundle)
    assert result.published_version_no == 2
    v2 = await bank_version_service.latest(db_session, bank.id)
    assert v2.reason == "import"

    # A user pinned to v1 keeps it, and v1 is still a complete interview on its own questions.
    pinned = await bank_version_service.resolve_for_start(db_session, bank.id, v1.id)
    assert pinned == v1.id
    asked = await resolve_questions(db_session, bank.id, v1.id)
    assert [x.prompt for x in asked] == ["How do you escalate an issue?"]
    rows = await bank_version_service.rubric_rows(
        db_session, question_id=q.id, bank_version_id=v1.id
    )
    assert [r.text for r in rows] == ["Escalates within 24 hours", "Known source conflict"]
    new_q = bank_version_service.questions_of(v2)[0]
    assert new_q["text"] == "Reworded by the sync" and new_q["id"] != q.id


async def test_an_incomplete_import_stays_a_draft(db_session):
    from app.services import bank_bundle_service

    bundle = {
        "format_version": 1,
        "bank": {"name": "Rubricless"},
        "questions": [{"text": "Q?", "language": "en-US"}],
    }
    result = await bank_bundle_service.import_bank_bundle(db_session, bundle)
    assert (result.published_version_no, result.publish_problems) == (None, ["no_rubric"])
    assert await bank_version_service.latest(db_session, result.bank_id) is None


async def test_an_assigned_version_of_another_bank_falls_back_to_the_latest(db_session):
    bank, *_ = await _bank(db_session)
    other, *_ = await _bank(db_session, name="Other", is_default=False)
    other_v = await bank_version_service.latest(db_session, other.id)
    pinned = await bank_version_service.resolve_for_start(db_session, bank.id, other_v.id)
    assert pinned == (await bank_version_service.latest(db_session, bank.id)).id
    assert await bank_version_service.resolve_for_start(db_session, None, other_v.id) is None


async def test_a_bank_never_published_is_read_from_its_draft(db_session):
    bank, q, *_ = await _bank(db_session, publish=False)
    assert await bank_version_service.resolve_for_start(db_session, bank.id, None) is None
    rows = await bank_version_service.rubric_rows(
        db_session, question_id=q.id, bank_version_id=None
    )
    assert [r.text for r in rows] == ["Escalates within 24 hours", "Known source conflict"]
    gone = await bank_version_service.rubric_rows(
        db_session, question_id=q.id, bank_version_id="gone"
    )
    assert [r.text for r in gone] == ["Escalates within 24 hours", "Known source conflict"]
    assert (
        await bank_version_service.rubric_rows(
            db_session, question_id="no-question", bank_version_id=None
        )
        == []
    )


async def test_the_judge_and_the_coverage_audit_read_the_pinned_version(
    client, db_session, admin_auth, scripted_judge, monkeypatch
):
    from app.interview import judge as judge_mod
    from app.interview import judge_flow
    from app.services import persona_service, sop_coverage

    await persona_service.create_persona(
        db_session,
        name=f"Judge {uuid.uuid4().hex[:6]}",
        is_default=True,
        bank_turn_mode="judged",
        judge_max_calls_per_question=2,
    )
    bank, q, checklist, _doc = await _bank(db_session)
    user = await _user(db_session)
    headers = await _headers(client, user)
    session = await _session_row(db_session, await _start(client, headers))
    assert session.bank_version_id is not None and session.turn_mode == "judged"
    await checklist_service.update_items(
        db_session,
        checklist.id,
        [{"kind": "required", "text": "Edited after start", "weight": 100}],
    )
    await bank_version_service.publish(db_session, bank.id)

    seen: list = []
    real_run = judge_mod.run_judge

    async def capture(inp, adapter):
        seen.append([i.text for i in inp.checklist])
        return await real_run(inp, adapter)

    monkeypatch.setattr(judge_mod, "run_judge", capture)
    session = await _session_row(db_session, session.id)
    await judge_flow.judge(
        db_session,
        session,
        question_id=q.id,
        follow_ups_asked=0,
        draft_text="I escalate and",
        trigger="voice_silence",
        dry_run=True,
    )
    assert seen == [["Escalates within 24 hours", "Known source conflict"]]
    # No SOP passage is ingested for the cited document: the audit reads the pinned rows, stops.
    assert (
        await sop_coverage.prepare_coverage(
            db_session, question_id=q.id, question_text="q", bank_version_id=session.bank_version_id
        )
        is None
    )


async def test_admin_detail_shows_the_version_and_the_candidate_view_hides_it(
    client, db_session, admin_auth
):
    from app.models.anonymous_session import AnonymousCandidateSession
    from app.services import interview_history_service

    await _bank(db_session)
    user = await _user(db_session)
    iv = await _start(client, await _headers(client, user))
    admin_view = (await client.get(f"/admin/interviews/{iv}", headers=admin_auth)).json()
    assert admin_view["bank_version_no"] == 1
    page = (await client.get("/admin/interviews", headers=admin_auth)).json()
    assert {i["id"]: i for i in page["items"]}[iv]["bank_version_no"] == 1
    session = await _session_row(db_session, iv)
    candidate = await db_session.get(AnonymousCandidateSession, session.candidate_session_id)
    mine = await interview_history_service.get_detail(db_session, iv, candidate=candidate)
    assert mine is not None and mine.bank_version_no is None
