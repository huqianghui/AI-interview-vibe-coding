"""Admin "Jobs" tab (docs/planning/spec-jobs-and-scale-out.md §6): every background job, newest
first, filtered by status and kind; retry a failed or cancelled one, cancel a queued or running one.
"""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db import get_db, get_session_factory
from app.dependencies import require_role
from app.jobs import queue, runner
from app.models.anonymous_session import AnonymousCandidateSession
from app.models.interview import InterviewSession
from app.models.job import JOB_KINDS, JOB_STATUSES, Job
from app.models.persona import InterviewerPersona
from app.models.question import QuestionBank
from app.models.sop import SopDocument
from app.models.user import User
from app.services import sop_citation_service

router = APIRouter(
    prefix="/admin/jobs",
    tags=["admin-jobs"],
    dependencies=[Depends(require_role("admin"))],
)


class JobOut(BaseModel):
    job_id: str
    kind: str
    target_id: str
    # What the target is, for people: the candidate, the document, the bank, the interviewer.
    target_label: str
    status: str
    # A running job asked to stop; it does at its next heartbeat (~15 s).
    cancel_requested: bool
    attempts: int
    max_attempts: int
    # Scoring's last progress (questions graded of all), when the job reports it.
    done: int | None = None
    total: int | None = None
    error: str
    created_by: str
    created_at: datetime | None
    started_at: datetime | None
    finished_at: datetime | None


class JobsPage(BaseModel):
    items: list[JobOut]
    total: int


async def _labels(db: AsyncSession, jobs: list[Job]) -> dict[str, str]:
    """``job id → label``, one query per kind present on the page."""
    by_kind: dict[str, set[str]] = {}
    for job in jobs:
        by_kind.setdefault(job.kind, set()).add(job.target_id)
    names: dict[tuple[str, str], str] = {}

    async def collect(kind: str, stmt) -> None:  # noqa: ANN001 — a select of (id, name)
        for target, name in (await db.execute(stmt)).all():
            if name:
                names[(kind, target)] = name

    if ids := by_kind.get("score_interview"):
        await collect(
            "score_interview",
            select(InterviewSession.id, User.username)
            .join(
                AnonymousCandidateSession,
                AnonymousCandidateSession.id == InterviewSession.candidate_session_id,
            )
            .join(User, User.id == AnonymousCandidateSession.user_id)
            .where(InterviewSession.id.in_(ids)),
        )
    docs = by_kind.get("sop_build", set()) | by_kind.get("sop_summary", set())
    if docs:
        for kind in ("sop_build", "sop_summary"):
            await collect(
                kind, select(SopDocument.id, SopDocument.name).where(SopDocument.id.in_(docs))
            )
    if ids := by_kind.get("citation_run"):
        await collect(
            "citation_run",
            select(QuestionBank.id, QuestionBank.name).where(QuestionBank.id.in_(ids)),
        )
    if ids := by_kind.get("persona_sync"):
        await collect(
            "persona_sync",
            select(InterviewerPersona.id, InterviewerPersona.name).where(
                InterviewerPersona.id.in_(ids)
            ),
        )
    return {job.id: names.get((job.kind, job.target_id), "") for job in jobs}


def _out(job: Job, label: str) -> JobOut:
    events = queue.events_of(job)
    progress = next((e for e in reversed(events) if "total" in e), None)
    return JobOut(
        job_id=job.id,
        kind=job.kind,
        target_id=job.target_id,
        target_label=label,
        status=job.status,
        cancel_requested=job.cancel_requested,
        attempts=job.attempts,
        max_attempts=job.max_attempts,
        done=progress.get("done") if progress else None,
        total=progress.get("total") if progress else None,
        error=job.error,
        created_by=job.created_by,
        created_at=job.created_at,
        started_at=job.started_at,
        finished_at=job.finished_at,
    )


