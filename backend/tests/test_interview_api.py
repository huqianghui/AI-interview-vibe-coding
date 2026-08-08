"""End-to-end thin-slice API tests (SPEC F6/F9 spine).

Proves ask → answer → placeholder report over HTTP, plus the auth + ownership guards
(anonymous session required; one candidate cannot touch another's interview).
"""

import pytest


async def _new_candidate_headers(client) -> dict:
    resp = await client.post("/public/candidate/session")
    assert resp.status_code == 200
    return {"X-Anon-Session": resp.json()["token"]}


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
