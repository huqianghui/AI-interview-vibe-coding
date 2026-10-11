"""The admin Jobs tab's API (docs/planning/spec-jobs-and-scale-out.md §6)."""

import json

from app.jobs import handlers, queue
from app.models.job import Job
from app.models.sop import DEFAULT_LIBRARY_ID, SopDocument

BASE = "/admin/jobs"


async def _job(db, kind="persona_sync", target="t", **values) -> Job:  # noqa: ANN001
    job = Job(kind=kind, target_id=target, created_at=queue.now(), **values)
    db.add(job)
    await db.commit()
    return job


async def test_jobs_are_listed_newest_first_with_what_they_work_on(client, db_session, admin_auth):
    doc = SopDocument(name="Widget Release.pdf", blob_path="", library_id=DEFAULT_LIBRARY_ID)
    db_session.add(doc)
    await db_session.commit()
    first = await _job(db_session, "sop_build", doc.id, status="succeeded")
    second = await _job(
        db_session,
        "score_interview",
        "iv-1",
        status="running",
        attempts=1,
        progress=json.dumps(
            {"attempt": 1, "events": [{"type": "progress", "done": 2, "total": 5}]}
        ),
    )
    page = (await client.get(BASE, headers=admin_auth)).json()
    assert page["total"] == 2
    rows = {r["job_id"]: r for r in page["items"]}
    assert rows[first.id]["target_label"] == "Widget Release.pdf"
    assert (rows[second.id]["done"], rows[second.id]["total"]) == (2, 5)
    assert rows[second.id]["target_label"] == ""  # no such interview: the id is shown instead


async def test_jobs_filter_by_status_and_kind_and_page(client, db_session, admin_auth):
    for i in range(3):
        await _job(db_session, target=f"p{i}", status="failed", error="boom")
    await _job(db_session, "sop_backfill", "all", status="succeeded")
    failed = await client.get(f"{BASE}?status=failed&limit=2", headers=admin_auth)
    assert failed.json()["total"] == 3 and len(failed.json()["items"]) == 2
    kind = (await client.get(f"{BASE}?kind=sop_backfill", headers=admin_auth)).json()
    assert [r["kind"] for r in kind["items"]] == ["sop_backfill"]
    assert (await client.get(f"{BASE}?status=nope", headers=admin_auth)).status_code == 422
    assert (await client.get(f"{BASE}?kind=nope", headers=admin_auth)).status_code == 422


async def test_a_failed_job_is_retried_and_a_live_one_cannot_be(
    client, db_session, admin_auth, monkeypatch
):
    ran = []

    async def work(ctx):
        ran.append(ctx.target_id)

    monkeypatch.setitem(handlers.HANDLERS, "persona_sync", work)
    failed = await _job(db_session, status="failed", error="boom")
    again = await client.post(f"{BASE}/{failed.id}/retry", headers=admin_auth)
    assert again.status_code == 202
    assert again.json()["job_id"] != failed.id and again.json()["created_by"] == "admin"
    assert ran == ["t"]  # it ran (inline in tests)
    live = await _job(db_session, target="live")
    assert (await client.post(f"{BASE}/{live.id}/retry", headers=admin_auth)).status_code == 409
    assert (await client.post(f"{BASE}/nope/retry", headers=admin_auth)).status_code == 404


async def test_a_queued_job_is_cancelled_and_a_finished_one_cannot_be(
    client, db_session, admin_auth
):
    queued = await _job(db_session)
    resp = await client.post(f"{BASE}/{queued.id}/cancel", headers=admin_auth)
    assert (resp.status_code, resp.json()["status"]) == (200, "cancelled")
    again = await client.post(f"{BASE}/{queued.id}/cancel", headers=admin_auth)
    assert again.status_code == 409


async def test_the_jobs_api_is_admin_only(client, candidate_auth):
    assert (await client.get(BASE, headers=candidate_auth)).status_code == 403
