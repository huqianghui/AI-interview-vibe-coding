"""Which interviewer and question bank a new interview starts with (#187).

A logged-in candidate's own assignment (``User.assigned_persona_id`` / ``assigned_bank_id``) wins
when the target still exists and is enabled; otherwise, field by field, the global default. An
anonymous candidate (no ``user_id``) always gets the default. The result is pinned onto the
interview at start, so a later change to either never touches a live interview.
"""

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.anonymous_session import AnonymousCandidateSession
from app.models.persona import InterviewerPersona
from app.services import persona_service, question_service, user_service


@dataclass(frozen=True)
class StartAssignment:
    persona: InterviewerPersona | None
    bank_id: str | None


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

    return StartAssignment(persona=persona, bank_id=bank.id if bank else None)
