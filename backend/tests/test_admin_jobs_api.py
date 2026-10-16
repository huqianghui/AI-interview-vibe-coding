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


async def test_jobs_sort_by_any_column_both_ways(client, db_session, admin_auth):
    """The Jobs table sorts on the server, so a sort covers every page, not just one."""
    from datetime import timedelta

    t0 = queue.now() - timedelta(hours=1)
    quick = await _job(
        db_session,
        "sop_build",
        "q",
        status="succeeded",
        attempts=1,
        started_at=t0,
        finished_at=t0 + timedelta(seconds=5),
    )
    slow = await _job(
        db_session,
        "score_interview",
        "s",
        status="failed",
        attempts=3,
        error="boom",
        started_at=t0,
        finished_at=t0 + timedelta(seconds=90),
    )
    waiting = await _job(db_session, "persona_sync", "w", status="queued", created_by="admin")

    async def order(sort, direction):
        resp = await client.get(f"{BASE}?sort={sort}&order={direction}", headers=admin_auth)
        assert resp.status_code == 200, resp.text
        return [r["job_id"] for r in resp.json()["items"]]

    assert await order("attempts", "desc") == [slow.id, quick.id, waiting.id]
    assert await order("kind", "asc") == [waiting.id, slow.id, quick.id]
    assert await order("status", "asc") == [slow.id, waiting.id, quick.id]
    # "admin" before "system"; ties fall back to newest first.
    assert await order("created_by", "asc") == [waiting.id, slow.id, quick.id]
    assert (await order("error", "desc"))[0] == slow.id
    assert (await order("error", "asc"))[0] == slow.id  # no error ("") sorts last both ways
    # Duration: never started sorts last whichever way.
    assert await order("duration", "desc") == [slow.id, quick.id, waiting.id]
    assert await order("duration", "asc") == [quick.id, slow.id, waiting.id]
    assert (await client.get(f"{BASE}?sort=nope", headers=admin_auth)).status_code == 422
    assert (await client.get(f"{BASE}?order=up", headers=admin_auth)).status_code == 422


async def test_a_running_job_sorts_by_how_long_it_has_run_so_far(client, db_session, admin_auth):
    from datetime import timedelta

    now = queue.now()
    done = await _job(
        db_session,
        status="succeeded",
        started_at=now - timedelta(hours=2),
        finished_at=now - timedelta(hours=2) + timedelta(seconds=30),
    )
    running = await _job(
        db_session, target="r", status="running", started_at=now - timedelta(minutes=10)
    )
    resp = await client.get(f"{BASE}?sort=duration&order=desc", headers=admin_auth)
    assert [r["job_id"] for r in resp.json()["items"]] == [running.id, done.id]  # 10 min > 30 s


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


async def test_retrying_a_citation_run_starts_a_new_run(
    client, db_session, admin_auth, monkeypatch
):
    from types import SimpleNamespace

    from app.services import sop_citation_service

    started = []

    async def start(db, _factory, bank_id, *, fresh=False, created_by="system"):  # noqa: ANN001
        started.append((bank_id, fresh, created_by))
        await queue.enqueue(db, "citation_run", bank_id, {"run_id": "run-2", "fresh": fresh})
        return SimpleNamespace(id="run-2")

    monkeypatch.setattr(sop_citation_service, "start_relocation", start)
    old = await _job(
        db_session, "citation_run", "bank-1", status="failed", payload='{"run_id": "run-1"}'
    )
    again = await client.post(f"{BASE}/{old.id}/retry", headers=admin_auth)
    assert again.status_code == 202
    # A new run, not the old job's payload again (its run row has ended: replaying it does nothing).
    assert started == [("bank-1", False, "admin")]
    assert again.json()["job_id"] != old.id


async def test_cancelling_a_job_that_ended_meanwhile_is_a_409(
    client, db_session, admin_auth, monkeypatch
):
    job = await _job(db_session)

    async def ended_meanwhile(db, j):  # noqa: ANN001
        j.status = "succeeded"
        return j

    monkeypatch.setattr(queue, "request_cancel", ended_meanwhile)
    assert (await client.post(f"{BASE}/{job.id}/cancel", headers=admin_auth)).status_code == 409


async def test_a_running_job_asked_to_stop_says_so(client, db_session, admin_auth):
    job = await _job(db_session, status="running", lease_owner="r", attempts=1)
    resp = await client.post(f"{BASE}/{job.id}/cancel", headers=admin_auth)
    assert (resp.status_code, resp.json()["status"], resp.json()["cancel_requested"]) == (
        200,
        "running",
        True,
    )
