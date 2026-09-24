"""End-to-end thin-slice API tests (SPEC F6/F9 spine).

Proves ask → answer → placeholder report over HTTP, plus the auth + ownership guards
(anonymous session required; one candidate cannot touch another's interview).
"""

import pytest

from tests.candidate_helpers import mint_candidate_headers


async def _new_candidate_headers(client) -> dict:
    # #102: minting a session needs a logged-in candidate; each call = a fresh candidate user.
    return await mint_candidate_headers(client)


# --- F2 candidate question list (AC #2, P3 no-leak) ------------------------


@pytest.mark.asyncio
async def test_questions_requires_anon_session(client):
    assert (await client.get("/candidate/interview/questions")).status_code == 401


@pytest.mark.asyncio
async def test_questions_empty_when_no_bank(client):
    headers = await _new_candidate_headers(client)
    resp = await client.get("/candidate/interview/questions", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["bank_id"] is None
    assert body["questions"] == []


@pytest.mark.asyncio
async def test_questions_returns_ordered_bank_without_rubric(client, db_session):
    # AC #1/#2: seeded bank, 10 ordered questions. P3: no expected_points/rubric in the payload.
    from app.services import question_seed

    await question_seed.seed_default_bank(db_session)
    headers = await _new_candidate_headers(client)
    resp = await client.get("/candidate/interview/questions", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["questions"]) == 10
    assert [q["order_index"] for q in body["questions"]] == list(range(10))
    # P3: candidate payload must not carry rubric-linked fields.
    flat = str(body).lower()
    for leaked in ("expected_points", "checklist", "rubric", "weight"):
        assert leaked not in flat


@pytest.mark.asyncio
async def test_start_requires_anon_session(client):
    resp = await client.post("/candidate/interview/start")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_full_thin_slice_flow(client):
    headers = await _new_candidate_headers(client)

    start = await client.post("/candidate/interview/start", headers=headers)
    assert start.status_code == 200
    body = start.json()
    interview_id = body["interview_session_id"]
    assert body["status"] == "in_progress"
    assert body["current_question"]["index"] == 0
    total = body["current_question"]["total"]

    # Answer until the interview completes (a question may ask a follow-up, so the number of
    # answers can exceed the question count — F6 AC #4).
    status_body = body
    for _ in range(20):  # generous cap so a bug loops-out instead of hanging
        if status_body["status"] == "completed":
            break
        status_body = (
            await client.post(
                f"/candidate/interview/{interview_id}/answer",
                headers=headers,
                json={"text": "a sufficiently detailed answer for scoring", "source": "text"},
            )
        ).json()
    assert status_body["status"] == "completed"
    assert status_body["current_question"] is None

    report = await client.post(f"/candidate/interview/{interview_id}/report", headers=headers)
    assert report.status_code == 200
    rbody = report.json()
    assert rbody["status"] == "scored"
    assert len(rbody["per_question"]) == total
    assert rbody["is_stub"] is True
    assert 0.0 <= rbody["coverage_pct"] <= 100.0


@pytest.mark.asyncio
async def test_scored_report_surfaces_f4_fields(client, db_session):
    # With a checklist drafted, the report exposes total_score/grade + per-item judgments (F4).
    from app.services import checklist_service, question_service

    bank = await question_service.create_bank(db_session, name="B", is_default=True)
    q = await question_service.add_question(
        db_session, bank_id=bank.id, text="Describe the safety procedure.", order_index=0
    )
    await checklist_service.draft_checklist(db_session, q.id)

    headers = await _new_candidate_headers(client)
    interview_id = (await client.post("/candidate/interview/start", headers=headers)).json()[
        "interview_session_id"
    ]
    status_body = {"status": "in_progress"}
    for _ in range(20):
        if status_body["status"] == "completed":
            break
        status_body = (
            await client.post(
                f"/candidate/interview/{interview_id}/answer",
                headers=headers,
                json={
                    "text": "I followed each documented step and checked safety.",
                    "source": "text",
                },
            )
        ).json()

    report = (
        await client.post(f"/candidate/interview/{interview_id}/report", headers=headers)
    ).json()
    assert report["is_stub"] is False
    assert report["total_score"] is not None
    assert report["grade"] in ("A", "B", "C", "D", "F")
    assert report["per_question"][0]["items"]  # per-item judgments present in the API payload


@pytest.mark.asyncio
async def test_submit_on_follow_up_question_advances_without_citation(client):
    # Until v0.39.1.0 this was F7 AC #1/#2 over HTTP: the fallback q2 (max_follow_ups>0) answered
    # a template follow-up that quoted the candidate. Owner rule (v0.39.2.0): a submit ALWAYS
    # advances, so the candidate sees the NEXT question, never a quote of their own words. (The F7
    # citation helper lives on as the retained provider hook — see test_interview_state_machine.)
    from app.interview.questions import FALLBACK_QUESTIONS

    headers = await _new_candidate_headers(client)
    start = (await client.post("/candidate/interview/start", headers=headers)).json()
    interview_id = start["interview_session_id"]
    fu_index = next(i for i, q in enumerate(FALLBACK_QUESTIONS) if q.max_follow_ups > 0)
    for _ in range(fu_index):
        await client.post(
            f"/candidate/interview/{interview_id}/answer",
            headers=headers,
            json={"text": "My relevant experience is in SRE on-call.", "source": "text"},
        )
    distinctive = "I double-check the runbook before every deploy."
    body = (
        await client.post(
            f"/candidate/interview/{interview_id}/answer",
            headers=headers,
            json={"text": distinctive, "source": "text"},
        )
    ).json()
    following = FALLBACK_QUESTIONS[fu_index + 1] if fu_index + 1 < len(FALLBACK_QUESTIONS) else None
    if following is None:
        assert body["status"] == "completed" and body["current_question"] is None
    else:
        assert body["status"] == "in_progress"
        assert body["current_question"]["is_follow_up"] is False
        assert body["current_question"]["prompt"] == following.prompt
        assert distinctive not in body["current_question"]["prompt"]


@pytest.mark.asyncio
async def test_answer_rejects_bad_source(client):
    headers = await _new_candidate_headers(client)
    interview_id = (await client.post("/candidate/interview/start", headers=headers)).json()[
        "interview_session_id"
    ]
    resp = await client.post(
        f"/candidate/interview/{interview_id}/answer",
        headers=headers,
        json={"text": "hi", "source": "telepathy"},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_cannot_access_another_candidates_interview(client):
    headers_a = await _new_candidate_headers(client)
    headers_b = await _new_candidate_headers(client)
    interview_id = (await client.post("/candidate/interview/start", headers=headers_a)).json()[
        "interview_session_id"
    ]

    # Candidate B must not see or drive A's interview — 404 (no existence leak).
    resp = await client.post(
        f"/candidate/interview/{interview_id}/answer",
        headers=headers_b,
        json={"text": "intruder", "source": "text"},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_report_before_completion_conflicts(client):
    headers = await _new_candidate_headers(client)
    interview_id = (await client.post("/candidate/interview/start", headers=headers)).json()[
        "interview_session_id"
    ]
    resp = await client.post(f"/candidate/interview/{interview_id}/report", headers=headers)
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_missing_interview_is_404(client):
    headers = await _new_candidate_headers(client)
    resp = await client.post(
        "/candidate/interview/does-not-exist/answer",
        headers=headers,
        json={"text": "x", "source": "text"},
    )
    assert resp.status_code == 404


# --- Empty-answer rejection + pre-scoring review (requirements 3 & 4) --------


@pytest.mark.asyncio
@pytest.mark.parametrize("blank", ["", "   ", "\n\t "])
async def test_answer_rejects_empty_text(client, blank):
    # Requirement 3: an empty (or whitespace-only) answer cannot pass — 422 at the edge, so a blank
    # voice/text submission never reaches the state machine or shows up as "unanswered" in a report.
    headers = await _new_candidate_headers(client)
    interview_id = (await client.post("/candidate/interview/start", headers=headers)).json()[
        "interview_session_id"
    ]
    resp = await client.post(
        f"/candidate/interview/{interview_id}/answer",
        headers=headers,
        json={"text": blank, "source": "text"},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_answer_rejects_verbal_cue_that_strips_to_empty(client):
    # A verbal-cue message that is ONLY the cue ("我答完了") passes the 422 non-blank check (it has
    # content) but strips to empty in the state machine — must be rejected (409), never recorded as
    # a silent blank answer.
    headers = await _new_candidate_headers(client)
    interview_id = (await client.post("/candidate/interview/start", headers=headers)).json()[
        "interview_session_id"
    ]
    resp = await client.post(
        f"/candidate/interview/{interview_id}/answer",
        headers=headers,
        json={"text": "我答完了", "source": "verbal_cue"},
    )
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_review_requires_completion(client):
    # Requirement 4: the review screen is only meaningful once every question is answered — a still
    # in_progress interview is a 409, the same "not before completion" contract as /report.
    headers = await _new_candidate_headers(client)
    interview_id = (await client.post("/candidate/interview/start", headers=headers)).json()[
        "interview_session_id"
    ]
    resp = await client.get(f"/candidate/interview/{interview_id}/review", headers=headers)
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_review_returns_answers_in_bank_order(client):
    # After completion, /review returns every answered question + the candidate's own answer, in
    # bank order (requirement 2), candidate-safe (no rubric/score fields).
    headers = await _new_candidate_headers(client)
    start = (await client.post("/candidate/interview/start", headers=headers)).json()
    interview_id = start["interview_session_id"]

    status_body = start
    n = 0
    for _ in range(20):
        if status_body["status"] == "completed":
            break
        n += 1
        status_body = (
            await client.post(
                f"/candidate/interview/{interview_id}/answer",
                headers=headers,
                json={"text": f"distinct answer number {n}", "source": "text"},
            )
        ).json()
    assert status_body["status"] == "completed"

    resp = await client.get(f"/candidate/interview/{interview_id}/review", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["interview_session_id"] == interview_id
    # Answers are in ascending bank order.
    indices = [a["index"] for a in body["answers"]]
    assert indices == sorted(indices)
    # Candidate-safe payload: prompt + answer only, no rubric-linked fields (P3).
    flat = str(body).lower()
    for leaked in ("expected_points", "checklist", "rubric", "weight", "judgment"):
        assert leaked not in flat


@pytest.mark.asyncio
async def test_review_ownership_guarded(client):
    # Another candidate cannot read this interview's review — 404 (no existence leak).
    headers_a = await _new_candidate_headers(client)
    headers_b = await _new_candidate_headers(client)
    interview_id = (await client.post("/candidate/interview/start", headers=headers_a)).json()[
        "interview_session_id"
    ]
    resp = await client.get(f"/candidate/interview/{interview_id}/review", headers=headers_b)
    assert resp.status_code == 404


# --- Voice session (SPEC F9) ------------------------------------------------


async def _start_interview(client) -> tuple[dict, str]:
    headers = await _new_candidate_headers(client)
    interview_id = (await client.post("/candidate/interview/start", headers=headers)).json()[
        "interview_session_id"
    ]
    return headers, interview_id


@pytest.mark.asyncio
async def test_voice_session_requires_anon_session(client):
    resp = await client.post("/candidate/interview/whatever/voice/session")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_voice_session_404_for_unowned_interview(client):
    _, interview_id = await _start_interview(client)
    headers_b = await _new_candidate_headers(client)
    resp = await client.post(
        f"/candidate/interview/{interview_id}/voice/session", headers=headers_b
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_voice_session_503_when_no_persona(client):
    # No persona configured at all → Voice Live unavailable (503), candidate stays on text.
    headers, interview_id = await _start_interview(client)
    resp = await client.post(f"/candidate/interview/{interview_id}/voice/session", headers=headers)
    assert resp.status_code == 503


@pytest.mark.asyncio
async def test_voice_session_409_when_persona_not_synced(client, db_session):
    # P5: an unsynced interviewer agent must be rejected (409), not degraded to model mode.
    from app.services import persona_service as psvc

    await psvc.create_persona(db_session, name="Interviewer", is_default=True)
    headers, interview_id = await _start_interview(client)
    resp = await client.post(f"/candidate/interview/{interview_id}/voice/session", headers=headers)
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_voice_session_succeeds_for_synced_persona(client, db_session):
    from app.services import persona_service as psvc

    persona = await psvc.create_persona(
        db_session,
        name="Interviewer",
        character="lisa",
        style="casual",
        voice_map='{"zh-CN": "zh-CN-XiaoxiaoNeural"}',
        is_default=True,
    )
    await psvc.mark_sync_succeeded(db_session, persona, agent_id="agent-9", agent_version="1")

    headers, interview_id = await _start_interview(client)
    resp = await client.post(
        f"/candidate/interview/{interview_id}/voice/session",
        headers=headers,
        json={"locale": "zh-CN"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["interview_session_id"] == interview_id
    assert body["mode"] == "agent"
    assert body["auth_type"] == "bearer"
    assert body["signaling_url"].startswith("wss://")
    # P3/P12: no checklist/rubric/SOP content ever appears in a candidate voice payload.
    flat = str(body).lower()
    for leaked in ("checklist", "rubric", "weight", "source_quote"):
        assert leaked not in flat


@pytest.mark.asyncio
async def test_voice_session_409_after_completion(client, db_session):
    # Voice only makes sense while in_progress; a completed interview is a 409.
    from app.services import persona_service as psvc

    persona = await psvc.create_persona(db_session, name="I", is_default=True)
    await psvc.mark_sync_succeeded(db_session, persona, agent_id="a", agent_version="1")

    headers, interview_id = await _start_interview(client)
    # Drive to completion.
    status_body = {"status": "in_progress"}
    for _ in range(20):
        if status_body["status"] == "completed":
            break
        status_body = (
            await client.post(
                f"/candidate/interview/{interview_id}/answer",
                headers=headers,
                json={"text": "a sufficiently detailed answer", "source": "text"},
            )
        ).json()
    resp = await client.post(f"/candidate/interview/{interview_id}/voice/session", headers=headers)
    assert resp.status_code == 409


# --- resume (F6 edge b) + non-text sources over HTTP -----------------------


@pytest.mark.asyncio
async def test_get_interview_replays_current_question(client):
    """GET /{id} reads status + current question without mutating (resume on reload)."""
    headers, interview_id = await _start_interview(client)
    resp = await client.get(f"/candidate/interview/{interview_id}", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["interview_session_id"] == interview_id
    assert body["status"] == "in_progress"
    assert body["current_question"]["index"] == 0
    # Idempotent: a second GET returns the same pending question (no advance).
    again = (await client.get(f"/candidate/interview/{interview_id}", headers=headers)).json()
    assert again["current_question"]["index"] == 0


@pytest.mark.asyncio
async def test_get_interview_ownership_guarded(client):
    """Another candidate cannot read someone else's interview (same 404 as not-found)."""
    _, interview_id = await _start_interview(client)
    other = await _new_candidate_headers(client)
    resp = await client.get(f"/candidate/interview/{interview_id}", headers=other)
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_start_twice_resumes_same_interview(client):
    """A second POST /start for the same candidate resumes, not orphans (edge b)."""
    headers, first_id = await _start_interview(client)
    # advance a turn so it's mid-interview
    await client.post(
        f"/candidate/interview/{first_id}/answer",
        headers=headers,
        json={"text": "an answer of ample length", "source": "text"},
    )
    second = (await client.post("/candidate/interview/start", headers=headers)).json()
    assert second["interview_session_id"] == first_id  # resumed, same session


@pytest.mark.asyncio
async def test_answer_accepts_voice_source_over_http(client):
    """source=voice round-trips through /answer (Pydantic validation + advance), not just text."""
    headers, interview_id = await _start_interview(client)
    resp = await client.post(
        f"/candidate/interview/{interview_id}/answer",
        headers=headers,
        json={"text": "my spoken answer, long enough", "source": "voice"},
    )
    assert resp.status_code == 200
    assert resp.json()["current_question"]["index"] == 1


@pytest.mark.asyncio
async def test_answer_rejects_unknown_source_over_http(client):
    headers, interview_id = await _start_interview(client)
    resp = await client.post(
        f"/candidate/interview/{interview_id}/answer",
        headers=headers,
        json={"text": "x", "source": "carrier-pigeon"},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_text_answer_works_after_failed_voice_session(client, db_session):
    """Edge c/d: a failed voice/session (no persona → 503) never blocks the text path."""
    headers, interview_id = await _start_interview(client)
    # No persona configured → voice broker is unavailable (503).
    voice = await client.post(f"/candidate/interview/{interview_id}/voice/session", headers=headers)
    assert voice.status_code == 503
    # Text still advances the same interview.
    answer = await client.post(
        f"/candidate/interview/{interview_id}/answer",
        headers=headers,
        json={"text": "a text answer after voice failed, long enough", "source": "text"},
    )
    assert answer.status_code == 200
    assert answer.json()["current_question"]["index"] == 1


# --- Clickable citation: candidate can open a cited SOP source document --------------------
#
# Deliberate, tightly-scoped relaxation of P4/P12: a candidate may open ONLY the source documents
# cited by their OWN scored report, server-mediated (no raw blob URL). Two guards, both 404.


async def _seed_question_citing_doc(db_session, *, doc_bytes: bytes = b"%PDF-1.4 fake sop bytes"):
    """Seed a default bank + one question + a default checklist whose required item cites a real
    stored SOP document. Returns (document_id, document_name). Mirrors the live importer shape:
    ``ChecklistItem.source_document_id`` → ``SopDocument`` with bytes in the blob store."""
    from app.models.checklist import Checklist, ChecklistItem
    from app.models.sop import SopDocument
    from app.services import question_service
    from app.services.storage import get_storage

    bank = await question_service.create_bank(db_session, name="B", is_default=True)
    q = await question_service.add_question(
        db_session, bank_id=bank.id, text="Describe the safety procedure.", order_index=0
    )
    doc_name = "安全操作规程.pdf"  # non-ASCII: exercises the RFC 5987 filename* path
    blob_path = get_storage().save("test/sop-cited.pdf", doc_bytes)
    doc = SopDocument(
        name=doc_name,
        blob_path=blob_path,
        content_type="application/pdf",
        size=len(doc_bytes),
        status="indexed",
    )
    db_session.add(doc)
    await db_session.flush()
    checklist = Checklist(question_id=q.id, is_default=True)
    db_session.add(checklist)
    await db_session.flush()
    db_session.add(
        ChecklistItem(
            checklist_id=checklist.id,
            kind="required",
            text="Follow the documented steps in order.",
            weight=100,
            source_quote="Follow the documented steps in order.",
            source_document_id=doc.id,
            source_page="p.1",
            order_index=0,
        )
    )
    await db_session.commit()
    return doc.id, doc_name


async def _complete_interview(client, headers) -> str:
    interview_id = (await client.post("/candidate/interview/start", headers=headers)).json()[
        "interview_session_id"
    ]
    status_body = {"status": "in_progress"}
    for _ in range(20):
        if status_body["status"] == "completed":
            break
        status_body = (
            await client.post(
                f"/candidate/interview/{interview_id}/answer",
                headers=headers,
                json={
                    "text": "I followed each documented step and checked safety.",
                    "source": "text",
                },
            )
        ).json()
    await client.post(f"/candidate/interview/{interview_id}/report", headers=headers)
    return interview_id


@pytest.mark.asyncio
async def test_sop_document_served_for_cited_doc_of_owned_interview(client, db_session):
    doc_bytes = b"%PDF-1.4 fake sop bytes"
    doc_id, doc_name = await _seed_question_citing_doc(db_session, doc_bytes=doc_bytes)
    headers = await _new_candidate_headers(client)
    interview_id = await _complete_interview(client, headers)

    # The report should carry the citation's document id (proof the link target is wired through).
    report = (
        await client.post(f"/candidate/interview/{interview_id}/report", headers=headers)
    ).json()
    item = report["per_question"][0]["items"][0]
    assert item["source_document_id"] == doc_id
    assert item["source_document_name"] == doc_name

    resp = await client.get(f"/candidate/interview/{interview_id}/sop/{doc_id}", headers=headers)
    assert resp.status_code == 200
    assert resp.content == doc_bytes
    assert resp.headers["content-type"].startswith("application/pdf")
    # Inline preview + RFC 5987 non-ASCII filename.
    assert "inline" in resp.headers["content-disposition"]
    assert "filename*=UTF-8''" in resp.headers["content-disposition"]


@pytest.mark.asyncio
async def test_sop_document_requires_anon_session(client, db_session):
    doc_id, _ = await _seed_question_citing_doc(db_session)
    headers = await _new_candidate_headers(client)
    interview_id = await _complete_interview(client, headers)
    # No X-Anon-Session header → 401 (auth guard runs before ownership/citation).
    resp = await client.get(f"/candidate/interview/{interview_id}/sop/{doc_id}")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_sop_document_404_for_unowned_interview(client, db_session):
    doc_id, _ = await _seed_question_citing_doc(db_session)
    headers_a = await _new_candidate_headers(client)
    interview_id = await _complete_interview(client, headers_a)
    # Candidate B cannot read A's interview citations — same 404 as missing (no existence leak).
    headers_b = await _new_candidate_headers(client)
    resp = await client.get(f"/candidate/interview/{interview_id}/sop/{doc_id}", headers=headers_b)
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_sop_document_404_for_uncited_or_unknown_id(client, db_session):
    await _seed_question_citing_doc(db_session)
    headers = await _new_candidate_headers(client)
    interview_id = await _complete_interview(client, headers)
    # An arbitrary / uncited document id is indistinguishable from a missing one (IDOR guard).
    resp = await client.get(
        f"/candidate/interview/{interview_id}/sop/not-a-cited-doc", headers=headers
    )
    assert resp.status_code == 404


# --- voice_default (issue 3: persona-driven default interview channel) ------------------------


@pytest.mark.asyncio
async def test_start_voice_default_true_when_persona_has_voice(client, db_session):
    from app.services import persona_service as psvc

    await psvc.create_persona(
        db_session,
        name="Interviewer",
        character="lisa",
        voice_map='{"en-US": "en-US-AvaNeural"}',
        is_default=True,
    )
    headers = await _new_candidate_headers(client)
    body = (await client.post("/candidate/interview/start", headers=headers)).json()
    assert body["voice_default"] is True

    # The GET (resume) entry point carries it too — a reload must land in the same channel.
    got = (
        await client.get(f"/candidate/interview/{body['interview_session_id']}", headers=headers)
    ).json()
    assert got["voice_default"] is True


@pytest.mark.asyncio
async def test_start_voice_default_false_without_configured_voice(client, db_session):
    from app.services import persona_service as psvc

    # A default persona exists but the operator never configured a voice → text stays the default
    # (resolve_voice's built-in fallback voice must NOT count as "configured").
    await psvc.create_persona(db_session, name="Interviewer", is_default=True)
    headers = await _new_candidate_headers(client)
    body = (await client.post("/candidate/interview/start", headers=headers)).json()
    assert body["voice_default"] is False


@pytest.mark.asyncio
async def test_start_voice_default_false_without_persona(client):
    headers = await _new_candidate_headers(client)
    body = (await client.post("/candidate/interview/start", headers=headers)).json()
    assert body["voice_default"] is False
    # No persona ⇒ no auto-submit either (0 = off), never null on an entry point.
    assert body["voice_auto_submit_seconds"] == 0


# --- voice_auto_submit_seconds (admin-controlled silence auto-submit, one pair per engine) ----


@pytest.mark.asyncio
async def test_start_bank_voice_auto_submit_is_off_by_default(client, db_session):
    from app.services import persona_service as psvc

    # A bank persona that never touched the knob → 0 = disabled. The turn advances only on the
    # explicit "I'm done" click (owner directive: silence alone must never advance a bank turn).
    await psvc.create_persona(db_session, name="Interviewer", is_default=True)
    headers = await _new_candidate_headers(client)
    body = (await client.post("/candidate/interview/start", headers=headers)).json()
    assert body["voice_auto_submit_seconds"] == 0


@pytest.mark.asyncio
async def test_start_bank_voice_auto_submit_seconds_when_enabled(client, db_session):
    from app.services import persona_service as psvc

    await psvc.create_persona(
        db_session,
        name="Interviewer",
        is_default=True,
        bank_auto_submit_enabled=True,
        bank_auto_submit_silence_seconds=8,
        # The EXTERNAL pair is a separate config item and must not leak into a bank session.
        external_auto_submit_enabled=True,
        external_auto_submit_silence_seconds=20,
    )
    headers = await _new_candidate_headers(client)
    body = (await client.post("/candidate/interview/start", headers=headers)).json()
    assert body["voice_auto_submit_seconds"] == 8
    # The GET (resume) entry point carries it too; a mutation response leaves it null (not
    # reported) so the UI's per-session latch is never turned off mid-interview.
    iv = body["interview_session_id"]
    got = (await client.get(f"/candidate/interview/{iv}", headers=headers)).json()
    assert got["voice_auto_submit_seconds"] == 8
    answered = (
        await client.post(
            f"/candidate/interview/{iv}/answer",
            headers=headers,
            json={"text": "an answer", "source": "voice"},
        )
    ).json()
    assert answered["voice_auto_submit_seconds"] is None
    # Every mutation route leaves it unreported — /end included.
    ended = (await client.post(f"/candidate/interview/{iv}/end", headers=headers)).json()
    assert ended["voice_auto_submit_seconds"] is None


@pytest.mark.asyncio
async def test_start_bank_voice_auto_submit_zero_when_window_set_but_disabled(client, db_session):
    from app.services import persona_service as psvc

    # The window is remembered while the switch is off, but the candidate page must see "off".
    await psvc.create_persona(
        db_session,
        name="Interviewer",
        is_default=True,
        bank_auto_submit_enabled=False,
        bank_auto_submit_silence_seconds=12,
    )
    headers = await _new_candidate_headers(client)
    body = (await client.post("/candidate/interview/start", headers=headers)).json()
    assert body["voice_auto_submit_seconds"] == 0


@pytest.mark.asyncio
async def test_start_external_voice_auto_submit_uses_external_pair(client, db_session):
    from app.services import persona_service as psvc

    # An external persona reads ITS OWN pair: ON by default (hands-free external workflow) at 3s,
    # regardless of the bank pair being off.
    await psvc.create_persona(
        db_session, name="Interviewer", is_default=True, interview_brain="external"
    )
    headers = await _new_candidate_headers(client)
    body = (await client.post("/candidate/interview/start", headers=headers)).json()
    assert body["external_phase"] is not None
    assert body["voice_auto_submit_seconds"] == 3


@pytest.mark.asyncio
async def test_external_voice_auto_submit_follows_the_session_engine_snapshot(client, db_session):
    from app.services import persona_service as psvc

    # The pair is picked by the SESSION's brain_mode (the frozen snapshot), not by the persona's
    # current engine: a persona flipped mid-interview never re-interprets the live session.
    persona = await psvc.create_persona(
        db_session,
        name="Interviewer",
        is_default=True,
        interview_brain="external",
        external_auto_submit_enabled=False,
        bank_auto_submit_enabled=True,
        bank_auto_submit_silence_seconds=9,
    )
    headers = await _new_candidate_headers(client)
    body = (await client.post("/candidate/interview/start", headers=headers)).json()
    assert body["voice_auto_submit_seconds"] == 0  # external pair OFF → off, bank pair ignored
    await psvc.update_persona(db_session, persona.id, interview_brain="bank")
    iv = body["interview_session_id"]
    got = (await client.get(f"/candidate/interview/{iv}", headers=headers)).json()
    assert got["voice_auto_submit_seconds"] == 0  # still the external session → still off


# --- voice_linear_turns (bank_turn_mode: does the model get a turn of its own between questions) --


@pytest.mark.asyncio
async def test_start_bank_voice_linear_turns_true_by_default(client, db_session):
    from app.services import persona_service as psvc

    # A bank persona that never touched the knob runs LINEAR TURNS: the page must never nudge a bare
    # response.create, so the digital human only reads the questions (no "Thank you." per pause).
    await psvc.create_persona(db_session, name="Interviewer", is_default=True)
    headers = await _new_candidate_headers(client)
    body = (await client.post("/candidate/interview/start", headers=headers)).json()
    assert body["voice_linear_turns"] is True
    # Reported on both entry points; a mutation response leaves it null (not reported) so the UI's
    # per-session latch is never flipped mid-interview — same contract as voice_auto_submit_seconds.
    iv = body["interview_session_id"]
    got = (await client.get(f"/candidate/interview/{iv}", headers=headers)).json()
    assert got["voice_linear_turns"] is True
    answered = (
        await client.post(
            f"/candidate/interview/{iv}/answer",
            headers=headers,
            json={"text": "an answer", "source": "voice"},
        )
    ).json()
    assert answered["voice_linear_turns"] is None
    ended = (await client.post(f"/candidate/interview/{iv}/end", headers=headers)).json()
    assert ended["voice_linear_turns"] is None


@pytest.mark.asyncio
async def test_start_bank_judged_session_reports_linear_turns_and_judge_seconds(client, db_session):
    from app.services import persona_service as psvc

    # Judged bank sessions are still linear-turn transport (the judge speaks through the backend,
    # never a model turn) and report the judge silence window; linear sessions report 0.
    persona = await psvc.create_persona(
        db_session,
        name="Interviewer",
        is_default=True,
        bank_turn_mode="judged",
        judge_silence_seconds=4,
    )
    headers = await _new_candidate_headers(client)
    body = (await client.post("/candidate/interview/start", headers=headers)).json()
    assert body["voice_linear_turns"] is True
    assert body["voice_judge_silence_seconds"] == 4
    iv = body["interview_session_id"]
    # Snapshot (review D6): flipping the persona back to linear mid-interview changes nothing for
    # this session — the GET still reports the judge window; a NEW session would be linear.
    await psvc.update_persona(db_session, persona.id, bank_turn_mode="linear")
    got = (await client.get(f"/candidate/interview/{iv}", headers=headers)).json()
    assert got["voice_judge_silence_seconds"] == 4
    answered = (
        await client.post(
            f"/candidate/interview/{iv}/answer",
            headers=headers,
            json={"text": "an answer", "source": "voice"},
        )
    ).json()
    assert answered["voice_judge_silence_seconds"] is None  # mutation: not reported
    other = await _new_candidate_headers(client)
    fresh = (await client.post("/candidate/interview/start", headers=other)).json()
    assert fresh["voice_judge_silence_seconds"] == 0


@pytest.mark.asyncio
async def test_external_voice_linear_turns_always_true_regardless_of_bank_mode(client, db_session):
    from app.services import persona_service as psvc

    # External sessions supply no brain of their own and are linear by construction; the bank-only
    # knob is never consulted for them.
    await psvc.create_persona(
        db_session,
        name="Interviewer",
        is_default=True,
        interview_brain="external",
        bank_turn_mode="model",
    )
    headers = await _new_candidate_headers(client)
    body = (await client.post("/candidate/interview/start", headers=headers)).json()
    assert body["external_phase"] is not None
    assert body["voice_linear_turns"] is True


@pytest.mark.asyncio
async def test_start_voice_linear_turns_without_persona_follows_the_engine(client):
    headers = await _new_candidate_headers(client)
    body = (await client.post("/candidate/interview/start", headers=headers)).json()
    # Every session is linear-turn transport since v0.39.0.0 (judged sessions speak through the
    # backend, never a model turn) — never null on an entry point.
    assert body["voice_linear_turns"] is True
    assert body["voice_judge_silence_seconds"] == 0


# --- /restart: abandon the live interview and start over (v0.38.3.0) ---------------------------


async def _seed_bank(db_session, n: int = 3) -> None:
    from app.services import persona_service as psvc

    await psvc.create_persona(db_session, name="Interviewer", is_default=True)


@pytest.mark.asyncio
async def test_restart_abandons_the_live_interview_and_starts_a_fresh_one(client, db_session):
    await _seed_bank(db_session)
    headers = await _new_candidate_headers(client)
    first = (await client.post("/candidate/interview/start", headers=headers)).json()
    iv1 = first["interview_session_id"]
    # Answer one question so the old session has real progress to abandon.
    await client.post(
        f"/candidate/interview/{iv1}/answer",
        headers=headers,
        json={"text": "a first answer", "source": "text"},
    )
    resp = await client.post(f"/candidate/interview/{iv1}/restart", headers=headers)
    assert resp.status_code == 200
    fresh = resp.json()
    iv2 = fresh["interview_session_id"]
    assert iv2 != iv1
    assert fresh["status"] == "in_progress"
    assert fresh["current_question"]["index"] == 0
    # Entry-point voice flags ride along, exactly like /start.
    assert fresh["voice_auto_submit_seconds"] == 0
    assert fresh["voice_linear_turns"] is True
    # The old session is kept for the record as ``abandoned``…
    old = (await client.get(f"/candidate/interview/{iv1}", headers=headers)).json()
    assert old["status"] == "abandoned"
    assert old["current_question"] is None
    # …is never resumed by /start (which now returns the fresh one)…
    again = (await client.post("/candidate/interview/start", headers=headers)).json()
    assert again["interview_session_id"] == iv2
    # …and can neither be reviewed, scored, restarted again, nor answered.
    assert (
        await client.get(f"/candidate/interview/{iv1}/review", headers=headers)
    ).status_code == 409
    assert (
        await client.post(f"/candidate/interview/{iv1}/report", headers=headers)
    ).status_code == 409
    assert (
        await client.post(f"/candidate/interview/{iv1}/restart", headers=headers)
    ).status_code == 409
    assert (
        await client.post(
            f"/candidate/interview/{iv1}/answer",
            headers=headers,
            json={"text": "too late", "source": "text"},
        )
    ).status_code == 409


@pytest.mark.asyncio
async def test_restart_requires_ownership_and_an_in_progress_interview(client, db_session):
    await _seed_bank(db_session)
    headers = await _new_candidate_headers(client)
    iv = (await client.post("/candidate/interview/start", headers=headers)).json()[
        "interview_session_id"
    ]
    # Another candidate cannot restart (or even see) it — 404, same as every owned route.
    other = await _new_candidate_headers(client)
    assert (
        await client.post(f"/candidate/interview/{iv}/restart", headers=other)
    ).status_code == 404
    # No auth at all → 401.
    assert (await client.post(f"/candidate/interview/{iv}/restart")).status_code == 401
    # Drive the interview to completion, then restart is a 409: a finished interview is simply
    # followed by a normal /start (nothing to abandon).
    body = (await client.get(f"/candidate/interview/{iv}", headers=headers)).json()
    while body["status"] == "in_progress":
        body = (
            await client.post(
                f"/candidate/interview/{iv}/answer",
                headers=headers,
                json={"text": "a sufficiently long answer", "source": "text"},
            )
        ).json()
    assert body["status"] == "completed"
    assert (
        await client.post(f"/candidate/interview/{iv}/restart", headers=headers)
    ).status_code == 409
    fresh = (await client.post("/candidate/interview/start", headers=headers)).json()
    assert fresh["interview_session_id"] != iv
    assert fresh["status"] == "in_progress"


@pytest.mark.asyncio
async def test_restart_external_sends_the_brain_its_end_signal_then_abandons(
    client, db_session, monkeypatch
):
    from app.api import interview as interview_api
    from app.services import persona_service as psvc

    await psvc.create_persona(
        db_session, name="Interviewer", is_default=True, interview_brain="external"
    )
    headers = await _new_candidate_headers(client)
    first = (await client.post("/candidate/interview/start", headers=headers)).json()
    assert first["external_phase"] is not None
    iv1 = first["interview_session_id"]

    ended: list[str] = []

    async def fake_end(db, session):
        # Stand-in for external_runner.end: the brain got its ``end`` and the session is completed
        # locally — restart must still turn that into ``abandoned``, never a scoreless "completed".
        ended.append(session.id)
        session.status = "completed"
        await db.commit()
        await db.refresh(session)
        return session

    monkeypatch.setattr(interview_api.external_runner, "end", fake_end)
    fresh = (await client.post(f"/candidate/interview/{iv1}/restart", headers=headers)).json()
    assert ended == [iv1]
    assert fresh["interview_session_id"] != iv1
    assert fresh["status"] == "in_progress"
    assert fresh["external_phase"] is not None  # the fresh session follows the CURRENT engine
    old = (await client.get(f"/candidate/interview/{iv1}", headers=headers)).json()
    assert old["status"] == "abandoned"


@pytest.mark.asyncio
async def test_restart_external_turn_in_flight_is_a_409_and_abandons_nothing(
    client, db_session, monkeypatch
):
    from app.api import interview as interview_api
    from app.interview.external_runner import ExternalTurnConflict
    from app.services import persona_service as psvc

    await psvc.create_persona(
        db_session, name="Interviewer", is_default=True, interview_brain="external"
    )
    headers = await _new_candidate_headers(client)
    iv1 = (await client.post("/candidate/interview/start", headers=headers)).json()[
        "interview_session_id"
    ]

    async def conflicting_end(db, session):
        raise ExternalTurnConflict("A turn is already being processed")

    monkeypatch.setattr(interview_api.external_runner, "end", conflicting_end)
    resp = await client.post(f"/candidate/interview/{iv1}/restart", headers=headers)
    assert resp.status_code == 409
    # Nothing changed: the live session is still the resumable one.
    assert (await client.post("/candidate/interview/start", headers=headers)).json()[
        "interview_session_id"
    ] == iv1


# --- POST /judge (issue #114): pre-submit judge, budget, staleness, snapshot, follow-up turn -----


async def _judged_setup(
    client, db_session, *, max_follow_ups=1, judged=True, max_calls=2, with_rubric=True
):
    """Default JUDGED persona + a default bank whose Q1 owes one follow-up and has a required item."""  # noqa: E501
    from app.services import checklist_service
    from app.services import persona_service as psvc
    from app.services import question_service as qsvc

    await psvc.create_persona(
        db_session,
        name="Interviewer",
        is_default=True,
        bank_turn_mode="judged" if judged else "linear",
        judge_max_calls_per_question=max_calls,
        prompt_fragment="You are a warm, rigorous inspector.",
    )
    bank = await qsvc.create_bank(db_session, name="B", is_default=True)
    q1 = await qsvc.add_question(
        db_session,
        bank_id=bank.id,
        text="How do you handle protocol deviations?",
        order_index=0,
        max_follow_ups=max_follow_ups,
    )
    await qsvc.add_question(
        db_session, bank_id=bank.id, text="How do you close out a site?", order_index=1
    )
    if with_rubric:
        await checklist_service.update_items(
            db_session,
            (await checklist_service.draft_checklist(db_session, q1.id, llm_provider="mock")).id,
            [
                {
                    "kind": "required",
                    "text": "Documented every protocol deviation in the log",
                    "weight": 100,
                }
            ],
        )
    headers = await _new_candidate_headers(client)
    body = (await client.post("/candidate/interview/start", headers=headers)).json()
    return headers, body["interview_session_id"], q1.id


def _judge_body(qid, text="I log them the same day and", asked=0, trigger="voice_silence"):
    return {"question_id": qid, "follow_ups_asked": asked, "draft_text": text, "trigger": trigger}


async def _events(db_session, iv):
    from sqlalchemy import select

    from app.models.judge_event import JudgeEvent

    return (
        (await db_session.execute(select(JudgeEvent).where(JudgeEvent.interview_session_id == iv)))
        .scalars()
        .all()
    )


@pytest.mark.asyncio
async def test_judge_nudge_returns_text_writes_event_and_no_turn(
    client, db_session, scripted_judge
):
    headers, iv, qid = await _judged_setup(client, db_session)
    scripted_judge.responses.append(
        '{"verdict": "nudge", "speech_text": "Please go on.", "reason": "trailed"}'
    )
    r = await client.post(
        f"/candidate/interview/{iv}/judge", headers=headers, json=_judge_body(qid)
    )
    assert r.status_code == 200
    out = r.json()
    assert (out["verdict"], out["speech_text"], out["interview"]) == (
        "nudge",
        "Please go on.",
        None,
    )
    assert out["event_id"]
    ev = await _events(db_session, iv)
    assert [(e.verdict, e.trigger, e.question_id) for e in ev] == [("nudge", "voice_silence", qid)]
    assert ev[0].latency_ms >= 0 and ev[0].model == "scripted"
    # The persona prompt and the delimited draft reached the model; the header is unchanged.
    assert "warm, rigorous inspector" in scripted_judge.prompts[0]
    got = (await client.get(f"/candidate/interview/{iv}", headers=headers)).json()
    assert got["current_question"]["is_follow_up"] is False


@pytest.mark.asyncio
async def test_judge_follow_up_writes_turn_switches_header_and_submit_still_advances(
    client, db_session, scripted_judge
):
    headers, iv, qid = await _judged_setup(client, db_session)
    scripted_judge.responses.append(
        '{"verdict": "follow_up", "speech_text": "How do you make sure none slip past you?", "reason": "req missing"}'  # noqa: E501
    )
    out = (
        await client.post(
            f"/candidate/interview/{iv}/judge", headers=headers, json=_judge_body(qid)
        )
    ).json()
    assert out["verdict"] == "follow_up"
    assert out["interview"]["current_question"]["is_follow_up"] is True
    assert (
        out["interview"]["current_question"]["prompt"] == "How do you make sure none slip past you?"
    )
    # The slot is consumed: a second judge call is stale on follow_ups_asked=0 → wait, no LLM call…
    scripted_judge.responses.append('{"verdict": "nudge", "speech_text": "x"}')
    again = (
        await client.post(
            f"/candidate/interview/{iv}/judge", headers=headers, json=_judge_body(qid)
        )
    ).json()
    assert again["verdict"] == "wait"
    scripted_judge.responses.clear()  # the stale call consumed nothing
    # …and with the right count only wait/nudge are allowed (a follow_up answer is an error).
    scripted_judge.responses.append('{"verdict": "follow_up", "speech_text": "More?"}')
    again = (
        await client.post(
            f"/candidate/interview/{iv}/judge", headers=headers, json=_judge_body(qid, asked=1)
        )
    ).json()
    assert again["verdict"] == "wait"
    assert [e.verdict for e in await _events(db_session, iv)] == ["follow_up", "error"]
    # "I'm done" ALWAYS advances — no template follow-up, no LLM call, straight to Q2.
    n_prompts = len(scripted_judge.prompts)
    answered = (
        await client.post(
            f"/candidate/interview/{iv}/answer",
            headers=headers,
            json={"text": "a full answer here", "source": "voice"},
        )
    ).json()
    assert answered["current_question"]["prompt"] == "How do you close out a site?"
    assert answered["current_question"]["is_follow_up"] is False
    assert len(scripted_judge.prompts) == n_prompts


@pytest.mark.asyncio
async def test_judge_cheap_exits_make_no_llm_call_and_no_event(client, db_session, scripted_judge):
    headers, iv, qid = await _judged_setup(client, db_session)
    scripted_judge.responses.extend(['{"verdict": "nudge", "speech_text": "x"}'] * 5)
    # blank draft, stale question id, stale follow-up count → wait
    for body in (_judge_body(qid, text="   "), _judge_body("other-q"), _judge_body(qid, asked=3)):
        r = (
            await client.post(f"/candidate/interview/{iv}/judge", headers=headers, json=body)
        ).json()
        assert (r["verdict"], r["speech_text"], r["interview"], r["event_id"]) == (
            "wait",
            "",
            None,
            None,
        )
    assert scripted_judge.prompts == [] and await _events(db_session, iv) == []
    # unknown trigger → 422; another candidate → 404
    assert (
        await client.post(
            f"/candidate/interview/{iv}/judge",
            headers=headers,
            json=_judge_body(qid, trigger="mouse"),
        )
    ).status_code == 422
    other = await _new_candidate_headers(client)
    assert (
        await client.post(f"/candidate/interview/{iv}/judge", headers=other, json=_judge_body(qid))
    ).status_code == 404


@pytest.mark.asyncio
async def test_judge_budget_counts_delivered_verdicts_and_bounds_raw_llm_calls(
    client, db_session, scripted_judge
):
    # Budget = DELIVERED verdicts per question (wait never consumes it); raw LLM calls are bounded at  # noqa: E501
    # 3× the budget so a chatty answer's discarded prefetches can't run away (D17).
    headers, iv, qid = await _judged_setup(client, db_session, max_calls=2)
    scripted_judge.responses.extend(['{"verdict": "wait", "speech_text": "", "reason": "r"}'] * 10)
    for _ in range(8):
        await client.post(
            f"/candidate/interview/{iv}/judge", headers=headers, json=_judge_body(qid)
        )
    assert len(scripted_judge.prompts) == 6  # 2 × 3 raw-call bound
    scripted_judge.prompts.clear()
    # Delivered verdicts: two nudges spend the budget; the third pause is silent with no LLM call.
    headers2, iv2, qid2 = await _judged_setup(client, db_session, max_calls=2)
    scripted_judge.responses.clear()
    scripted_judge.responses.extend(['{"verdict": "nudge", "speech_text": "Go on."}'] * 3)
    verdicts = []
    for _ in range(3):
        r = (
            await client.post(
                f"/candidate/interview/{iv2}/judge", headers=headers2, json=_judge_body(qid2)
            )
        ).json()
        verdicts.append(r["verdict"])
    assert verdicts == ["nudge", "nudge", "wait"]
    assert len(scripted_judge.prompts) == 2


@pytest.mark.asyncio
async def test_judge_dry_run_then_apply_writes_the_follow_up_only_on_apply(
    client, db_session, scripted_judge
):
    headers, iv, qid = await _judged_setup(client, db_session, max_calls=2)
    scripted_judge.responses.append(
        '{"verdict": "follow_up", "speech_text": "Who do you notify?", "reason": "req missing"}'
    )
    dry = (
        await client.post(
            f"/candidate/interview/{iv}/judge",
            headers=headers,
            json={**_judge_body(qid), "dry_run": True},
        )
    ).json()
    assert dry["verdict"] == "follow_up" and dry["interview"] is None and dry["event_id"]
    # Nothing written yet: header unchanged, event not applied, budget untouched.
    got = (await client.get(f"/candidate/interview/{iv}", headers=headers)).json()
    assert got["current_question"]["is_follow_up"] is False
    ev = await _events(db_session, iv)
    assert [(e.verdict, e.applied) for e in ev] == [("follow_up", False)]
    # The pause lasted → apply: the turn is written, the header switches, the event is applied.
    applied = (
        await client.post(
            f"/candidate/interview/{iv}/judge/apply",
            headers=headers,
            json={"event_id": dry["event_id"], "question_id": qid, "follow_ups_asked": 0},
        )
    ).json()
    assert applied["verdict"] == "follow_up"
    assert applied["interview"]["current_question"]["prompt"] == "Who do you notify?"
    assert applied["interview"]["current_question"]["is_follow_up"] is True
    await db_session.refresh(ev[0])
    assert ev[0].applied is True
    # Idempotent + stale-safe: applying again, or with the old follow-up count, is a silent wait.
    for body in (
        {"event_id": dry["event_id"], "question_id": qid, "follow_ups_asked": 1},
        {"event_id": dry["event_id"], "question_id": qid, "follow_ups_asked": 0},
        {"event_id": "nope", "question_id": qid, "follow_ups_asked": 1},
    ):
        again = (
            await client.post(f"/candidate/interview/{iv}/judge/apply", headers=headers, json=body)
        ).json()
        assert again["verdict"] == "wait"
    assert len(await _events(db_session, iv)) == 1


@pytest.mark.asyncio
async def test_judge_dry_run_nudge_and_wait_apply_semantics(client, db_session, scripted_judge):
    headers, iv, qid = await _judged_setup(client, db_session, max_calls=1)
    scripted_judge.responses.extend(
        [
            '{"verdict": "wait", "speech_text": ""}',
            '{"verdict": "nudge", "speech_text": "Please go on."}',
        ]
    )
    dry = {**_judge_body(qid), "dry_run": True}
    w = (await client.post(f"/candidate/interview/{iv}/judge", headers=headers, json=dry)).json()
    # A wait can be "applied" — it stays silent and never consumes budget.
    r = (
        await client.post(
            f"/candidate/interview/{iv}/judge/apply",
            headers=headers,
            json={"event_id": w["event_id"], "question_id": qid, "follow_ups_asked": 0},
        )
    ).json()
    assert r["verdict"] == "wait"
    n = (await client.post(f"/candidate/interview/{iv}/judge", headers=headers, json=dry)).json()
    assert n["verdict"] == "nudge"
    r = (
        await client.post(
            f"/candidate/interview/{iv}/judge/apply",
            headers=headers,
            json={"event_id": n["event_id"], "question_id": qid, "follow_ups_asked": 0},
        )
    ).json()
    assert r["verdict"] == "nudge" and r["speech_text"] == "Please go on."
    assert r["interview"] is None
    ev = await _events(db_session, iv)
    assert sorted((e.verdict, e.applied) for e in ev) == [("nudge", True), ("wait", False)]
    # Budget (1) is now spent: another dry run is a wait without an LLM call.
    before = len(scripted_judge.prompts)
    scripted_judge.responses.append('{"verdict": "nudge", "speech_text": "x"}')
    again = (
        await client.post(f"/candidate/interview/{iv}/judge", headers=headers, json=dry)
    ).json()
    assert again["verdict"] == "wait" and len(scripted_judge.prompts) == before
    # Other candidates cannot apply this session's events.
    other = await _new_candidate_headers(client)
    assert (
        await client.post(
            f"/candidate/interview/{iv}/judge/apply",
            headers=other,
            json={"event_id": n["event_id"], "question_id": qid, "follow_ups_asked": 0},
        )
    ).status_code == 404


@pytest.mark.asyncio
async def test_judge_max_calls_zero_never_calls_the_llm(client, db_session, scripted_judge):
    headers, iv, qid = await _judged_setup(client, db_session, max_calls=0)
    scripted_judge.responses.append('{"verdict": "nudge", "speech_text": "x"}')
    r = (
        await client.post(
            f"/candidate/interview/{iv}/judge", headers=headers, json=_judge_body(qid)
        )
    ).json()
    assert r["verdict"] == "wait" and scripted_judge.prompts == []


@pytest.mark.asyncio
async def test_judge_error_and_leak_are_recorded_and_harmless(client, db_session, scripted_judge):
    headers, iv, qid = await _judged_setup(client, db_session, max_calls=5)
    scripted_judge.responses.extend(
        [
            RuntimeError("gateway down"),
            "garbage",
            '{"verdict": "follow_up", "speech_text": "Did you document every protocol deviation in the log?"}',  # noqa: E501
        ]
    )
    for _ in range(3):
        r = (
            await client.post(
                f"/candidate/interview/{iv}/judge", headers=headers, json=_judge_body(qid)
            )
        ).json()
        assert r["verdict"] == "wait"
    assert [e.verdict for e in await _events(db_session, iv)] == ["error", "error", "leak_blocked"]
    got = (await client.get(f"/candidate/interview/{iv}", headers=headers)).json()
    assert got["current_question"]["is_follow_up"] is False  # nothing was written


@pytest.mark.asyncio
async def test_judge_empty_rubric_allows_redirect_but_not_follow_up(
    client, db_session, scripted_judge
):
    headers, iv, qid = await _judged_setup(client, db_session, with_rubric=False, max_calls=5)
    scripted_judge.responses.append('{"verdict": "follow_up", "speech_text": "Anything else?"}')
    r = (
        await client.post(
            f"/candidate/interview/{iv}/judge", headers=headers, json=_judge_body(qid)
        )
    ).json()
    assert r["verdict"] == "wait"
    scripted_judge.responses.append(
        '{"verdict": "redirect", "speech_text": "Let us return to deviations."}'
    )
    r = (
        await client.post(
            f"/candidate/interview/{iv}/judge", headers=headers, json=_judge_body(qid)
        )
    ).json()
    assert r["verdict"] == "redirect" and r["interview"]["current_question"]["is_follow_up"] is True
    assert "(no rubric for this question)" in scripted_judge.prompts[0]


@pytest.mark.asyncio
async def test_judge_is_wait_for_linear_sessions_and_snapshot_holds(
    client, db_session, scripted_judge
):
    from app.services import persona_service as psvc

    headers, iv, qid = await _judged_setup(client, db_session, judged=False)
    scripted_judge.responses.append('{"verdict": "nudge", "speech_text": "x"}')
    r = (
        await client.post(
            f"/candidate/interview/{iv}/judge", headers=headers, json=_judge_body(qid)
        )
    ).json()
    assert r["verdict"] == "wait" and scripted_judge.prompts == []
    # Flipping the persona to judged now does NOT affect the running (linear-snapshot) session.
    persona = await psvc.get_default_persona(db_session)
    await psvc.update_persona(db_session, persona.id, bank_turn_mode="judged")
    r = (
        await client.post(
            f"/candidate/interview/{iv}/judge", headers=headers, json=_judge_body(qid)
        )
    ).json()
    assert r["verdict"] == "wait" and scripted_judge.prompts == []
    # A linear submit ALWAYS advances — even though Q1 owes a follow-up slot (max_follow_ups=1),
    # no template follow-up is asked at "I'm done" (owner rule, v0.39.2.0).
    answered = (
        await client.post(
            f"/candidate/interview/{iv}/answer",
            headers=headers,
            json={"text": "a full answer here", "source": "text"},
        )
    ).json()
    assert answered["current_question"]["is_follow_up"] is False
    assert answered["current_question"]["prompt"] == "How do you close out a site?"


@pytest.mark.asyncio
async def test_linear_submit_always_advances_despite_max_follow_ups(client, db_session):
    """Regression (2026-09-24): a linear bank session whose question allows follow-ups used to get
    the authored template follow-up ("You mentioned … Can you walk me through …") at "I'm done"
    instead of question 2. A submit now advances in every turn mode; ``max_follow_ups`` only budgets
    the judge's pre-submit follow-ups in judged sessions."""
    headers, iv, _qid = await _judged_setup(client, db_session, judged=False, max_follow_ups=2)
    answered = (
        await client.post(
            f"/candidate/interview/{iv}/answer",
            headers=headers,
            json={"text": "I don't know.", "source": "text"},
        )
    ).json()
    assert answered["status"] == "in_progress"
    assert answered["current_question"]["is_follow_up"] is False
    assert answered["current_question"]["prompt"] == "How do you close out a site?"
    # Second submit completes the two-question interview — no follow-up turn was ever written.
    done = (
        await client.post(
            f"/candidate/interview/{iv}/answer",
            headers=headers,
            json={"text": "Reconcile drug accountability and archive.", "source": "text"},
        )
    ).json()
    assert done["status"] == "completed" and done["current_question"] is None
    from sqlalchemy import select

    from app.models.interview import InterviewTurn

    kinds = (
        await db_session.execute(
            select(InterviewTurn.turn_kind).where(InterviewTurn.interview_session_id == iv)
        )
    ).scalars()
    assert "follow_up" not in set(kinds)


@pytest.mark.asyncio
async def test_judge_concurrent_call_is_409(client, db_session, scripted_judge):
    import asyncio

    headers, iv, qid = await _judged_setup(client, db_session, max_calls=5)

    async def slow(_prompt):
        await asyncio.sleep(0.3)
        return '{"verdict": "wait", "speech_text": ""}'

    scripted_judge.responses.extend([slow, '{"verdict": "wait", "speech_text": ""}'])
    first, second = await asyncio.gather(
        client.post(f"/candidate/interview/{iv}/judge", headers=headers, json=_judge_body(qid)),
        client.post(f"/candidate/interview/{iv}/judge", headers=headers, json=_judge_body(qid)),
    )
    assert sorted([first.status_code, second.status_code]) == [200, 409]


@pytest.mark.asyncio
async def test_judge_apply_edges_slot_spent_other_question_and_finished_interview(
    client, db_session, scripted_judge
):
    headers, iv, qid = await _judged_setup(client, db_session, max_calls=3)
    dry = {**_judge_body(qid), "dry_run": True}
    scripted_judge.responses.extend(
        [
            '{"verdict": "follow_up", "speech_text": "First probe?"}',
            '{"verdict": "redirect", "speech_text": "Back to the question."}',
        ]
    )
    a = (await client.post(f"/candidate/interview/{iv}/judge", headers=headers, json=dry)).json()
    b = (await client.post(f"/candidate/interview/{iv}/judge", headers=headers, json=dry)).json()
    # Apply the first → the single follow-up slot is spent; the second (still count 0 on the page)
    # is stale, and even with the right count the slot is gone → wait, nothing written.
    ok = (
        await client.post(
            f"/candidate/interview/{iv}/judge/apply",
            headers=headers,
            json={"event_id": a["event_id"], "question_id": qid, "follow_ups_asked": 0},
        )
    ).json()
    assert ok["verdict"] == "follow_up"
    for asked in (0, 1):
        r = (
            await client.post(
                f"/candidate/interview/{iv}/judge/apply",
                headers=headers,
                json={"event_id": b["event_id"], "question_id": qid, "follow_ups_asked": asked},
            )
        ).json()
        assert r["verdict"] == "wait"
    # Wrong question id → wait; after the interview finishes → 409.
    r = (
        await client.post(
            f"/candidate/interview/{iv}/judge/apply",
            headers=headers,
            json={"event_id": b["event_id"], "question_id": "other", "follow_ups_asked": 1},
        )
    ).json()
    assert r["verdict"] == "wait"
    body = (await client.get(f"/candidate/interview/{iv}", headers=headers)).json()
    while body["status"] == "in_progress":
        body = (
            await client.post(
                f"/candidate/interview/{iv}/answer",
                headers=headers,
                json={"text": "a sufficiently long answer", "source": "text"},
            )
        ).json()
    assert (
        await client.post(
            f"/candidate/interview/{iv}/judge/apply",
            headers=headers,
            json={"event_id": b["event_id"], "question_id": qid, "follow_ups_asked": 1},
        )
    ).status_code == 409
    assert (
        await client.post(f"/candidate/interview/{iv}/judge", headers=headers, json=dry)
    ).status_code == 409
