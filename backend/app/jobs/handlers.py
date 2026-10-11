"""What each kind of job does. Each handler wraps the service function that did the work before
jobs existed; only who starts it changed (docs/planning/spec-jobs-and-scale-out.md §3).

A handler may run more than once for one job (its runner died and the lease expired), so each must
be safe to repeat: scoring overwrites the saved report, a conversion replaces its sections in one
transaction, a citation run starts from its run row, a persona sync is a no-op once synced.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from sqlalchemy.ext.asyncio import async_sessionmaker

from app.jobs import queue

if TYPE_CHECKING:
    from app.jobs.runner import Runner


class JobFailed(Exception):  # noqa: N818 — reads as the outcome it records
    """The job cannot succeed however often it runs (e.g. its interview is gone): fail it now."""


@dataclass
class JobContext:
    job_id: str
    kind: str
    target_id: str
    payload: dict
    attempt: int
    owner: str
    session_factory: async_sessionmaker
    runner: Runner
    events: list[dict] = field(default_factory=list)

    async def emit(self, event: dict) -> None:
        """Append a progress event to the job row, where a waiter reads it."""
        self.events.append(event)
        async with self.session_factory() as db:
            await queue.record_events(db, self.job_id, self.owner, self.attempt, self.events)

    async def enqueue(self, kind: str, target_id: str, payload: dict | None = None) -> None:
        """Queue follow-up work (a converted document's summary). The job process's own loop
        claims it; an embedded or inline runner starts it here."""
        from app.jobs.runner import kick

        async with self.session_factory() as db:
            job, new = await queue.enqueue(db, kind, target_id, payload, created_by="system")
        if new:
            await kick(self.session_factory, job)


async def score_interview(ctx: JobContext) -> Any:
    from app.interview import state_machine
    from app.interview.state_machine import InterviewStateError
    from app.models.interview import InterviewSession

    report = None
    async with ctx.session_factory() as db:
        session = await db.get(InterviewSession, ctx.target_id)
        if session is None:
            raise JobFailed("Interview session no longer exists")
        try:
            async for event in state_machine.score_and_finalize_events(
                db, session, sop_coverage_check=bool(ctx.payload.get("sop_coverage_check"))
            ):
                if event["type"] == "report":
                    report = event["report"]
                elif event["type"] != "ping":  # waiters send their own heartbeat
                    await ctx.emit(event)
        except InterviewStateError as exc:
            raise JobFailed(str(exc)) from exc
    return report


async def sop_build(ctx: JobContext) -> Any:
    from app.services import sop_section_service, sop_summary_service

    force = bool(ctx.payload.get("force"))
    converted = await sop_section_service.build_document(
        ctx.session_factory, ctx.target_id, force=force
    )
    if await sop_summary_service.needs_draft(ctx.session_factory, ctx.target_id):
        await ctx.enqueue("sop_summary", ctx.target_id)
    return {"converted": converted}


async def sop_summary(ctx: JobContext) -> Any:
    from app.services import sop_summary_service

    return {"written": await sop_summary_service.draft_document(ctx.session_factory, ctx.target_id)}


async def sop_backfill(ctx: JobContext) -> Any:
    """Boot: queue a conversion for every document that needs one and a draft for every converted
    document without a summary, then bring every document's search vectors up to date."""
    from app.services import sop_embeddings, sop_section_service, sop_summary_service

    for doc_id in await sop_section_service.ids_needing_conversion(ctx.session_factory):
        await ctx.enqueue("sop_build", doc_id)
    for doc_id in await sop_summary_service.ids_needing_draft(ctx.session_factory):
        await ctx.enqueue("sop_summary", doc_id)
    return {"embedded": await sop_embeddings.refresh_all(ctx.session_factory)}


async def citation_run(ctx: JobContext) -> Any:
    from app.services import sop_citation_service

    await sop_citation_service.run_relocation(
        ctx.session_factory, ctx.payload["run_id"], fresh=bool(ctx.payload.get("fresh"))
    )
    return {"run_id": ctx.payload["run_id"]}


async def persona_sync(ctx: JobContext) -> Any:
    from app.services.persona_seed import sync_default_persona

    async with ctx.session_factory() as db:
        await sync_default_persona(db)
    return None


HANDLERS: dict[str, Callable[[JobContext], Awaitable[Any]]] = {
    "score_interview": score_interview,
    "sop_build": sop_build,
    "sop_summary": sop_summary,
    "sop_backfill": sop_backfill,
    "citation_run": citation_run,
    "persona_sync": persona_sync,
}
