"""The job runner: claims queued jobs and runs them (docs/planning/spec-jobs-and-scale-out.md §2).

In production it is its own process, ``python -m app.jobs.runner`` (the backend app's ``jobs``
container), so scoring and SOP work never share an event loop with a live voice socket; the web
workers run with ``JOB_RUNNER_MODE=off`` and only enqueue. In dev and tests
(``JOB_RUNNER_MODE=embedded``) the same runner lives inside the web process: :func:`kick` runs a job
started here at once, and the lifespan's poller picks up the rest.

Every job runs as a task beside a heartbeat that renews its lease every 15 s. A lost lease (another
runner reclaimed it) or a cancel request stops the task. A handler error fails the job (its own
retries, such as scoring's per question, have already run); :class:`app.jobs.handlers.JobFailed`
marks it a refusal (a waiter answers 409, not 500). Only a runner that died is retried: its lease
expires and the job is requeued, up to ``max_attempts``. Stopping a runner hands its jobs back to
the queue without spending an attempt.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import signal
from datetime import datetime

from sqlalchemy import update
from sqlalchemy.ext.asyncio import async_sessionmaker

from app import telemetry
from app.config import get_settings
from app.jobs import queue
from app.jobs.handlers import HANDLERS, JobContext, JobFailed
from app.models.job import Job
from app.services import config_overlay

logger = logging.getLogger(__name__)

# One at a time per runner process: SOP conversion drives LibreOffice, which cannot run two
# sessions on one profile, and drafting summaries one by one keeps the model's rate in check.
SERIAL_KINDS = ("sop_build", "sop_summary")
RECLAIM_EVERY_SECONDS = 15.0
PURGE_EVERY_SECONDS = 24 * 3600.0

_RUNNERS: dict[int, Runner] = {}


class Runner:
    def __init__(
        self,
        session_factory: async_sessionmaker,
        *,
        concurrency: int | None = None,
        owner: str | None = None,
    ) -> None:
        self._sf = session_factory
        self._owner = owner or queue.owner_id()
        self._slots = asyncio.Semaphore(concurrency or get_settings().job_runner_concurrency)
        self._serial = {kind: asyncio.Lock() for kind in SERIAL_KINDS}
        self._tasks: set[asyncio.Task] = set()
        self._wake = asyncio.Event()

    @property
    def owner(self) -> str:
        return self._owner

    def busy(self) -> bool:
        return bool(self._tasks)

    def start(self, job_id: str) -> None:
        """Try to run this job now, in this process (it may already be another runner's)."""
        self._spawn(self.run_now(job_id))

    def _spawn(self, coro) -> None:  # noqa: ANN001 — a coroutine
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        task.add_done_callback(lambda _t: self._wake.set())

    async def wait_idle(self) -> None:
        """Until no job of this runner is running (a job that queues another waits for it too)."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    async def run_forever(self, stop: asyncio.Event) -> None:
        """Until ``stop`` is set (or this task is cancelled): then hand back its running jobs."""
        try:
            await self._loop(stop)
        finally:
            await self.shutdown()

    async def _loop(self, stop: asyncio.Event) -> None:
        last_reclaim = last_purge = 0.0
        loop = asyncio.get_running_loop()
        while not stop.is_set():
            t = loop.time()
            try:
                if t - last_reclaim >= RECLAIM_EVERY_SECONDS:
                    last_reclaim = t
                    async with self._sf() as db:
                        if await queue.reclaim_expired(db):
                            logger.info("Requeued jobs whose runner stopped")
                if t - last_purge >= PURGE_EVERY_SECONDS:
                    last_purge = t
                    async with self._sf() as db:
                        await queue.purge(db)
                while not self._slots.locked() and await self._claim_and_spawn():
                    pass
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 — e.g. the database is down; try again next round
                logger.exception("Job runner round failed")
            self._wake.clear()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._wake.wait(), queue.POLL_SECONDS)

    async def shutdown(self) -> None:
        """Cancel this runner's jobs and hand them back to the queue."""
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*list(self._tasks), return_exceptions=True)

    # A job's lease runs from its claim, and its heartbeat starts only when it runs: so a slot,
    # and for a serial kind its lock, are taken BEFORE the claim, never waited for after it.

    async def _claim_and_spawn(self) -> bool:
        await self._slots.acquire()  # free: the loop checked
        busy = [kind for kind, lock in self._serial.items() if lock.locked()]
        try:
            async with self._sf() as db:
                job = await queue.claim(db, self._owner, exclude_kinds=busy)
        except BaseException:
            self._slots.release()
            raise
        if job is None:
            self._slots.release()
            return False
        lock = self._serial.get(job.kind)
        if lock is not None:
            if lock.locked():  # a run_now took it during the claim: hand this one back
                await self._release(job.id)
                self._slots.release()
                return False
            await lock.acquire()  # unlocked: returns without yielding, so no one can cut in
        self._spawn(self._run_holding(job, lock))
        return True

    async def run_now(self, job_id: str) -> None:
        """Claim this job and run it here, unless it is another runner's already, or a serial kind
        this runner is busy with (then the poller claims it when that one ends)."""
        async with self._sf() as db:
            row = await db.get(Job, job_id)
        if row is None:
            return
        lock = self._serial.get(row.kind)
        if lock is not None and lock.locked():
            return
        await self._slots.acquire()
        if lock is not None:
            await lock.acquire()
        try:
            async with self._sf() as db:
                job = await queue.claim(db, self._owner, job_id=job_id)
        except BaseException:
            self._release_holding(lock)
            raise
        if job is None:
            self._release_holding(lock)
            return
        await self._run_holding(job, lock)

    def _release_holding(self, lock: asyncio.Lock | None) -> None:
        if lock is not None:
            lock.release()
        self._slots.release()

    async def _run_holding(self, job: Job, lock: asyncio.Lock | None) -> None:
        try:
            await self._run(job)
        finally:
            self._release_holding(lock)

    async def _run(self, job: Job) -> None:
        try:
            # A config save in a web process (an endpoint, a key, a model) must reach the job
            # that scores or drafts with it.
            with contextlib.suppress(Exception):
                async with self._sf() as db:
                    await config_overlay.ensure_current(db)
        except asyncio.CancelledError:
            await self._release(job.id)
            raise
        ctx = JobContext(
            job_id=job.id,
            kind=job.kind,
            target_id=job.target_id,
            payload=queue.payload_of(job),
            attempt=job.attempts,
            owner=self._owner,
            session_factory=self._sf,
            runner=self,
        )
        with telemetry.span(
            f"job.{job.kind}", job_id=job.id, target_id=job.target_id, attempt=job.attempts
        ) as span:
            work = asyncio.create_task(HANDLERS[job.kind](ctx))
            try:
                outcome = await self._supervise(job.id, work)
            except asyncio.CancelledError:
                work.cancel()
                with contextlib.suppress(BaseException):
                    await work
                await self._release(job.id)
                raise
            span.set_attribute("job.outcome", outcome)
            logger.info(
                "Job %s %s (%s, attempt %d) %s",
                *(job.kind, job.target_id, job.id, job.attempts, outcome),
            )

    async def _supervise(self, job_id: str, work: asyncio.Task) -> str:
        # A heartbeat that cannot reach the database is retried; once the lease would have run
        # out, another runner may hold the job, so this one stops rather than run it twice.
        missed = 0
        allowed = int(queue.LEASE.total_seconds() // queue.HEARTBEAT_SECONDS) - 1
        while True:
            done, _ = await asyncio.wait({work}, timeout=queue.HEARTBEAT_SECONDS)
            if done:
                break
            try:
                async with self._sf() as db:
                    still_ours = await queue.heartbeat(db, job_id, self._owner)
                missed = 0
            except Exception:  # noqa: BLE001 — e.g. the database is restarting
                missed += 1
                logger.warning("Heartbeat of job %s failed (%d)", job_id, missed, exc_info=True)
                still_ours = missed < allowed
            if not still_ours:
                work.cancel()
                with contextlib.suppress(BaseException):
                    await work
                async with self._sf() as db:
                    # A cancel request: this runner still holds it and records the end. A lost
                    # lease: the row is another runner's now and this write changes nothing.
                    await queue.finish(db, job_id, self._owner, "cancelled", error="cancelled")
                return "cancelled"
        async with self._sf() as db:
            try:
                result = work.result()
            except JobFailed as exc:
                await _final_failure(db, job_id, self._owner, str(exc))
                return "failed"
            except Exception as exc:  # noqa: BLE001 — recorded on the job
                logger.exception("Job %s failed", job_id)
                await queue.finish(
                    db, job_id, self._owner, "failed", error=f"{type(exc).__name__}: {exc}"
                )
                return "failed"
            await queue.finish(db, job_id, self._owner, "succeeded", result=result)
            return "succeeded"

    async def _release(self, job_id: str) -> None:
        """Back to queued without spending an attempt: this runner is stopping, not the job."""
        with contextlib.suppress(Exception):
            async with self._sf() as db:
                await db.execute(
                    update(Job)
                    .where(
                        Job.id == job_id, Job.lease_owner == self._owner, Job.status == "running"
                    )
                    .values(
                        status="queued",
                        lease_owner="",
                        lease_until=None,
                        attempts=Job.attempts - 1,
                        updated_at=queue.now(),
                    )
                    .execution_options(synchronize_session=False)
                )
                await db.commit()


async def _final_failure(db, job_id: str, owner: str, error: str) -> None:  # noqa: ANN001
    t: datetime = queue.now()
    await db.execute(
        update(Job)
        .where(Job.id == job_id, Job.lease_owner == owner, Job.status == "running")
        .values(
            status="failed",
            error=error[:4000],
            # The job refused the work rather than broke: a waiter answers 409, not 500.
            result=json.dumps({"rejected": True}),
            finished_at=t,
            lease_owner="",
            lease_until=None,
            updated_at=t,
        )
        .execution_options(synchronize_session=False)
    )
    await db.commit()
    queue.notify(job_id)


def runner_for(session_factory: async_sessionmaker) -> Runner:
    """This process's runner on ``session_factory`` (one per factory: tests bring their own)."""
    runner = _RUNNERS.get(id(session_factory))
    if runner is None:
        runner = _RUNNERS[id(session_factory)] = Runner(session_factory)
    return runner


async def kick(session_factory: async_sessionmaker, job: Job) -> None:
    """Start a job just queued, when this process runs jobs. ``embedded``: beside the request, now.
    ``inline`` (pytest): to completion before returning, because the tests' in-memory database is
    ONE shared connection, on which a concurrent session's rollback undoes another's uncommitted
    claim. ``off``: nothing here; the job process claims it within a second."""
    mode = get_settings().job_runner_mode
    if mode == "embedded":
        runner_for(session_factory).start(job.id)
    elif mode == "inline":
        # Its retries too: no poller runs here to pick up a job a failed attempt put back.
        runner = runner_for(session_factory)
        for _ in range(job.max_attempts):
            await runner.run_now(job.id)
            async with session_factory() as db:
                again = await db.get(Job, job.id, populate_existing=True)
            if again is None or again.status != "queued":
                break


async def wait_idle() -> None:
    """Every embedded runner idle (tests: wait for the jobs a request started)."""
    while any(r.busy() for r in _RUNNERS.values()):
        for runner in list(_RUNNERS.values()):
            await runner.wait_idle()


async def _main() -> None:
    from app.db import async_session_factory, wait_for_schema

    telemetry.configure()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    # The Azure SDK logs every HTTP request and response at INFO, and App Insights' live metrics
    # talks to Azure every second: at INFO the job container's log is nothing else.
    logging.getLogger("azure").setLevel(logging.WARNING)
    await wait_for_schema()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    runner = runner_for(async_session_factory)
    logger.info("Job runner %s started", runner.owner)
    await runner.run_forever(stop)
    logger.info("Job runner %s stopped", runner.owner)


if __name__ == "__main__":
    asyncio.run(_main())
