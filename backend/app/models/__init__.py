"""ORM model registry.

Import every mapped class here so Base.metadata sees them before create_all /
Alembic autogenerate runs.
"""

from app.db import Base
from app.models.anonymous_session import AnonymousCandidateSession
from app.models.checklist import Checklist, ChecklistItem
from app.models.interview import InterviewSession, InterviewTurn
from app.models.persona import InterviewerPersona
from app.models.question import Question, QuestionBank
from app.models.sop import SopChunk, SopDocument
from app.models.user import User

__all__ = [
    "Base",
    "AnonymousCandidateSession",
    "Checklist",
    "ChecklistItem",
    "InterviewSession",
    "InterviewTurn",
    "InterviewerPersona",
    "Question",
    "QuestionBank",
    "SopDocument",
    "SopChunk",
    "User",
]
