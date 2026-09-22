"""Admin user management (admin-only). Plain-list + HTTPException style (adapted from AI-avatar)."""

import asyncio

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.dependencies import require_role
from app.models.user import User
from app.schemas.auth import AdminUserResponse, UserUpdate
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
    query = select(User)
    if search:
        pattern = f"%{search}%"
        query = query.where(
            or_(
                User.full_name.ilike(pattern),
                User.username.ilike(pattern),
                User.email.ilike(pattern),
            )
        )
    if role:
        query = query.where(User.role == role)
    if is_active is not None:
        query = query.where(User.is_active == is_active)
    query = query.order_by(User.created_at.desc())
    rows = (await db.execute(query)).scalars().all()
    return [await _with_derived_password(u) for u in rows]


async def _with_derived_password(user: User) -> AdminUserResponse:
    """Attach the #102 derived-password view (see AdminUserResponse).

    bcrypt-verifies only rows with a generation set (the 3 seeded candidates), so the admin row
    costs nothing. The verify is CPU-bound (~100-300 ms at the default work factor) and bcrypt is
    synchronous, so it runs in a worker thread — never on the event loop that is also carrying
    live interview / voice traffic.
    """
    out = AdminUserResponse.model_validate(user)
    if user.password_generation is None:
        return out
    derived = derive_candidate_password(user.username, user.password_generation)
    if await asyncio.to_thread(verify_password, derived, user.hashed_password):
        return out.model_copy(update={"generated_password": derived})
    return out.model_copy(update={"password_stale": True})


async def _get_or_404(db: AsyncSession, user_id: str) -> User:
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return user


@router.get("/{user_id}", response_model=AdminUserResponse)
async def get_user(user_id: str, db: AsyncSession = Depends(get_db)) -> User:
    return await _get_or_404(db, user_id)


@router.patch("/{user_id}", response_model=AdminUserResponse)
async def update_user(user_id: str, data: UserUpdate, db: AsyncSession = Depends(get_db)) -> User:
    """Update user fields (partial). Only fields present in the body are changed."""
    user = await _get_or_404(db, user_id)
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(user, field, value)
    await db.commit()
    await db.refresh(user)
    return user


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_role("admin")),
) -> None:
    """Soft-delete (deactivate) a user. Cannot delete your own account."""
    if user_id == admin.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot delete your own account"
        )
    user = await _get_or_404(db, user_id)
    user.is_active = False
    await db.commit()
