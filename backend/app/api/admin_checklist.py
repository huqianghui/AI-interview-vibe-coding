"""Admin checklist (rubric) endpoints (SPEC F3). All routes require the admin bearer token.

A checklist is the scoring rubric for a question: required/recommended/forbidden items with weights
(summing to 100) and SOP source attribution. It is authored by the AI-drafting flow and is strictly
admin-only — the rubric must NEVER reach a candidate-scoped response (SPEC P3). Candidates see
questions (F2) and, later, scored results with source quotes (F4/F8), never the checklist itself.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.dependencies import require_admin
from app.services import checklist_service
from app.services.checklist_service import QuestionNotFound

router = APIRouter(
    prefix="/admin/checklists", tags=["admin-checklists"], dependencies=[Depends(require_admin)]
)


class ChecklistItemOut(BaseModel):
    kind: str
    text: str
    weight: int
    source_quote: str
    source_page: str | None
    order_index: int


class ChecklistOut(BaseModel):
    checklist_id: str
    question_id: str
    prompt_version: str
    weights_sum: int
    items: list[ChecklistItemOut]


async def _checklist_out(db: AsyncSession, checklist) -> ChecklistOut:
    items = await checklist_service.list_items(db, checklist.id)
    return ChecklistOut(
        checklist_id=checklist.id,
        question_id=checklist.question_id,
        prompt_version=checklist.prompt_version,
        weights_sum=sum(i.weight for i in items),
        items=[
            ChecklistItemOut(
                kind=i.kind,
                text=i.text,
                weight=i.weight,
                source_quote=i.source_quote,
                source_page=i.source_page,
                order_index=i.order_index,
            )
            for i in items
        ],
    )


@router.post(
    "/questions/{question_id}/draft",
    response_model=ChecklistOut,
    status_code=status.HTTP_201_CREATED,
)
async def draft(question_id: str, db: AsyncSession = Depends(get_db)) -> ChecklistOut:
    """AI-draft a checklist for a question from the SOP (F3 AC #1). Creates a new default."""
    try:
        checklist = await checklist_service.draft_checklist(db, question_id)
    except QuestionNotFound as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Question not found"
        ) from exc
    return await _checklist_out(db, checklist)


@router.get("/questions/{question_id}", response_model=ChecklistOut)
async def get_checklist(question_id: str, db: AsyncSession = Depends(get_db)) -> ChecklistOut:
    """Read the current default checklist for a question (404 if none drafted yet)."""
    checklist = await checklist_service.get_default_checklist(db, question_id)
    if checklist is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="No checklist for this question"
        )
    return await _checklist_out(db, checklist)
