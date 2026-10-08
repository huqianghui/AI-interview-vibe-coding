"""Which interviewer and question bank a new interview starts with (#187).

A logged-in candidate's own assignment (``User.assigned_persona_id`` / ``assigned_bank_id``) wins
when the target still exists and is enabled; otherwise, field by field, the global default. An
anonymous candidate (no ``user_id``) always gets the default. The result is pinned onto the
interview at start, so a later change to either never touches a live interview. So is the rubric
version: the user's assigned one when it belongs to that bank, else the bank's latest.
"""

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.anonymous_session import AnonymousCandidateSession
from app.models.persona import InterviewerPersona
from app.services import (
    bank_version_service,
    persona_service,
    question_service,
    user_service,
)


@dataclass(frozen=True)
class StartAssignment:
    persona: InterviewerPersona | None
    bank_id: str | None
    # The published bank version the interview pins (spec-bank-versioning).
    bank_version_id: str | None = None


async def resolve_for_candidate(
    db: AsyncSession, candidate: AnonymousCandidateSession
) -> StartAssignment:
    user = await user_service.get_user(db, candidate.user_id) if candidate.user_id else None

    persona = None
    if user is not None and user.assigned_persona_id:
        try:
            assigned = await persona_service.get_persona(db, user.assigned_persona_id)
        except persona_service.PersonaNotFound:
            assigned = None
        if assigned is not None and assigned.enabled:
            persona = assigned
    if persona is None:
        persona = await persona_service.get_default_persona(db)

    bank = None
    if user is not None and user.assigned_bank_id:
        assigned_bank = await question_service.find_bank(db, user.assigned_bank_id)
        if assigned_bank is not None and assigned_bank.enabled:
            bank = assigned_bank
    if bank is None:
        bank = await question_service.get_default_bank(db)

    bank_id = bank.id if bank else None
    # The user's assigned version when it is a version of THIS bank (the bank may have fallen back
    # to the default above), else the bank's latest.
    bank_version_id = await bank_version_service.resolve_for_start(
        db, bank_id, user.assigned_bank_version_id if user is not None else None
    )
    return StartAssignment(persona=persona, bank_id=bank_id, bank_version_id=bank_version_id)
