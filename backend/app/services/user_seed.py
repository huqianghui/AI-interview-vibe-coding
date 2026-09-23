"""Seed the default admin + the three candidate accounts on boot (#102).

Two seeds with deliberately DIFFERENT gates:

* **Admin** (``seed_default_admin``): only when ``SEED_ADMIN_PASSWORD`` is set — the admin's
  password is self-chosen and stored only as a hash, so shipping a known default would be a
  known-credential admin.
* **Candidates** (``seed_default_candidates``): ALWAYS. ``user1/user2/user3`` get passwords DERIVED
  from the deployment's ``SECRET_KEY`` (``auth_service.derive_candidate_password``), which config
  refuses to leave at a placeholder — so they are unique per deployment, never committed anywhere,
  identical after an ephemeral-SQLite rebuild, and re-displayable to the admin (Users tab) without
  storing plaintext. That inversion of the admin rule is intentional: the client requires that
  candidates can always log in with zero manual setup, and "recoverable by the admin" is the
  feature, not a leak. Usage rule (documented in the Users tab + manual): one account is used by
  one person at a time.

Admin seed details:

Idempotent: no-op if any admin already exists. Credentials come from settings
(`seed_admin_username` / `seed_admin_password`); when the password is empty (default), seeding is
skipped so a deploy must set a real password explicitly rather than shipping a known default.
"""

import logging

from sqlalchemy import select

from app.config import get_settings
from app.models.user import User
from app.services.auth_service import derive_candidate_password, get_password_hash

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


CANDIDATE_USERNAMES = ("user1", "user2", "user3")
CANDIDATE_PASSWORD_GENERATION = 1


async def seed_default_candidates(db) -> list[str]:
    """Create ``user1/user2/user3`` (role ``user``) with derived passwords. Idempotent by username.

    An existing row with one of these usernames — in ANY state (other role, inactive, NULL
    generation) — is left untouched. Returns the usernames created this boot.
    """
    existing = set(
        (await db.execute(select(User.username).where(User.username.in_(CANDIDATE_USERNAMES))))
        .scalars()
        .all()
    )
    created: list[str] = []
    for username in CANDIDATE_USERNAMES:
        if username in existing:
            continue
        password = derive_candidate_password(username, CANDIDATE_PASSWORD_GENERATION)
        db.add(
            User(
                username=username,
                email=f"{username}@local",
                hashed_password=get_password_hash(password),
                full_name=username,
                role="user",
                password_generation=CANDIDATE_PASSWORD_GENERATION,
            )
        )
        created.append(username)
    if created:
        await db.commit()
        logger.info("Seeded candidate accounts %s (derived passwords)", created)
    return created
