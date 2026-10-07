"""Read side of the interview history (#187): list a user's interviews, and one interview's detail.

A logged-in candidate owns every interview started under any of their candidate sessions (a login
after expiry mints a new session, so session-scoped ownership would hide older interviews); an
anonymous candidate owns only their own session's. Every status is listed, ``abandoned`` and
``in_progress`` included (owner decision).
"""

import json

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.anonymous_session import AnonymousCandidateSession
from app.models.interview import InterviewSession, InterviewTurn
from app.models.persona import InterviewerPersona
from app.models.question import QuestionBank
from app.schemas.history import InterviewDetail, InterviewHistoryItem, TranscriptTurn

# ``started_at`` carries microseconds, ``created_at`` may not (two interviews in one second tie).
_NEWEST_FIRST = (InterviewSession.started_at.desc(), InterviewSession.created_at.desc())


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
