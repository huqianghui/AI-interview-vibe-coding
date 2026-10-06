"""Reading user accounts (the accounts themselves come from the boot seed, see ``user_seed``)."""

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User


async def get_user(db: AsyncSession, user_id: str) -> User | None:
    return (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()


async def list_users(
    db: AsyncSession,
    *,
    search: str | None = None,
    role: str | None = None,
    is_active: bool | None = None,
) -> list[User]:
    """Users, newest first. ``search`` matches full name, username or email, case-insensitively."""
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
    return list((await db.execute(query)).scalars().all())
