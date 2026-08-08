"""Interviewer-persona lifecycle (SPEC F5): CRUD, one-enabled-default, agent-sync bookkeeping.

Two invariants live here, both defended at the DB level and mirrored in this service:

1. **Exactly one enabled default** (F5 AC #3). ``set_default`` clears every other enabled
   default *before* setting the new one, flushing between the two steps so the partial-unique
   index (``uq_one_enabled_default_persona``) never sees two enabled defaults mid-transaction —
   the prefetch/order-before-flush discipline SPEC P8 calls for on SQLite. A racing writer that
   still collides trips the index; we translate that ``IntegrityError`` into ``PersonaConflict``
   rather than leaking a 500.

2. **Agent-sync status is a recorded state, not a crash** (F5 AC #4). ``mark_sync_*`` transitions
   ``none → pending → synced | failed`` and stores the error text on failure.

The Foundry-facing sync itself (network, credentials) is deliberately NOT here — this module is
pure DB + CI-covered. The API layer schedules the coverage-omitted Azure adapter after commit.
"""

from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.persona import AGENT_SYNC_STATUSES, InterviewerPersona


class PersonaError(Exception):
    """Base class for persona-service errors."""


class PersonaNotFound(PersonaError):
    """Raised when a persona id does not exist."""


class PersonaConflict(PersonaError):
    """Raised when an operation would violate the one-enabled-default invariant."""


async def create_persona(
    db: AsyncSession,
    *,
    name: str,
    character: str = "",
    style: str = "",
    prompt_fragment: str = "",
    voice_map: str = "{}",
    greeting_map: str = "{}",
    enabled: bool = True,
    is_default: bool = False,
    **voice_knobs: object,
) -> InterviewerPersona:
    """Create a persona; if ``is_default`` (and enabled), demote any current enabled default."""
    persona = InterviewerPersona(
        name=name,
        character=character,
        style=style,
        prompt_fragment=prompt_fragment,
        voice_map=voice_map,
        greeting_map=greeting_map,
        enabled=enabled,
        is_default=is_default,
        **voice_knobs,
    )
    if is_default and enabled:
        await _clear_enabled_defaults(db, exclude_id=None)
        await db.flush()
    db.add(persona)
    await _commit_translating_conflict(db)
    await db.refresh(persona)
    return persona


async def get_persona(db: AsyncSession, persona_id: str) -> InterviewerPersona:
    persona = (
        await db.execute(select(InterviewerPersona).where(InterviewerPersona.id == persona_id))
    ).scalar_one_or_none()
    if persona is None:
        raise PersonaNotFound(persona_id)
    return persona


async def list_personas(
    db: AsyncSession, *, enabled_only: bool = False
) -> Sequence[InterviewerPersona]:
    stmt = select(InterviewerPersona).order_by(InterviewerPersona.created_at)
    if enabled_only:
        stmt = stmt.where(InterviewerPersona.enabled.is_(True))
    return (await db.execute(stmt)).scalars().all()


async def get_default_persona(db: AsyncSession) -> InterviewerPersona | None:
    """The single enabled default persona, or None if none is set."""
    return (
        await db.execute(
            select(InterviewerPersona).where(
                InterviewerPersona.enabled.is_(True),
                InterviewerPersona.is_default.is_(True),
            )
        )
    ).scalar_one_or_none()


async def update_persona(
    db: AsyncSession, persona_id: str, **changes: object
) -> InterviewerPersona:
    """Patch a persona. Handles the default/enabled transitions that touch the invariant.

    Rules:
    - Promoting to enabled-default demotes the previous enabled default.
    - Disabling the current enabled default is allowed (a disabled row is exempt from the index),
      but leaves the system with no default — the caller decides whether that's acceptable.
    """
    persona = await get_persona(db, persona_id)

    becomes_default = bool(changes.get("is_default", persona.is_default))
    becomes_enabled = bool(changes.get("enabled", persona.enabled))
    if becomes_default and becomes_enabled:
        await _clear_enabled_defaults(db, exclude_id=persona.id)
        await db.flush()

    for field, value in changes.items():
        setattr(persona, field, value)

    await _commit_translating_conflict(db)
    await db.refresh(persona)
    return persona


async def set_default(db: AsyncSession, persona_id: str) -> InterviewerPersona:
    """Make ``persona_id`` the sole enabled default (enabling it if needed)."""
    persona = await get_persona(db, persona_id)
    await _clear_enabled_defaults(db, exclude_id=persona.id)
    await db.flush()  # release the single-default slot before claiming it
    persona.enabled = True
    persona.is_default = True
    await _commit_translating_conflict(db)
    await db.refresh(persona)
    return persona


# --- agent-sync bookkeeping (F5 AC #4) -------------------------------------


async def mark_sync_pending(db: AsyncSession, persona: InterviewerPersona) -> None:
    persona.agent_sync_status = "pending"
    persona.agent_sync_error = None
    await db.commit()


async def mark_sync_succeeded(
    db: AsyncSession, persona: InterviewerPersona, *, agent_id: str, agent_version: str
) -> None:
    persona.agent_id = agent_id
    persona.agent_version = agent_version
    persona.agent_sync_status = "synced"
    persona.agent_sync_error = None
    await db.commit()


async def mark_sync_failed(db: AsyncSession, persona: InterviewerPersona, *, error: str) -> None:
    persona.agent_sync_status = "failed"
    # Cap the stored error so a stack-trace blob can't bloat the row.
    persona.agent_sync_error = error[:500]
    await db.commit()


# --- internals -------------------------------------------------------------


async def _clear_enabled_defaults(db: AsyncSession, *, exclude_id: str | None) -> None:
    """Demote every currently-enabled default (optionally except one) to non-default.

    Read-then-mutate (not a bulk UPDATE) so the ORM identity map stays consistent for any
    already-loaded rows and the change participates in the same flush ordering (P8).
    """
    stmt = select(InterviewerPersona).where(
        InterviewerPersona.enabled.is_(True),
        InterviewerPersona.is_default.is_(True),
    )
    if exclude_id is not None:
        stmt = stmt.where(InterviewerPersona.id != exclude_id)
    for row in (await db.execute(stmt)).scalars().all():
        row.is_default = False


async def _commit_translating_conflict(db: AsyncSession) -> None:
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise PersonaConflict("more than one enabled default persona") from exc


# Re-exported for callers that validate a status string before persisting.
__all__ = [
    "AGENT_SYNC_STATUSES",
    "PersonaConflict",
    "PersonaError",
    "PersonaNotFound",
    "create_persona",
    "get_default_persona",
    "get_persona",
    "list_personas",
    "mark_sync_failed",
    "mark_sync_pending",
    "mark_sync_succeeded",
    "set_default",
    "update_persona",
]
