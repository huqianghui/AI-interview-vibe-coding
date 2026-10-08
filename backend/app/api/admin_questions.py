"""Admin question-bank editor (SPEC F2b). All routes require the admin bearer token.

CRUD + reorder + set-default over question banks and their questions — the business-facing editor
for the interview question set. Candidate-facing reads stay in the candidate API (F2), which never
exposes ``expected_points``; these admin routes DO surface it (it's the interviewer-internal link
to the rubric) and are gated by ``require_role("admin")`` (SPEC P3).
"""

import json
import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db, get_session_factory
from app.dependencies import require_role
from app.models.user import User
from app.services import (
    bank_bundle_service,
    bank_version_service,
    checklist_service,
    sop_citation_service,
)
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
    language: str = "en-US"
    is_default: bool = False


class BankOut(BaseModel):
    bank_id: str
    name: str
    description: str
    language: str
    enabled: bool
    is_default: bool
    # Publish state (spec-bank-versioning): the latest published version, and whether the draft has
    # edits not in it yet. Null / True for a bank never published.
    latest_version_no: int | None = None
    has_unpublished_changes: bool = False


class QuestionIn(BaseModel):
    text: str = Field(min_length=1)
    language: str = "en-US"
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


class AdminQuestionOut(BaseModel):
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


class BundleImportOut(BaseModel):
    """Result of a bank-bundle import — an auditable summary of what the sync wrote."""

    bank_id: str
    bank_name: str
    replaced: bool
    question_count: int
    checklist_item_count: int
    unresolved_sop_names: list[str]
    # The version this import published, or None with the reason codes it could not (incomplete).
    published_version_no: int | None = None
    publish_problems: list[str] = []


async def _bank_out(db: AsyncSession, bank) -> BankOut:
    latest_no, unpublished = await bank_version_service.publish_state(db, bank.id)
    return BankOut(
        bank_id=bank.id,
        name=bank.name,
        description=bank.description,
        language=bank.language,
        enabled=bank.enabled,
        is_default=bank.is_default,
        latest_version_no=latest_no,
        has_unpublished_changes=unpublished,
    )


