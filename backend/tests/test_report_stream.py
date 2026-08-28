"""Streaming report endpoint (NDJSON per-question scoring progress) — SPEC F8 UX upgrade.

``POST /report/stream`` replaces the scoring screen's FAKED numerator with real progress: one
``progress`` line before each answer is graded, then a final ``report`` line carrying exactly what
the batch ``/report`` endpoint returns. These tests drive the same start → answer-all → score flow
as ``test_interview_api`` and pin the streaming contract:

- ordered ``progress`` events (done = 0..n-1, stable total) followed by exactly one ``report``;
- the streamed report matches the batch shape (status scored, one row per question);
- pre-stream state errors still 409 (not an in-band error line);
- auth + ownership guards hold (401 / 404).
"""

import json

import pytest


async def _new_candidate_headers(client) -> dict:
    resp = await client.post("/public/candidate/session")
    assert resp.status_code == 200
    return {"X-Anon-Session": resp.json()["token"]}


async def _complete_interview(client, headers) -> tuple[str, int]:
    """Start and answer through the whole interview; returns (interview_id, question_total)."""
    start = await client.post("/candidate/interview/start", headers=headers)
    assert start.status_code == 200
    body = start.json()
    interview_id = body["interview_session_id"]
    total = body["current_question"]["total"]

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
    return interview_id, total


def _parse_ndjson(text: str) -> list[dict]:
    return [json.loads(line) for line in text.splitlines() if line.strip()]


@pytest.mark.asyncio
async def test_report_stream_emits_ordered_progress_then_report(client):
    headers = await _new_candidate_headers(client)
    interview_id, total = await _complete_interview(client, headers)

    resp = await client.post(f"/candidate/interview/{interview_id}/report/stream", headers=headers)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/x-ndjson")

    events = _parse_ndjson(resp.text)
    progress = [e for e in events if e["type"] == "progress"]
    reports = [e for e in events if e["type"] == "report"]

    # One progress line per graded answer, in order, with a stable denominator...
    assert [p["done"] for p in progress] == list(range(len(progress)))
    assert {p["total"] for p in progress} == {len(progress)}
    assert len(progress) >= total  # follow-ups can add answer groups, never remove
    # ...then exactly one report, last.
    assert len(reports) == 1
    assert events[-1]["type"] == "report"

    report = reports[0]["report"]
    assert report["status"] == "scored"
    assert len(report["per_question"]) == total
    assert report["interview_session_id"] == interview_id


@pytest.mark.asyncio
async def test_report_stream_matches_batch_report_shape(client):
    headers = await _new_candidate_headers(client)
    interview_id, _ = await _complete_interview(client, headers)

    streamed = _parse_ndjson(
        (
            await client.post(f"/candidate/interview/{interview_id}/report/stream", headers=headers)
        ).text
    )[-1]["report"]
    # Scoring is idempotent on a scored interview, so the batch endpoint re-returns the report.
    batch = (
        await client.post(f"/candidate/interview/{interview_id}/report", headers=headers)
    ).json()

    assert set(streamed.keys()) == set(batch.keys())
    assert streamed["total_score"] == batch["total_score"]
    assert len(streamed["per_question"]) == len(batch["per_question"])


@pytest.mark.asyncio
async def test_report_stream_409s_before_completion(client):
    headers = await _new_candidate_headers(client)
    start = await client.post("/candidate/interview/start", headers=headers)
    interview_id = start.json()["interview_session_id"]

    resp = await client.post(f"/candidate/interview/{interview_id}/report/stream", headers=headers)
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_report_stream_requires_anon_session(client):
    assert (await client.post("/candidate/interview/whatever/report/stream")).status_code == 401


@pytest.mark.asyncio
async def test_report_stream_enforces_ownership(client):
    headers_a = await _new_candidate_headers(client)
    interview_id, _ = await _complete_interview(client, headers_a)

    headers_b = await _new_candidate_headers(client)
    resp = await client.post(
        f"/candidate/interview/{interview_id}/report/stream", headers=headers_b
    )
    assert resp.status_code == 404
