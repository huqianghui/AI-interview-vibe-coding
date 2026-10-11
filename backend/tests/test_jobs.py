"""The jobs queue and runner (docs/planning/spec-jobs-and-scale-out.md), across real connections.

The shared ``db_session`` fixture is ONE in-memory SQLite connection, where a concurrent session's
rollback undoes another's uncommitted claim, so it cannot show what two runners do at once. These
tests use a file database with a connection per session, as PostgreSQL gives every process.
"""

import asyncio
import json
from datetime import timedelta

import pytest
import pytest_asyncio
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

import app.models  # noqa: F401 — registers every table
from app.db import Base, make_engine
from app.jobs import handlers, queue
from app.jobs.handlers import JobFailed
from app.jobs.runner import Runner
from app.models.job import Job

KIND = "persona_sync"  # any kind: each test puts its own handler behind it


@pytest_asyncio.fixture
async def factory(tmp_path):
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'jobs.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    await engine.dispose()


@pytest.fixture
def fast(monkeypatch):
    """A heartbeat every 50 ms instead of 15 s, so cancel and lease loss show up at once."""
    monkeypatch.setattr(queue, "HEARTBEAT_SECONDS", 0.05)
    monkeypatch.setattr(queue, "POLL_SECONDS", 0.05)


def handler(monkeypatch, fn, kind: str = KIND) -> None:
    monkeypatch.setitem(handlers.HANDLERS, kind, fn)


async def get(factory, job_id: str) -> Job:
    async with factory() as db:
        return await db.get(Job, job_id)


async def add(factory, kind: str = KIND, target: str = "t", **payload) -> Job:
    async with factory() as db:
        job, new = await queue.enqueue(db, kind, target, payload)
    assert new
    return job


async def test_the_same_work_queued_twice_is_one_job(factory):
    async with factory() as db:
        first, new = await queue.enqueue(db, KIND, "t")
        again, again_new = await queue.enqueue(db, KIND, "t")
        other, _ = await queue.enqueue(db, KIND, "u")
    assert new and not again_new and again.id == first.id and other.id != first.id
    with pytest.raises(queue.UnknownJobKind):
        async with factory() as db:
            await queue.enqueue(db, "nope", "t")


async def test_two_runners_racing_for_one_job_claim_it_once(factory):
    job = await add(factory)

    async def claim(owner):
        async with factory() as db:
            return await queue.claim(db, owner, job_id=job.id)

    results = await asyncio.gather(*(claim(f"runner-{i}") for i in range(5)))
    assert [r is not None for r in results].count(True) == 1
    claimed = await get(factory, job.id)
    assert (claimed.status, claimed.attempts) == ("running", 1)
    # The losing side of the race, made deterministic: a runner that read the job while it was
    # still queued, and writes after the winner did.
    async with factory() as db:
        assert not await queue.take(db, job.id, "late-runner")
    assert (await get(factory, job.id)).lease_owner == claimed.lease_owner


async def test_a_job_runs_and_records_its_progress_and_result(factory, monkeypatch):
    async def work(ctx):
        await ctx.emit({"type": "progress", "done": 1})
        return {"answer": 42, "payload": ctx.payload}

    handler(monkeypatch, work)
    job = await add(factory, x=1)
    await Runner(factory).run_now(job.id)
    done = await get(factory, job.id)
    assert done.status == "succeeded" and done.finished_at is not None
    assert queue.events_of(done) == [{"type": "progress", "done": 1}]
    assert queue.result_of(done) == {"answer": 42, "payload": {"x": 1}}
    assert done.lease_owner == "" and done.lease_until is None


async def test_an_error_fails_the_job_at_once_without_a_retry(factory, monkeypatch):
    # Retrying here would repeat a deterministic failure (a bad model name) for minutes; the work
    # retries what is worth retrying itself (scoring, per question). Only a dead runner's job is
    # run again (test_a_job_whose_runner_died_is_requeued_then_failed).
    calls = []

    async def broken(ctx):
        calls.append(ctx.attempt)
        raise RuntimeError("model not found")

    handler(monkeypatch, broken)
    job = await add(factory)
    await Runner(factory).run_now(job.id)
    failed = await get(factory, job.id)
    assert calls == [1]
    assert (failed.status, failed.attempts) == ("failed", 1)
    assert failed.error == "RuntimeError: model not found"
    assert queue.result_of(failed) is None  # it broke: a waiter answers 500


