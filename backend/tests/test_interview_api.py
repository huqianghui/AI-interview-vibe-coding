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
    _headers_a, interview_id = await _start_interview(client)
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
