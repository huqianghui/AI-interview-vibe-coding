"""Read side of the interview history (#187): list a user's interviews, and one interview's detail.

A logged-in candidate owns every interview started under any of their candidate sessions (a login
after expiry mints a new session, so session-scoped ownership would hide older interviews); an
anonymous candidate owns only their own session's. Every status is listed, ``abandoned`` and
``in_progress`` included (owner decision).
"""

import json
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.anonymous_session import AnonymousCandidateSession
from app.models.interview import InterviewSession, InterviewTurn
from app.models.persona import InterviewerPersona
from app.models.question import QuestionBank
from app.models.user import User
from app.schemas.history import (
    InterviewDetail,
    InterviewHistoryItem,
    InterviewResultItem,
    InterviewResultsPage,
    TranscriptTurn,
)

# ``started_at`` carries microseconds, ``created_at`` may not (two interviews in one second tie).
# NULLS LAST spelled out: PostgreSQL puts NULLs FIRST on DESC (SQLite last), which would float a
# never-started session to the top of the list.
_NEWEST_FIRST = (
    InterviewSession.started_at.desc().nulls_last(),
    InterviewSession.created_at.desc(),
)


def _rows_query():
    return (
        select(InterviewSession, InterviewerPersona.name, QuestionBank.name)
        .join(
            AnonymousCandidateSession,
            AnonymousCandidateSession.id == InterviewSession.candidate_session_id,
        )
        .outerjoin(InterviewerPersona, InterviewerPersona.id == InterviewSession.persona_id)
        .outerjoin(QuestionBank, QuestionBank.id == InterviewSession.bank_id)
    )


def _item(session: InterviewSession, persona_name: str | None, bank_name: str | None):
    return InterviewHistoryItem(
        id=session.id,
        status=session.status,
        started_at=session.started_at,
        completed_at=session.completed_at,
        persona_name=persona_name,
        bank_name=bank_name,
        total_score=session.total_score,
        outcome=session.outcome,
        has_report=session.report_json is not None,
    )


async def list_for_user(db: AsyncSession, user_id: str) -> list[InterviewHistoryItem]:
    rows = await db.execute(
        _rows_query().where(AnonymousCandidateSession.user_id == user_id).order_by(*_NEWEST_FIRST)
    )
    return [_item(*row) for row in rows.all()]


async def list_for_candidate(
    db: AsyncSession, candidate: AnonymousCandidateSession
) -> list[InterviewHistoryItem]:
    if candidate.user_id:
        return await list_for_user(db, candidate.user_id)
    rows = await db.execute(
        _rows_query()
        .where(InterviewSession.candidate_session_id == candidate.id)
        .order_by(*_NEWEST_FIRST)
    )
    return [_item(*row) for row in rows.all()]


def _owned_row(interview_id: str, candidate: AnonymousCandidateSession | None):
    query = _rows_query().where(InterviewSession.id == interview_id)
    if candidate is not None:
        if candidate.user_id:
            query = query.where(AnonymousCandidateSession.user_id == candidate.user_id)
        else:
            query = query.where(InterviewSession.candidate_session_id == candidate.id)
    return query


async def find_session(
    db: AsyncSession, interview_id: str, *, candidate: AnonymousCandidateSession | None = None
) -> InterviewSession | None:
    """The interview if it exists and (for a candidate) is theirs; same ownership as the list."""
    row = (await db.execute(_owned_row(interview_id, candidate))).first()
    return row[0] if row else None


