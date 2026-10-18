"""Who the candidate will talk to, for the screens shown before an interview exists.

Sign-in and the signed-in idle screen both introduce the interviewer by name and portrait, but the
persona is only pinned when ``/candidate/interview/start`` creates the session. Without these they
could only show a hardcoded default, which drifts as soon as an admin picks another avatar.

- ``/public/interviewer``: no auth, so it can only know the deployment's DEFAULT persona. It
  returns that persona's avatar character id and nothing else.
- ``/candidate/interviewer``: the caller's own assignment, resolved exactly as a fresh start
  resolves it (``assignment_service``), so the idle screen matches the interview that follows.

``character`` is ``""`` when there is no persona or it leaves the character blank; the page then
shows the same default avatar the voice session falls back to.
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.dependencies import get_anonymous_session
from app.models.anonymous_session import AnonymousCandidateSession
from app.models.persona import InterviewerPersona
from app.services import assignment_service, persona_service

router = APIRouter(tags=["interviewer"])


class InterviewerIdentityOut(BaseModel):
    character: str


def _out(persona: InterviewerPersona | None) -> InterviewerIdentityOut:
    return InterviewerIdentityOut(character=persona_service.avatar_character(persona))


@router.get("/public/interviewer", response_model=InterviewerIdentityOut)
async def default_interviewer(db: AsyncSession = Depends(get_db)) -> InterviewerIdentityOut:
    return _out(await persona_service.get_default_persona(db))


@router.get("/candidate/interviewer", response_model=InterviewerIdentityOut)
async def my_interviewer(
    candidate: AnonymousCandidateSession = Depends(get_anonymous_session),
    db: AsyncSession = Depends(get_db),
) -> InterviewerIdentityOut:
    return _out(await assignment_service.resolve_persona_for_candidate(db, candidate))
