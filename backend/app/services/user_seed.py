"""Seed a default admin user on boot so the admin/editor UI is usable out of the box.

Idempotent: no-op if any admin already exists. Credentials come from settings
(`seed_admin_username` / `seed_admin_password`); when the password is empty (default), seeding is
skipped so a deploy must set a real password explicitly rather than shipping a known default.
"""

import logging

from sqlalchemy import select

from app.config import get_settings
from app.models.user import User
from app.services.auth_service import get_password_hash

logger = logging.getLogger(__name__)


async def seed_default_admin(db) -> None:
    """Create the default admin if no admin exists and a seed password is configured."""
    settings = get_settings()
    password = settings.seed_admin_password
    if not password:
        return  # no default password configured → don't seed (avoids a known-credential admin)

    existing_admin = (
        await db.execute(select(User).where(User.role == "admin").limit(1))
    ).scalar_one_or_none()
    if existing_admin is not None:
        return

    db.add(
        User(
            username=settings.seed_admin_username,
            email=f"{settings.seed_admin_username}@local",
            hashed_password=get_password_hash(password),
            full_name="Administrator",
            role="admin",
        )
    )
    await db.commit()
    logger.info("Seeded default admin user %r", settings.seed_admin_username)
