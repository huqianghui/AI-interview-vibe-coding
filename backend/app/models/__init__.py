"""ORM model registry.

Import every mapped class here so Base.metadata sees them before create_all /
Alembic autogenerate runs.
"""

from app.db import Base
from app.models.anonymous_session import AnonymousCandidateSession

__all__ = ["Base", "AnonymousCandidateSession"]
