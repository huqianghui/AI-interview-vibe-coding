"""Admin checklist (rubric) endpoints (SPEC F3). All routes require the admin bearer token.

A checklist is the scoring rubric for a question: required/recommended/forbidden items with weights
(summing to 100) and SOP source attribution. It is authored by the AI-drafting flow and is strictly
admin-only — the rubric must NEVER reach a candidate-scoped response (SPEC P3). Candidates see
questions (F2) and, later, scored results with source quotes (F4/F8), never the checklist itself.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.dependencies import require_role
from app.services import checklist_service, sop_citation
from app.services.checklist_service import ChecklistNotFound, QuestionNotFound

router = APIRouter(
    prefix="/admin/checklists",
    tags=["admin-checklists"],
    dependencies=[Depends(require_role("admin"))],
)


class SourceRefOut(BaseModel):
    """One cited SOP section (spec-sop-section-grounding §3)."""

    document_id: str
    document_name: str
    section: str
    title: str
    page_start: int | None
    # False when the document or the section no longer exists.
    found: bool
    # A run of sections (a merged unit) ends at ``through``; ``part`` "own" = the section's own
    # text only. Both empty for one whole section.
    through: str = ""
    part: str = ""


class SourceRefIn(BaseModel):
    document_id: str
    section: str
    through: str = ""
    part: str = ""


class ChecklistItemOut(BaseModel):
    kind: str
    text: str
    weight: int
    source_quote: str
    source_page: str | None
    order_index: int
    # The SOP document behind the item's citation link (the report's "SOP source"), and a forbidden
    # item that is disclosed but never deducts. The editor must send both back unchanged.
    source_document_id: str | None = None
    source_document_name: str | None = None
    advisory: bool = False
    # The SOP sections the item cites, primary first; scoring reads each one's full text.
    source_refs: list[SourceRefOut] = []


class ChecklistOut(BaseModel):
    checklist_id: str
    question_id: str
    prompt_version: str
    weights_sum: int
    items: list[ChecklistItemOut]


async def _checklist_out(db: AsyncSession, checklist) -> ChecklistOut:
    items = await checklist_service.list_items(db, checklist.id)
    names = await checklist_service.document_names(
        db, {i.source_document_id for i in items if i.source_document_id}
    )
    refs = {i.id: sop_citation.parse_refs(i.source_refs) for i in items}
    described = await sop_citation.describe(db, [r for rs in refs.values() for r in rs])
    by_ref = {
        (d["document_id"], d["section"], d.get("through", ""), d.get("part", "")): d
        for d in described
    }
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
                source_document_id=i.source_document_id,
                source_document_name=names.get(i.source_document_id or ""),
                advisory=i.advisory,
                source_refs=[
                    SourceRefOut(
                        **by_ref[(r.document_id, r.section, r.through, "own" if r.own else "")]
                    )
                    for r in refs[i.id]
                ],
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


class ChecklistItemIn(BaseModel):
    kind: str  # required | recommended | forbidden
    text: str
    weight: int = 0
    source_quote: str = ""
    source_page: str | None = None
    # Optional so a tab running an older bundle (which never sent them) keeps the stored values
    # instead of clearing them: an omitted field is carried over, an explicit one is used.
    source_document_id: str | None = None
    advisory: bool = False
    # Omitted = keep the stored ones (an older tab); a section that does not exist is dropped.
    source_refs: list[SourceRefIn] | None = Field(
        default=None, max_length=sop_citation.MAX_REFS_PER_ITEM
    )


class ChecklistEditIn(BaseModel):
    items: list[ChecklistItemIn]


# Fields every item carries whether or not the client sent them (they have usable defaults); the
# two optional ones above are passed through ONLY when sent, so an omission can be told apart.
_ALWAYS_SENT = {"kind", "text", "weight", "source_quote", "source_page"}


@router.put("/{checklist_id}/items", response_model=ChecklistOut)
async def edit_items(
    checklist_id: str,
    body: ChecklistEditIn,
    db: AsyncSession = Depends(get_db),
) -> ChecklistOut:
    """Replace a checklist's items with an edited set (F3b / F3 AC #4).

    Weights are re-normalized to sum 100 (forbidden items → 0); invalid-kind rows are dropped. The
    saved checklist is returned so the editor round-trips (save → reload).
    """
    raw = [it.model_dump(include=it.model_fields_set | _ALWAYS_SENT) for it in body.items]
    try:
        checklist = await checklist_service.update_items(db, checklist_id, raw)
    except ChecklistNotFound as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Checklist not found"
        ) from exc
    return await _checklist_out(db, checklist)