async def _one_out(db: AsyncSession, job: Job) -> JobOut:
    return _out(job, (await _labels(db, [job]))[job.id])


@router.get("", response_model=JobsPage)
async def list_jobs(
    status_in: Annotated[list[str] | None, Query(alias="status")] = None,
    kind: Annotated[list[str] | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
    db: AsyncSession = Depends(get_db),
) -> JobsPage:
    """Jobs newest first. ``status`` and ``kind`` may repeat; 422 on an unknown one."""
    statuses = tuple(status_in or ())
    kinds = tuple(kind or ())
    bad = [s for s in statuses if s not in JOB_STATUSES] + [k for k in kinds if k not in JOB_KINDS]
    if bad:
        raise HTTPException(status_code=422, detail=f"Unknown status or kind: {', '.join(bad)}")
    query = select(Job)
    if statuses:
        query = query.where(Job.status.in_(statuses))
    if kinds:
        query = query.where(Job.kind.in_(kinds))
    total = (await db.execute(select(func.count()).select_from(query.subquery()))).scalar_one()
    jobs = list(
        (
            await db.execute(
                query.order_by(Job.created_at.desc(), Job.id.desc()).limit(limit).offset(offset)
            )
        )
        .scalars()
        .all()
    )
    labels = await _labels(db, jobs)
    return JobsPage(items=[_out(j, labels[j.id]) for j in jobs], total=total)


async def _job(db: AsyncSession, job_id: str) -> Job:
    job = await db.get(Job, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    return job


@router.post("/{job_id}/retry", response_model=JobOut, status_code=status.HTTP_202_ACCEPTED)
async def retry_job(
    job_id: str,
    db: AsyncSession = Depends(get_db),
    session_factory: async_sessionmaker = Depends(get_session_factory),
) -> JobOut:
    """Queue the same work again as a new job. 409 unless it failed or was cancelled, or when the
    same work is already queued or running (that job is the retry)."""
    job = await _job(db, job_id)
    if job.status not in ("failed", "cancelled"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=f"Cannot retry a {job.status} job"
        )
    if job.kind == "citation_run":
        # A citation run's job points at its CitationRun row, which has ended: retrying means a
        # new run (and a new row the bank's page shows), started the way the page starts one.
        try:
            run = await sop_citation_service.start_relocation(
                db,
                session_factory,
                job.target_id,
                fresh=bool(queue.payload_of(job).get("fresh")),
                created_by="admin",
            )
        except sop_citation_service.BankHasNoLibrary as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="The bank has no SOP library now"
            ) from exc
        again = await queue.live_job(db, "citation_run", job.target_id)
        if again is None or queue.payload_of(again).get("run_id") != run.id:
            # Already done (inline in tests), or another run was going: show the newest job.
            again = (
                await db.execute(
                    select(Job)
                    .where(Job.kind == "citation_run", Job.target_id == job.target_id)
                    .order_by(Job.created_at.desc(), Job.id.desc())
                    .limit(1)
                )
            ).scalar_one()
        return await _one_out(db, again)
    again, new = await queue.retry(db, job, created_by="admin")
    if not new:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="The same work is already queued"
        )
    await runner.kick(session_factory, again)
    return await _one_out(db, await db.get(Job, again.id, populate_existing=True) or again)


@router.post("/{job_id}/cancel", response_model=JobOut)
async def cancel_job(job_id: str, db: AsyncSession = Depends(get_db)) -> JobOut:
    """Cancel a queued job, or ask a running one to stop (within one heartbeat, ~15 s). 409 once it
    has ended."""
    job = await _job(db, job_id)
    if job.status not in ("queued", "running"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=f"Cannot cancel a {job.status} job"
        )
    after = await queue.request_cancel(db, job)
    if after is None or not (after.status == "cancelled" or after.cancel_requested):
        # It ended between the check and the write: nothing was cancelled.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot cancel a {after.status if after else 'missing'} job",
        )
    return await _one_out(db, after)