async def test_a_heartbeat_that_cannot_reach_the_database_is_retried_then_gives_up(
    factory, monkeypatch, fast
):
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def forever(_ctx):
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    calls = []

    async def down(*_a):
        calls.append(1)
        raise ConnectionError("database is restarting")

    handler(monkeypatch, forever)
    job = await add(factory)
    monkeypatch.setattr(queue, "heartbeat", down)
    monkeypatch.setattr(queue, "LEASE", timedelta(seconds=0.2))  # four heartbeats per lease
    await asyncio.wait_for(Runner(factory).run_now(job.id), 2)
    # Misses are survived while the lease still holds; the miss after which it may have lapsed
    # (another runner may hold the job by then) stops the work: never two copies at once.
    assert len(calls) == 3 and cancelled.is_set()


async def test_a_job_that_refuses_its_work_fails_at_once(factory, monkeypatch):
    async def refuse(_ctx):
        raise JobFailed("Interview session no longer exists")

    handler(monkeypatch, refuse)
    job = await add(factory)
    await Runner(factory).run_now(job.id)
    failed = await get(factory, job.id)
    assert (failed.status, failed.attempts) == ("failed", 1)
    assert failed.error == "Interview session no longer exists"
    assert queue.result_of(failed) == {"rejected": True}  # a waiter answers 409


async def test_a_job_whose_runner_died_is_requeued_then_failed(factory):
    job = await add(factory)
    async with factory() as db:
        await db.execute(update(Job).where(Job.id == job.id).values(max_attempts=2))
        await db.commit()
    for attempt in (1, 2):
        async with factory() as db:
            assert (await queue.claim(db, "dead-runner")) is not None
            await db.execute(  # the runner died: nobody renews the lease
                update(Job)
                .where(Job.id == job.id)
                .values(lease_until=queue.now() - timedelta(seconds=1))
            )
            await db.commit()
            assert await queue.reclaim_expired(db) == 1
        row = await get(factory, job.id)
        expected = "queued" if attempt == 1 else "failed"
        assert (row.status, row.attempts) == (expected, attempt)
    assert "lease expired" in row.error


async def test_a_queued_job_is_cancelled_and_a_running_one_is_stopped(factory, monkeypatch, fast):
    queued = await add(factory, target="queued")
    async with factory() as db:
        assert (await queue.request_cancel(db, queued)).status == "cancelled"

    started = asyncio.Event()

    async def forever(_ctx):
        started.set()
        await asyncio.Event().wait()

    handler(monkeypatch, forever)
    job = await add(factory, target="running")
    run = asyncio.create_task(Runner(factory).run_now(job.id))
    await started.wait()
    async with factory() as db:
        await queue.request_cancel(db, await db.get(Job, job.id))
    await asyncio.wait_for(run, 2)
    stopped = await get(factory, job.id)
    assert (stopped.status, stopped.error) == ("cancelled", "cancelled")


async def test_a_runner_that_lost_its_lease_stops_and_writes_nothing(factory, monkeypatch, fast):
    started = asyncio.Event()

    async def forever(_ctx):
        started.set()
        await asyncio.Event().wait()

    handler(monkeypatch, forever)
    job = await add(factory)
    run = asyncio.create_task(Runner(factory, owner="slow").run_now(job.id))
    await started.wait()
    async with factory() as db:  # another runner reclaimed and took it meanwhile
        await db.execute(update(Job).where(Job.id == job.id).values(lease_owner="other"))
        await db.commit()
    await asyncio.wait_for(run, 2)
    row = await get(factory, job.id)
    assert (row.status, row.lease_owner) == ("running", "other")


