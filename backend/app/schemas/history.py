"""Interview history shapes (#187): the list row, a transcript turn, and one interview's detail."""

from datetime import datetime

from pydantic import BaseModel


class InterviewHistoryItem(BaseModel):
    id: str
    status: str
    started_at: datetime | None
    completed_at: datetime | None
    # NULL on rows started before #187 (nothing was pinned) and when the pinned row was deleted.
    persona_name: str | None
    bank_name: str | None
    # From the last scoring run; NULL until scored (and on rows scored before #187).
    total_score: float | None
    outcome: str | None
    has_report: bool


class TranscriptTurn(BaseModel):
    turn_index: int
    role: str
    turn_kind: str
    content: str
    created_at: datetime


class InterviewDetail(BaseModel):
    item: InterviewHistoryItem
    # The saved ``ReportOut`` dict; None until the interview is scored.
    report: dict | None
    transcript: list[TranscriptTurn]
    # Admin read only: an admin-started scoring run for it is still going (the page polls on this).
    scoring: bool = False


class AssignmentIn(BaseModel):
    """A user's interviewer + bank; null = use the global default."""

    persona_id: str | None = None
    bank_id: str | None = None