async def get_detail(
    db: AsyncSession, interview_id: str, *, candidate: AnonymousCandidateSession | None = None
) -> InterviewDetail | None:
    """One interview with its saved report and full transcript; None when missing or not owned.

    ``candidate=None`` is the admin read (any interview). Missing and not-owned are the same None so
    a caller can return one 404 and never leak that another user's interview exists.
    """
    row = (await db.execute(_owned_row(interview_id, candidate))).first()
    if row is None:
        return None
    session = row[0]
    turns = (
        await db.execute(
            select(InterviewTurn)
            .where(InterviewTurn.interview_session_id == session.id)
            .order_by(InterviewTurn.turn_index, InterviewTurn.created_at)
        )
    ).scalars()
    return InterviewDetail(
        item=_item(*row),
        report=json.loads(session.report_json) if session.report_json else None,
        transcript=[
            TranscriptTurn(
                turn_index=t.turn_index,
                role=t.role,
                turn_kind=t.turn_kind,
                content=t.content,
                created_at=t.created_at,
            )
            for t in turns
        ],
    )


# --- admin "Interview results": every interview, filtered, sorted, paged ---------------------

RESULT_SORTS = ("started_at", "total_score")


@dataclass(frozen=True)
class ResultFilters:
    """What the admin results table can filter on. Every field is optional (None = no filter)."""

    user_id: str | None = None
    statuses: tuple[str, ...] = field(default_factory=tuple)
    persona_id: str | None = None
    bank_id: str | None = None
    # Inclusive calendar days on started_at.
    started_from: date | None = None
    started_to: date | None = None
    outcome: str | None = None
    score_min: float | None = None
    score_max: float | None = None


async def search_results(
    db: AsyncSession,
    filters: ResultFilters,
    *,
    sort: str = "started_at",
    descending: bool = True,
    limit: int = 20,
    offset: int = 0,
) -> InterviewResultsPage:
    """One page of every candidate's interviews, newest first unless asked otherwise.

    A score filter matches only scored interviews (an unscored one has no score to compare); NULL
    scores and start times sort last in both directions, so a page never opens on blanks.
    """
    stmt = (
        select(
            InterviewSession,
            InterviewerPersona.name,
            QuestionBank.name,
            User.id,
            User.username,
        )
        .join(
            AnonymousCandidateSession,
            AnonymousCandidateSession.id == InterviewSession.candidate_session_id,
        )
        .outerjoin(User, User.id == AnonymousCandidateSession.user_id)
        .outerjoin(InterviewerPersona, InterviewerPersona.id == InterviewSession.persona_id)
        .outerjoin(QuestionBank, QuestionBank.id == InterviewSession.bank_id)
    )
    if filters.user_id:
        stmt = stmt.where(AnonymousCandidateSession.user_id == filters.user_id)
    if filters.statuses:
        stmt = stmt.where(InterviewSession.status.in_(filters.statuses))
    if filters.persona_id:
        stmt = stmt.where(InterviewSession.persona_id == filters.persona_id)
    if filters.bank_id:
        stmt = stmt.where(InterviewSession.bank_id == filters.bank_id)
    if filters.started_from:
        stmt = stmt.where(
            InterviewSession.started_at >= datetime.combine(filters.started_from, time.min)
        )
    if filters.started_to:
        day_after = datetime.combine(filters.started_to + timedelta(days=1), time.min)
        stmt = stmt.where(InterviewSession.started_at < day_after)
    if filters.outcome:
        stmt = stmt.where(InterviewSession.outcome == filters.outcome)
    if filters.score_min is not None:
        stmt = stmt.where(InterviewSession.total_score >= filters.score_min)
    if filters.score_max is not None:
        stmt = stmt.where(InterviewSession.total_score <= filters.score_max)

    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()

    column = InterviewSession.total_score if sort == "total_score" else InterviewSession.started_at
    primary = column.desc() if descending else column.asc()
    rows = await db.execute(
        stmt.order_by(primary.nulls_last(), InterviewSession.created_at.desc(), InterviewSession.id)
        .limit(limit)
        .offset(offset)
    )
    items = [
        InterviewResultItem(
            **_item(session, persona_name, bank_name).model_dump(),
            user_id=user_id,
            username=username,
            persona_id=session.persona_id,
            bank_id=session.bank_id,
        )
        for session, persona_name, bank_name, user_id, username in rows.all()
    ]
    return InterviewResultsPage(items=items, total=total, limit=limit, offset=offset)