async def test_stopping_a_runner_hands_its_jobs_back_without_spending_an_attempt(
    factory, monkeypatch, fast
):
    started = asyncio.Event()

    async def forever(_ctx):
        started.set()
        await asyncio.Event().wait()

    handler(monkeypatch, forever)
    job = await add(factory)
    stop = asyncio.Event()
    loop = asyncio.create_task(Runner(factory).run_forever(stop))
    await asyncio.wait_for(started.wait(), 2)  # the poller claimed it on its own
    stop.set()
    await asyncio.wait_for(loop, 2)
    row = await get(factory, job.id)
    assert (row.status, row.attempts, row.lease_owner) == ("queued", 0, "")


async def test_serial_kinds_run_one_at_a_time_and_others_beside_them(factory, monkeypatch, fast):
    running: list[str] = []
    overlap: list[tuple[str, ...]] = []

    async def work(ctx):
        running.append(ctx.kind)
        overlap.append(tuple(running))
        await asyncio.sleep(0.1)
        running.remove(ctx.kind)

    for kind in ("sop_build", "persona_sync"):
        handler(monkeypatch, work, kind)
    for target in ("a", "b"):
        await add(factory, "sop_build", target)
    await add(factory, "persona_sync", "p")
    stop = asyncio.Event()
    loop = asyncio.create_task(Runner(factory, concurrency=4).run_forever(stop))
    for _ in range(100):
        async with factory() as db:
            left = (await db.execute(select(Job).where(Job.status != "succeeded"))).all()
        if not left:
            break
        await asyncio.sleep(0.05)
    stop.set()
    await loop
    assert not left
    assert all(seen.count("sop_build") <= 1 for seen in overlap)  # never two conversions at once
    assert any(len(seen) == 2 for seen in overlap)  # the other kind ran beside one


async def test_old_finished_jobs_are_purged_and_failed_ones_kept(factory):
    old = queue.now() - queue.RETENTION - timedelta(days=1)
    async with factory() as db:
        for status in ("succeeded", "cancelled", "failed"):
            db.add(Job(kind=KIND, target_id=status, status=status, finished_at=old))
        db.add(Job(kind=KIND, target_id="new", status="succeeded", finished_at=queue.now()))
        await db.commit()
        assert await queue.purge(db) == 2
        left = sorted((await db.execute(select(Job.target_id))).scalars())
    assert left == ["failed", "new"]


async def test_a_retry_queues_the_same_work_again(factory):
    job = await add(factory, sop_coverage_check=True)
    async with factory() as db:
        with pytest.raises(queue.JobNotRetryable):
            await queue.retry(db, job, created_by="admin")
        await queue.request_cancel(db, job)
        again, new = await queue.retry(db, await db.get(Job, job.id), created_by="admin")
    assert new and again.id != job.id
    assert (again.kind, again.target_id, json.loads(again.payload)) == (
        KIND,
        "t",
        {"sop_coverage_check": True},
    )


async def test_boot_work_is_queued_once_however_many_processes_boot(factory):
    async with factory() as db:
        first, new = await queue.enqueue_once_per_boot(db, KIND, "t")
        await queue.request_cancel(db, first)  # finished: no longer live, still recent
        second, second_new = await queue.enqueue_once_per_boot(db, KIND, "t")
    assert new and not second_new and second is None


async def test_a_waiter_in_the_same_process_wakes_at_once(factory, monkeypatch):
    monkeypatch.setattr(queue, "POLL_SECONDS", 5.0)
    job = await add(factory)
    waiter = asyncio.create_task(queue.wait_for_change(job.id))
    await asyncio.sleep(0)
    queue.notify(job.id)
    await asyncio.wait_for(waiter, 1)


async def test_the_judge_lease_is_one_at_a_time_and_expires(factory):
    from app.interview import judge_flow
    from app.models.anonymous_session import AnonymousCandidateSession
    from app.models.interview import InterviewSession

    async with factory() as db:
        t = queue.now()
        candidate = AnonymousCandidateSession(expires_at=t + timedelta(hours=1), last_activity_at=t)
        db.add(candidate)
        await db.flush()
        session = InterviewSession(candidate_session_id=candidate.id)
        db.add(session)
        await db.commit()
        assert await judge_flow._take_judge_lease(db, session.id)
    async with factory() as other:  # another process, while the first call is in flight
        assert not await judge_flow._take_judge_lease(other, session.id)
        await other.execute(  # the first process died mid-call: its lease runs out
            update(InterviewSession)
            .where(InterviewSession.id == session.id)
            .values(judge_lease_until=queue.now() - timedelta(seconds=1))
        )
        await other.commit()
        assert await judge_flow._take_judge_lease(other, session.id)
        await judge_flow._drop_judge_lease(other, session.id)
        assert await judge_flow._take_judge_lease(other, session.id)


