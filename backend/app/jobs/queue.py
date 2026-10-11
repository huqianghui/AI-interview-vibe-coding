"""The jobs table as a queue (docs/planning/spec-jobs-and-scale-out.md §1).

Every operation is one guarded UPDATE or INSERT, so it holds across processes and replicas on
PostgreSQL and SQLite alike (no ``SKIP LOCKED``, no advisory lock):

- **enqueue**: an INSERT; the partial unique index on live ``(kind, target_id)`` turns a second
  enqueue of the same work into the job already there.
- **claim**: pick the oldest queued id, then ``UPDATE ... WHERE id = ? AND status = 'queued'``;
  whoever's UPDATE changes the row owns it.
- **heartbeat**: renew ``lease_until`` while the owner still holds it; a lost lease or a cancel
  request is reported back so the runner stops.
- **reclaim**: a running job whose lease expired (its process died) goes back to queued, or to
  failed once it has used its attempts. This is the restart recovery: no boot hook.

Waiting for a job (the candidate's report stream) polls its row; a job running in this same
process also wakes its waiters at once (:func:`wait_for_change`), so dev and tests do not sleep.
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.job import JOB_KINDS, LIVE_STATUSES, Job

LEASE = timedelta(seconds=60)
HEARTBEAT_SECONDS = 15.0
# Waiters poll at least this often; a job in this process wakes them sooner.
POLL_SECONDS = 1.0
# Succeeded and cancelled jobs are kept this long for the Jobs tab, then deleted; failed ones stay.
RETENTION = timedelta(days=30)

_WAKE: dict[str, asyncio.Event] = {}


class UnknownJobKind(ValueError):
    pass


class JobNotRetryable(ValueError):
    pass


def now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def owner_id() -> str:
    return f"{socket.gethostname()}:{os.getpid()}"[:128]


def payload_of(job: Job) -> dict:
    return json.loads(job.payload or "{}")


def events_of(job: Job) -> list[dict]:
    return list(json.loads(job.progress or "{}").get("events", []))


def attempt_of_events(job: Job) -> int:
    return int(json.loads(job.progress or "{}").get("attempt", 0))


def result_of(job: Job) -> object:
    return json.loads(job.result) if job.result else None


def notify(job_id: str) -> None:
    event = _WAKE.get(job_id)
    if event is not None:
        event.set()


async def wait_for_change(job_id: str) -> None:
    """Return when a job in this process changes, or after a poll interval (another process's)."""
    event = _WAKE.setdefault(job_id, asyncio.Event())
    try:
        await asyncio.wait_for(event.wait(), POLL_SECONDS)
    except TimeoutError:
        pass
    finally:
        event.clear()


async def live_job(db: AsyncSession, kind: str, target_id: str) -> Job | None:
    return (
        await db.execute(
            select(Job).where(
                Job.kind == kind, Job.target_id == target_id, Job.status.in_(LIVE_STATUSES)
            )
        )
    ).scalar_one_or_none()


async def live_targets(db: AsyncSession, kind: str) -> set[str]:
    """The targets of every queued or running job of ``kind`` (e.g. the documents converting)."""
    rows = await db.execute(
        select(Job.target_id).where(Job.kind == kind, Job.status.in_(LIVE_STATUSES))
    )
    return set(rows.scalars().all())


async def enqueue(
    db: AsyncSession,
    kind: str,
    target_id: str,
    payload: dict | None = None,
    *,
    created_by: str = "system",
    max_attempts: int = 3,
) -> tuple[Job, bool]:
    """Queue ``kind`` for ``target_id`` unless a live job for it exists. Commits. Returns the job
    and whether it is new. The caller starts it (:func:`app.jobs.runner.kick`) when it is new."""
    if kind not in JOB_KINDS:
        raise UnknownJobKind(kind)
    existing = await live_job(db, kind, target_id)
    if existing is not None:
        return existing, False
    job = Job(
        kind=kind,
        target_id=target_id,
        payload=json.dumps(payload or {}, ensure_ascii=False),
        created_by=created_by[:64],
        max_attempts=max_attempts,
        created_at=now(),
    )
    db.add(job)
    try:
        await db.commit()
    except IntegrityError:
        # Another request or process queued it between the check and the insert.
        await db.rollback()
        live = await live_job(db, kind, target_id)
        if live is None:  # it finished in between; nothing to attach to, so queue again
            return await enqueue(
                db, kind, target_id, payload, created_by=created_by, max_attempts=max_attempts
            )
        return live, False
    return job, True


async def reclaim_expired(db: AsyncSession) -> int:
    """Running jobs whose lease ran out: requeued, or failed after their last attempt. Commits."""
    t = now()
    expired = (
        (await db.execute(select(Job).where(Job.status == "running", Job.lease_until < t)))
        .scalars()
        .all()
    )
    changed = 0
    for job in expired:
        values: dict = {"lease_owner": "", "lease_until": None, "updated_at": t}
        if job.cancel_requested:
            values.update(status="cancelled", finished_at=t, error="cancelled")
        elif job.attempts >= job.max_attempts:
            values.update(
                status="failed",
                finished_at=t,
                error=f"interrupted (lease expired) after {job.attempts} attempts",
            )
        else:
            values.update(status="queued")
        result = await db.execute(
            update(Job)
            .where(Job.id == job.id, Job.status == "running", Job.lease_until < t)
            .values(**values)
            .execution_options(synchronize_session=False)
        )
        changed += result.rowcount
    await db.commit()
    return changed


async def claim(
    db: AsyncSession,
    owner: str,
    *,
    job_id: str | None = None,
    exclude_kinds: Iterable[str] = (),
) -> Job | None:
    """Take one queued job (``job_id``'s, or the oldest not of ``exclude_kinds``). Commits."""
    query = select(Job.id).where(Job.status == "queued")
    if job_id is not None:
        query = query.where(Job.id == job_id)
    excluded = tuple(exclude_kinds)
    if excluded:
        query = query.where(Job.kind.not_in(excluded))
    candidates = (await db.execute(query.order_by(Job.created_at, Job.id).limit(5))).scalars().all()
    for candidate in candidates:
        if await take(db, candidate, owner):
            return await db.get(Job, candidate, populate_existing=True)
    return None


async def take(db: AsyncSession, job_id: str, owner: str) -> bool:
    """The compare-and-set behind :func:`claim`: True only for the one caller whose UPDATE moved
    the job out of ``queued``. Everyone else read it while it was still queued, and loses."""
    t = now()
    result = await db.execute(
        update(Job)
        .where(Job.id == job_id, Job.status == "queued")
        .values(
            status="running",
            lease_owner=owner,
            lease_until=t + LEASE,
            attempts=Job.attempts + 1,
            started_at=t,
            updated_at=t,
        )
        .execution_options(synchronize_session=False)
    )
    await db.commit()
    return result.rowcount == 1


async def heartbeat(db: AsyncSession, job_id: str, owner: str) -> bool:
    """Renew the lease. False when this owner no longer holds it or a cancel was asked: stop."""
    t = now()
    result = await db.execute(
        update(Job)
        .where(
            Job.id == job_id,
            Job.status == "running",
            Job.lease_owner == owner,
            Job.cancel_requested.is_(False),
        )
        .values(lease_until=t + LEASE, updated_at=t)
        .execution_options(synchronize_session=False)
    )
    await db.commit()
    return result.rowcount == 1


async def record_events(
    db: AsyncSession, job_id: str, owner: str, attempt: int, events: list[dict]
) -> None:
    """The attempt's progress events so far. A follower that sees a new attempt starts over."""
    progress = {"attempt": attempt, "events": events}
    await db.execute(
        update(Job)
        .where(Job.id == job_id, Job.lease_owner == owner, Job.status == "running")
        .values(progress=json.dumps(progress, ensure_ascii=False), updated_at=now())
        .execution_options(synchronize_session=False)
    )
    await db.commit()
    notify(job_id)


async def finish(
    db: AsyncSession,
    job_id: str,
    owner: str,
    status: str,
    *,
    error: str = "",
    result: object = None,
) -> bool:
    """End a job this owner holds. A ``failed`` job is final: only a runner that died is retried
    (:func:`reclaim_expired`)."""
    t = now()
    job = await db.get(Job, job_id, populate_existing=True)
    if job is None or job.status != "running" or job.lease_owner != owner:
        return False
    values: dict = {
        "lease_owner": "",
        "lease_until": None,
        "updated_at": t,
        "error": error[:4000],
        "status": status,
        "finished_at": t,
    }
    if result is not None:
        values["result"] = json.dumps(result, ensure_ascii=False)
    changed = await db.execute(
        update(Job)
        .where(Job.id == job_id, Job.lease_owner == owner, Job.status == "running")
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    await db.commit()
    notify(job_id)
    _WAKE.pop(job_id, None)  # ended: its waiters were just woken, nobody waits on it again
    return changed.rowcount == 1


async def request_cancel(db: AsyncSession, job: Job) -> Job | None:
    """Cancel a queued job now; ask a running one's runner to stop (its next heartbeat does)."""
    t = now()
    if job.status == "queued":
        await db.execute(
            update(Job)
            .where(Job.id == job.id, Job.status == "queued")
            .values(status="cancelled", finished_at=t, error="cancelled", updated_at=t)
            .execution_options(synchronize_session=False)
        )
    elif job.status == "running":
        await db.execute(
            update(Job)
            .where(Job.id == job.id, Job.status == "running")
            .values(cancel_requested=True, updated_at=t)
            .execution_options(synchronize_session=False)
        )
    await db.commit()
    notify(job.id)
    return await db.get(Job, job.id, populate_existing=True)


async def retry(db: AsyncSession, job: Job, *, created_by: str) -> tuple[Job, bool]:
    """Queue the same work again: a new job with the same kind, target and payload."""
    if job.status not in ("failed", "cancelled"):
        raise JobNotRetryable(job.status)
    return await enqueue(
        db,
        job.kind,
        job.target_id,
        payload_of(job),
        created_by=created_by,
        max_attempts=job.max_attempts,
    )


async def purge(db: AsyncSession) -> int:
    """Delete succeeded and cancelled jobs past the retention period. Commits."""
    result = await db.execute(
        delete(Job).where(
            or_(Job.status == "succeeded", Job.status == "cancelled"),
            Job.finished_at < now() - RETENTION,
        )
    )
    await db.commit()
    return result.rowcount


async def enqueue_once_per_boot(
    db: AsyncSession, kind: str, target_id: str, *, within: timedelta = timedelta(minutes=2)
) -> tuple[Job | None, bool]:
    """Boot work every process asks for (each worker of each replica runs the lifespan): queued
    once, not once per process. Skipped when a job of ``kind`` for ``target_id`` was created in
    the last ``within``. The caller holds :func:`app.db.boot_lock`, so check and insert are one."""
    recent = (
        await db.execute(
            select(Job.id)
            .where(Job.kind == kind, Job.target_id == target_id, Job.created_at > now() - within)
            .limit(1)
        )
    ).scalar_one_or_none()
    if recent is not None:
        return None, False
    return await enqueue(db, kind, target_id)


async def merge_payload(db: AsyncSession, job: Job, payload: dict) -> None:
    """Add ``payload`` to a job still queued (a later request asks for more of the same work)."""
    merged = {**payload_of(job), **payload}
    await db.execute(
        update(Job)
        .where(Job.id == job.id, Job.status == "queued")
        .values(payload=json.dumps(merged, ensure_ascii=False), updated_at=now())
        .execution_options(synchronize_session=False)
    )
    await db.commit()