def _question_out(q, checklist_item_count: int = 0) -> AdminQuestionOut:
    import json

    try:
        points = json.loads(q.expected_points)
        points = [str(p) for p in points] if isinstance(points, list) else []
    except (ValueError, TypeError):
        points = []
    return AdminQuestionOut(
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
    return [await _bank_out(db, b) for b in await svc.list_banks(db)]


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
    return await _bank_out(db, bank)


@router.get("/{bank_id}/export")
async def export_bundle(bank_id: str, db: AsyncSession = Depends(get_db)) -> dict:
    """Serialize a bank + its questions + full checklists to a portable bundle (deploy-time sync).

    The dual of :func:`import_bundle`: the returned JSON is exactly what that endpoint consumes, so
    a bank can be exported from one deployment (e.g. local) and imported into another (the ephemeral
    server) to make the two identical. Rubric SOP links travel as document *names*, not ids.
    """
    try:
        return await bank_bundle_service.export_bank_bundle(db, bank_id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@router.post("/import", response_model=BundleImportOut, status_code=status.HTTP_201_CREATED)
async def import_bundle(bundle: dict, db: AsyncSession = Depends(get_db)) -> BundleImportOut:
    """Create (or replace by name) a bank + questions + checklists from a bundle (deploy-time sync).

    The server runs on ephemeral SQLite reseeded on every boot, and the private-blob seeding channel
    is unavailable (storage public network access is disabled by policy), so this is how a deployed
    bank is made to match a local one: export locally, POST the bundle here. Idempotent by bank name
    (a same-named bank is replaced, not duplicated). Rubric items are written verbatim — including
    ``advisory`` gates and SOP citations resolved by document name — so scoring behaves identically.
    """
    try:
        result = await bank_bundle_service.import_bank_bundle(db, bundle)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return BundleImportOut(
        bank_id=result.bank_id,
        bank_name=result.bank_name,
        replaced=result.replaced,
        question_count=result.question_count,
        checklist_item_count=result.checklist_item_count,
        unresolved_sop_names=result.unresolved_sop_names,
        published_version_no=result.published_version_no,
        publish_problems=result.publish_problems,
    )


@router.post("/{bank_id}/default", response_model=BankOut)
async def set_default(bank_id: str, db: AsyncSession = Depends(get_db)) -> BankOut:
    try:
        return await _bank_out(db, await svc.set_default_bank(db, bank_id))
    except QuestionBankNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Bank not found") from exc


class BankVersionOut(BaseModel):
    id: str
    version_no: int
    created_at: datetime | None
    reason: str
    question_count: int
    is_latest: bool


@router.get("/{bank_id}/versions", response_model=list[BankVersionOut])
async def list_versions(bank_id: str, db: AsyncSession = Depends(get_db)) -> list[BankVersionOut]:
    """The bank's published versions, newest first (spec-bank-versioning). Read-only: a version
    exists only once an admin publishes (or an import publishes) a complete bank."""
    try:
        await svc.get_bank(db, bank_id)
    except QuestionBankNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Bank not found") from exc
    versions = await bank_version_service.list_versions(db, bank_id)
    return [
        BankVersionOut(
            id=v.id,
            version_no=v.version_no,
            created_at=v.created_at,
            reason=v.reason,
            question_count=bank_version_service.question_count(v),
            is_latest=i == 0,
        )
        for i, v in enumerate(versions)
    ]


class PublishProblemOut(BaseModel):
    code: str  # no_questions | no_rubric | weights
    question_no: int | None = None
    question_text: str = ""
    weights_sum: int | None = None


class PublishOut(BaseModel):
    published: bool
    # True when this publish minted a version; False when the draft equalled the latest one.
    created: bool = False
    version_no: int | None = None
    problems: list[PublishProblemOut] = []


@router.post("/{bank_id}/publish", response_model=PublishOut)
async def publish(
    bank_id: str,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_role("admin")),
) -> PublishOut:
    """Publish the bank's draft as a new version (spec-bank-versioning).

    Refused, with every reason, while the draft is incomplete: an enabled question without a rubric,
    or a rubric whose weights do not sum to 100. An unchanged draft returns the latest version.
    """
    try:
        await svc.get_bank(db, bank_id)
    except QuestionBankNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Bank not found") from exc
    result = await bank_version_service.publish(db, bank_id, created_by=admin.id)
    return PublishOut(
        published=result.version is not None,
        created=result.created,
        version_no=result.version.version_no if result.version else None,
        problems=[PublishProblemOut(**vars(p)) for p in result.problems],
    )


class CitationRunOut(BaseModel):
    """A "Relocate SOP citations" run (spec-sop-section-grounding §4): progress, then each rubric
    item's old citation beside its new one. The new citations are already in the draft."""

    run_id: str
    status: str  # running | done | failed
    done: int
    total: int
    error: str
    created_at: datetime | None
    rows: list[dict]


def _run_out(run) -> CitationRunOut:
    return CitationRunOut(
        run_id=run.id,
        status=run.status,
        done=run.done,
        total=run.total,
        error=run.error,
        created_at=run.created_at,
        rows=json.loads(run.report_json or "[]") if run.status == "done" else [],
    )


@router.post(
    "/{bank_id}/relocate-citations",
    response_model=CitationRunOut,
    status_code=status.HTTP_202_ACCEPTED,
)
async def relocate_citations(
    bank_id: str,
    db: AsyncSession = Depends(get_db),
    session_factory=Depends(get_session_factory),  # noqa: ANN001
) -> CitationRunOut:
    """Relocate every SOP citation in the bank's draft rubric, in the background. The results go
    into the DRAFT; review them and publish (owner, 2026-10-08)."""
    try:
        await svc.get_bank(db, bank_id)
    except QuestionBankNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Bank not found") from exc
    return _run_out(await sop_citation_service.start_relocation(db, session_factory, bank_id))


@router.get("/{bank_id}/relocate-citations", response_model=CitationRunOut | None)
async def latest_relocation(
    bank_id: str, db: AsyncSession = Depends(get_db)
) -> CitationRunOut | None:
    """The bank's latest relocation run, or null if it never had one."""
    run = await sop_citation_service.latest_run(db, bank_id)
    return _run_out(run) if run is not None else None


@router.get("/{bank_id}/questions", response_model=list[AdminQuestionOut])
async def list_questions(
    bank_id: str, db: AsyncSession = Depends(get_db)
) -> list[AdminQuestionOut]:
    try:
        await svc.get_bank(db, bank_id)
    except QuestionBankNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Bank not found") from exc
    rows = await svc.list_questions_for_bank(db, bank_id, enabled_only=False)
    counts = await checklist_service.default_item_counts(db, [q.id for q in rows])
    return [_question_out(q, counts.get(q.id, 0)) for q in rows]


@router.post(
    "/{bank_id}/questions", response_model=AdminQuestionOut, status_code=status.HTTP_201_CREATED
)
async def add_question(
    bank_id: str, body: QuestionIn, db: AsyncSession = Depends(get_db)
) -> AdminQuestionOut:
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


@router.patch("/questions/{question_id}", response_model=AdminQuestionOut)
async def edit_question(
    question_id: str, body: QuestionPatch, db: AsyncSession = Depends(get_db)
) -> AdminQuestionOut:
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