async def test_a_config_save_in_another_process_is_applied_here_once(factory, monkeypatch):
    from app.models.service_config import ServiceConfig
    from app.services import config_overlay
    from app.services.config_service import MASTER_SERVICE_NAME

    applied = []

    async def apply(db):
        master = await config_overlay.config_service.get_master_config(db)
        config_overlay._applied = config_overlay._stamp(master)
        applied.append(master.endpoint)
        return True

    monkeypatch.setattr(config_overlay, "apply_master_config_to_settings", apply)
    monkeypatch.setattr(config_overlay, "_applied", None)
    async with factory() as db:
        db.add(
            ServiceConfig(service_name=MASTER_SERVICE_NAME, endpoint="https://a", is_active=True)
        )
        await db.commit()
        assert await config_overlay.ensure_current(db)
        assert not await config_overlay.ensure_current(db)  # nothing changed: no re-apply
        row = await config_overlay.config_service.get_master_config(db)
        row.endpoint = "https://b"  # another worker saved
        await db.commit()
        assert await config_overlay.ensure_current(db)
    assert applied == ["https://a", "https://b"]


async def test_the_job_process_waits_for_the_migrations(factory, monkeypatch):
    from sqlalchemy import text

    import app.db

    async with factory() as db:
        await db.execute(text("CREATE TABLE alembic_version (version_num VARCHAR(32))"))
        # The revision before the jobs migration: a real, known one (an unknown one reads as AHEAD
        # of this image, and the wait would rightly return at once).
        await db.execute(text("INSERT INTO alembic_version VALUES ('c1d2e3f4a5b6')"))
        await db.commit()
    monkeypatch.setattr(app.db, "engine", factory.kw["bind"])
    waiting = asyncio.create_task(app.db.wait_for_schema(poll_seconds=0.02))
    await asyncio.sleep(0.1)
    assert not waiting.done()  # the web container has not migrated yet
    (head,) = app.db._migration_heads()
    async with factory() as db:
        await db.execute(text("UPDATE alembic_version SET version_num = :v"), {"v": head})
        await db.commit()
    await asyncio.wait_for(waiting, 1)


async def test_a_job_waiting_for_a_slot_is_not_claimed_so_its_lease_cannot_lapse(
    factory, monkeypatch, fast
):
    started = asyncio.Event()
    release = asyncio.Event()

    async def hold(ctx):
        if ctx.target_id == "first":
            started.set()
            await release.wait()

    handler(monkeypatch, hold)
    runner = Runner(factory, concurrency=1)
    first = await add(factory, target="first")
    second = await add(factory, target="second")
    running = asyncio.create_task(runner.run_now(first.id))
    await started.wait()
    waiting = asyncio.create_task(runner.run_now(second.id))
    await asyncio.sleep(0.1)
    assert (await get(factory, second.id)).status == "queued"  # waiting for the slot, unclaimed
    release.set()
    await asyncio.wait_for(asyncio.gather(running, waiting), 2)
    assert (await get(factory, second.id)).status == "succeeded"


async def test_the_job_process_does_not_wait_on_a_database_ahead_of_its_image(factory, monkeypatch):
    from sqlalchemy import text

    import app.db

    async with factory() as db:
        await db.execute(text("CREATE TABLE alembic_version (version_num VARCHAR(32))"))
        await db.execute(text("INSERT INTO alembic_version VALUES ('a_newer_revision')"))
        await db.commit()
    monkeypatch.setattr(app.db, "engine", factory.kw["bind"])
    await asyncio.wait_for(app.db.wait_for_schema(poll_seconds=0.02), 1)


async def test_asking_again_for_queued_work_adds_to_what_it_will_do(factory):
    job = await add(factory)
    async with factory() as db:
        await queue.merge_payload(db, job, {"force": True})
    assert queue.payload_of(await get(factory, job.id)) == {"force": True}
