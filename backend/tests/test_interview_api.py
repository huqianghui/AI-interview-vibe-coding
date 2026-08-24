"""End-to-end thin-slice API tests (SPEC F6/F9 spine).

Proves ask → answer → placeholder report over HTTP, plus the auth + ownership guards
(anonymous session required; one candidate cannot touch another's interview).
"""

import pytest


async def _new_candidate_headers(client) -> dict:
    resp = await client.post("/public/candidate/session")
    assert resp.status_code == 200
    return {"X-Anon-Session": resp.json()["token"]}


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
async def test_follow_up_visibly_cites_prior_answer(client):
    # F7 AC #1/#2: the follow-up shown to the candidate cites what they actually said. Uses the
    # fallback question set (q2 carries a follow-up).
    headers = await _new_candidate_headers(client)
    start = (await client.post("/candidate/interview/start", headers=headers)).json()
    interview_id = start["interview_session_id"]
    # Answer q1 (no follow-up) to advance to q2.
    await client.post(
        f"/candidate/interview/{interview_id}/answer",
        headers=headers,
        json={"text": "My relevant experience is in SRE on-call.", "source": "text"},
    )
    # Answer q2's main question with a distinctive phrase; the follow-up must quote it.
    distinctive = "I double-check the runbook before every deploy."
    body = (
        await client.post(
            f"/candidate/interview/{interview_id}/answer",
            headers=headers,
            json={"text": distinctive, "source": "text"},
        )
    ).json()
    assert body["status"] == "in_progress"
    assert body["current_question"] is not None
    # The candidate now sees a follow-up that cites their own words.
    assert distinctive in body["current_question"]["prompt"]


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
