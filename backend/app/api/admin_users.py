"""Admin user listing (admin-only, read-only: accounts come from the boot seed, see user_seed)."""

import asyncio

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.dependencies import require_role
from app.models.user import User
from app.schemas.auth import AdminUserResponse
from app.schemas.history import AssignmentIn
from app.services import bank_version_service, persona_service, question_service, user_service
from app.services.auth_service import derive_candidate_password, verify_password

router = APIRouter(
    prefix="/admin/users", tags=["admin-users"], dependencies=[Depends(require_role("admin"))]
)


@router.get("", response_model=list[AdminUserResponse])
async def list_users(
    search: str | None = None,
    role: str | None = None,
    is_active: bool | None = None,
    db: AsyncSession = Depends(get_db),
) -> list[AdminUserResponse]:
    """List users with optional search (name/username/email), role, and active filters."""
    rows = await user_service.list_users(db, search=search, role=role, is_active=is_active)
    numbers = await bank_version_service.version_numbers(
        db, {u.assigned_bank_version_id for u in rows if u.assigned_bank_version_id}
    )
    return [await _with_derived_password(u, numbers) for u in rows]


@router.patch("/{user_id}/assignment", response_model=AdminUserResponse)
async def set_assignment(
    user_id: str, body: AssignmentIn, db: AsyncSession = Depends(get_db)
) -> AdminUserResponse:
    """Set the interviewer, bank and bank version this user's NEXT interview starts with.

    #187 + spec-bank-versioning. A null persona or bank means the global default; a bank with no
    version means that bank's latest published version.

    A live interview keeps what it started with. 404 unknown user; 422 an unknown or disabled
    persona/bank (a disabled one would silently fall back to the default at start).
    """
    user = await user_service.get_user(db, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if body.persona_id is not None:
        try:
            persona = await persona_service.get_persona(db, body.persona_id)
        except persona_service.PersonaNotFound:
            persona = None
        if persona is None or not persona.enabled:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Unknown or disabled interviewer",
            )
    if body.bank_id is not None:
        bank = await question_service.find_bank(db, body.bank_id)
        if bank is None or not bank.enabled:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Unknown or disabled question bank",
            )
    bank_version_id = None
    if body.bank_id is None and body.bank_version_id is not None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="A bank version needs the question bank it belongs to",
        )
    if body.bank_id is not None:
        # The published version is part of the assignment (spec-bank-versioning): the one asked
        # for, which must be a version of this bank; else, for the same bank, the one already
        # assigned; else the bank's latest published version (none yet: the draft at start).
        # "Not sent" is told apart from null so a tab running an older page, which never sends the
        # field, cannot re-pin a user to the latest by saving their interviewer.
        if body.bank_version_id is not None:
            version = await bank_version_service.get(db, body.bank_version_id)
            if version is None or version.bank_id != body.bank_id:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="That version does not belong to this question bank",
                )
            bank_version_id = version.id
        elif (
            "bank_version_id" not in body.model_fields_set
            and body.bank_id == user.assigned_bank_id
            and user.assigned_bank_version_id
        ):
            bank_version_id = user.assigned_bank_version_id
        else:
            latest = await bank_version_service.latest(db, body.bank_id)
            bank_version_id = latest.id if latest else None
    user.assigned_persona_id = body.persona_id
    user.assigned_bank_id = body.bank_id
    user.assigned_bank_version_id = bank_version_id
    await db.commit()
    await db.refresh(user)
    numbers = await bank_version_service.version_numbers(
        db, {bank_version_id} if bank_version_id else set()
    )
    return await _with_derived_password(user, numbers)


async def _with_derived_password(
    user: User, version_numbers: dict[str, int] | None = None
) -> AdminUserResponse:
    """Attach the #102 derived-password view (see AdminUserResponse).

    bcrypt-verifies only rows with a generation set (the 3 seeded candidates), so the admin row
    costs nothing. The verify is CPU-bound (~100-300 ms at the default work factor) and bcrypt is
    synchronous, so it runs in a worker thread — never on the event loop that is also carrying
    live interview / voice traffic.
    """
    out = AdminUserResponse.model_validate(user)
    out.assigned_bank_version_no = (version_numbers or {}).get(user.assigned_bank_version_id or "")
    if user.password_generation is None:
        return out
    derived = derive_candidate_password(user.username, user.password_generation)
    if await asyncio.to_thread(verify_password, derived, user.hashed_password):
        return out.model_copy(update={"generated_password": derived})
    return out.model_copy(update={"password_stale": True})
