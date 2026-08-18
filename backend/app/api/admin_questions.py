"""Admin question-bank editor (SPEC F2b). All routes require the admin bearer token.

CRUD + reorder + set-default over question banks and their questions — the business-facing editor
for the interview question set. Candidate-facing reads stay in the candidate API (F2), which never
exposes ``expected_points``; these admin routes DO surface it (it's the interviewer-internal link
to the rubric) and are gated by ``require_admin`` (SPEC P3).
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.dependencies import require_role
from app.services import checklist_service
from app.services import question_service as svc
from app.services.question_service import (
    QuestionBankConflict,
    QuestionBankNotFound,
    QuestionNotFound,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/admin/question-banks",
    tags=["admin-questions"],
    dependencies=[Depends(require_role("admin"))],
)


class BankIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = ""
    language: str = "zh-CN"
    is_default: bool = False


class BankOut(BaseModel):
    bank_id: str
    name: str
    description: str
    language: str
    enabled: bool
    is_default: bool


class QuestionIn(BaseModel):
    text: str = Field(min_length=1)
    language: str = "zh-CN"
    expected_points: list[str] = []
    max_follow_ups: int = 0
    follow_up_prompt: str = "Can you walk me through that in a bit more detail?"


class QuestionPatch(BaseModel):
    text: str | None = None
    language: str | None = None
    expected_points: list[str] | None = None
    enabled: bool | None = None
    max_follow_ups: int | None = None
    follow_up_prompt: str | None = None


class QuestionOut(BaseModel):
    question_id: str
    text: str
    language: str
    order_index: int
    enabled: bool
    expected_points: list[str]
    max_follow_ups: int
    # Number of items in this question's default checklist (0 = no rubric configured yet). Drives
    # the editor's rubric-status marker; a count, never rubric content, so P3 stays intact.
    checklist_item_count: int = 0


class ReorderIn(BaseModel):
    ordered_ids: list[str]


def _bank_out(bank) -> BankOut:
    return BankOut(
        bank_id=bank.id,
        name=bank.name,
        description=bank.description,
        language=bank.language,
        enabled=bank.enabled,
        is_default=bank.is_default,
    )


def _question_out(q, checklist_item_count: int = 0) -> QuestionOut:
    import json

    try:
        points = json.loads(q.expected_points)
        points = [str(p) for p in points] if isinstance(points, list) else []
    except (ValueError, TypeError):
        points = []
    return QuestionOut(
        question_id=q.id,
        text=q.text,
        language=q.language,
        order_index=q.order_index,
        enabled=q.enabled,
        expected_points=points,
        max_follow_ups=q.max_follow_ups,
        checklist_item_count=checklist_item_count,
    )


@router.get("", response_model=list[BankOut])
async def list_banks(db: AsyncSession = Depends(get_db)) -> list[BankOut]:
    return [_bank_out(b) for b in await svc.list_banks(db)]


@router.post("", response_model=BankOut, status_code=status.HTTP_201_CREATED)
async def create_bank(body: BankIn, db: AsyncSession = Depends(get_db)) -> BankOut:
    try:
        bank = await svc.create_bank(
            db,
            name=body.name,
            description=body.description,
            language=body.language,
            is_default=body.is_default,
        )
    except QuestionBankConflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return _bank_out(bank)


@router.post("/{bank_id}/default", response_model=BankOut)
async def set_default(bank_id: str, db: AsyncSession = Depends(get_db)) -> BankOut:
    try:
        return _bank_out(await svc.set_default_bank(db, bank_id))
    except QuestionBankNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Bank not found") from exc


@router.get("/{bank_id}/questions", response_model=list[QuestionOut])
async def list_questions(bank_id: str, db: AsyncSession = Depends(get_db)) -> list[QuestionOut]:
    try:
        await svc.get_bank(db, bank_id)
    except QuestionBankNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Bank not found") from exc
    rows = await svc.list_questions_for_bank(db, bank_id, enabled_only=False)
    counts = await checklist_service.default_item_counts(db, [q.id for q in rows])
    return [_question_out(q, counts.get(q.id, 0)) for q in rows]


@router.post(
    "/{bank_id}/questions", response_model=QuestionOut, status_code=status.HTTP_201_CREATED
)
async def add_question(
    bank_id: str, body: QuestionIn, db: AsyncSession = Depends(get_db)
) -> QuestionOut:
    import json

    try:
        await svc.get_bank(db, bank_id)
    except QuestionBankNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Bank not found") from exc
    existing = await svc.list_questions_for_bank(db, bank_id, enabled_only=False)
    q = await svc.add_question(
        db,
        bank_id=bank_id,
        text=body.text,
        order_index=len(existing),
        language=body.language,
        expected_points=json.dumps(body.expected_points, ensure_ascii=False),
        max_follow_ups=body.max_follow_ups,
        follow_up_prompt=body.follow_up_prompt,
    )
    # Design B invariant: every question has a non-empty, editable checklist from the moment it is
    # created — drafted from the question text (SOP-optional). We do this here (not in add_question)
    # so a drafting failure can never roll back the already-committed question: the AI call is a
    # best-effort convenience, not part of the create transaction. On failure the question still
    # exists with no checklist and the admin can regenerate/author it in the editor.
    try:
        await checklist_service.draft_checklist(db, q.id)
    except Exception:  # noqa: BLE001 — never block question creation on rubric drafting
        logger.warning("auto-draft checklist failed for question %s", q.id, exc_info=True)
    counts = await checklist_service.default_item_counts(db, [q.id])
    return _question_out(q, counts.get(q.id, 0))


@router.patch("/questions/{question_id}", response_model=QuestionOut)
async def edit_question(
    question_id: str, body: QuestionPatch, db: AsyncSession = Depends(get_db)
) -> QuestionOut:
    import json

    changes: dict = {}
    if body.text is not None:
        changes["text"] = body.text
    if body.language is not None:
        changes["language"] = body.language
    if body.expected_points is not None:
        changes["expected_points"] = json.dumps(body.expected_points, ensure_ascii=False)
    if body.enabled is not None:
        changes["enabled"] = body.enabled
    if body.max_follow_ups is not None:
        changes["max_follow_ups"] = body.max_follow_ups
    if body.follow_up_prompt is not None:
        changes["follow_up_prompt"] = body.follow_up_prompt
    try:
        return _question_out(await svc.update_question(db, question_id, **changes))
    except QuestionNotFound as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Question not found"
        ) from exc


@router.delete("/questions/{question_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_question(question_id: str, db: AsyncSession = Depends(get_db)) -> None:
    try:
        await svc.delete_question(db, question_id)
    except QuestionNotFound as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Question not found"
        ) from exc


@router.post("/{bank_id}/reorder", status_code=status.HTTP_204_NO_CONTENT)
async def reorder(bank_id: str, body: ReorderIn, db: AsyncSession = Depends(get_db)) -> None:
    try:
        await svc.reorder_questions(db, bank_id, body.ordered_ids)
    except QuestionBankNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Bank not found") from exc
