"""Bank versions: publish a bank's draft, pick a version for an interview, read through it.

Spec: ``docs/planning/spec-bank-versioning.md``. The ``questions`` / ``checklists`` rows are the
DRAFT: admins edit it freely and nothing an interview reads changes. Publishing checks the draft
is complete (every enabled question has a rubric whose weights sum to 100) and freezes it as one
:class:`BankVersion`: the questions and their rubric together. An interview pins a published
version at start and every read that decides what is asked or how it is scored goes through
:func:`interview_questions` / :func:`rubric_rows`, which serve that version.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Sequence
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.interview.questions import Question, parse_points
from app.models.bank_version import BANK_VERSION_REASONS, BankVersion
from app.models.checklist import Checklist, ChecklistItem
from app.models.question import Question as QuestionRow
from app.models.question import QuestionBank
from app.models.sop import SopDocument

logger = logging.getLogger(__name__)

# What a frozen rubric item keeps: everything scoring, the coverage audit and the citation guard
# read, plus the cited document's NAME so an old report can say what it cited even if the document
# is later replaced (spec: SOP document id AND name).
ITEM_FIELDS = (
    "id",
    "kind",
    "text",
    "weight",
    "advisory",
    "source_quote",
    "source_document_id",
    "source_page",
    "order_index",
)


@dataclass(frozen=True)
class RubricRow:
    """One rubric item as a reader sees it, from a version or (legacy) from the draft."""

    item_id: str
    kind: str
    text: str
    weight: int
    advisory: bool
    source_quote: str
    source_document_id: str | None
    source_page: str | None
    order_index: int


@dataclass(frozen=True)
class PublishProblem:
    """Why a draft cannot be published. ``question_no`` is 1-based in the draft's ask order."""

    code: str  # no_questions | no_rubric | weights
    question_no: int | None = None
    question_text: str = ""
    weights_sum: int | None = None


@dataclass
class PublishResult:
    version: BankVersion | None
    created: bool = False
    problems: list[PublishProblem] = field(default_factory=list)


def _row_from(item: dict) -> RubricRow:
    return RubricRow(
        item_id=str(item.get("id", "")),
        kind=str(item.get("kind", "")),
        text=str(item.get("text", "")),
        weight=int(item.get("weight", 0)),
        advisory=bool(item.get("advisory", False)),
        source_quote=str(item.get("source_quote", "")),
        source_document_id=item.get("source_document_id") or None,
        source_page=item.get("source_page") or None,
        order_index=int(item.get("order_index", 0)),
    )


# A version never changes once written, so its parsed content is cached by id. Asking, scoring,
# the coverage audit, the citation guard and every judge call read it; without the cache each read
# re-parsed the whole bank.
_PARSED: dict[str, list[dict]] = {}
_PARSED_MAX = 256


def questions_of(version: BankVersion) -> list[dict]:
    """The version's questions in ask order, each with its ``rubric`` list."""
    key = f"{version.id}:{version.content_hash}"
    parsed = _PARSED.get(key)
    if parsed is None:
        if len(_PARSED) >= _PARSED_MAX:
            _PARSED.clear()
        parsed = _PARSED[key] = json.loads(version.content_json).get("questions", [])
    return parsed


def _question_by_id(version: BankVersion) -> dict[str, dict]:
    return {q["id"]: q for q in questions_of(version)}


def _item_dict(row: ChecklistItem, document_names: dict[str, str]) -> dict:
    item = {f: getattr(row, f) for f in ITEM_FIELDS}
    item["source_document_name"] = document_names.get(row.source_document_id or "")
    return item


async def draft_content(db: AsyncSession, bank_id: str) -> dict:
    """The bank's draft as a version's content: every question in ask order with its rubric.

    A handful of queries for the whole bank, whatever its size. Must build exactly what the
    migration builds (``f3a4b5c6d7e8_bank_versions._draft_content``), or the first publish after
    the upgrade would mint a version for an unchanged bank.
    """
    bank = await db.get(QuestionBank, bank_id)
    bank_language = (bank.language if bank else "") or "en-US"
    questions = (
        (
            await db.execute(
                select(QuestionRow)
                .where(QuestionRow.bank_id == bank_id)
                .order_by(QuestionRow.order_index, QuestionRow.id)
            )
        )
        .scalars()
        .all()
    )
    checklist_of: dict[str, str] = {}
    if questions:
        rows = (
            await db.execute(
                select(Checklist.id, Checklist.question_id)
                .where(
                    Checklist.question_id.in_([q.id for q in questions]),
                    Checklist.is_default.is_(True),
                )
                .order_by(Checklist.created_at.desc())
            )
        ).all()
        # One default per question (uq_one_default_checklist_per_question); newest wins otherwise.
        for checklist_id, question_id in rows:
            checklist_of.setdefault(question_id, checklist_id)
    items: list[ChecklistItem] = []
    if checklist_of:
        items = list(
            (
                await db.execute(
                    select(ChecklistItem)
                    .where(ChecklistItem.checklist_id.in_(set(checklist_of.values())))
                    .order_by(ChecklistItem.order_index, ChecklistItem.id)
                )
            )
            .scalars()
            .all()
        )
    doc_ids = {i.source_document_id for i in items if i.source_document_id}
    names: dict[str, str] = {}
    if doc_ids:
        rows = (
            await db.execute(
                select(SopDocument.id, SopDocument.name).where(SopDocument.id.in_(doc_ids))
            )
        ).all()
        names = {doc_id: name for doc_id, name in rows}
    by_checklist: dict[str, list[dict]] = {}
    for item in items:
        by_checklist.setdefault(item.checklist_id, []).append(_item_dict(item, names))
    return {
        "questions": [
            {
                "id": q.id,
                "text": q.text,
                "language": q.language or bank_language,
                "order_index": q.order_index,
                "enabled": bool(q.enabled),
                "weight": q.weight,
                "expected_points": list(parse_points(q.expected_points)),
                "max_follow_ups": q.max_follow_ups,
                "follow_up_prompt": q.follow_up_prompt,
                "rubric": by_checklist.get(checklist_of.get(q.id, ""), []),
            }
            for q in questions
        ]
    }


def _hash(content: dict) -> str:
    """Hash without rubric-item row ids: the editor replaces every item row on each save, so two
    identical rubrics would otherwise never hash alike and every unchanged publish would mint one.
    Question ids stay in: answers are joined to questions by id."""
    stripped = [
        {**q, "rubric": [{k: v for k, v in it.items() if k != "id"} for it in q["rubric"]]}
        for q in content["questions"]
    ]
    key = json.dumps(stripped, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def publish_problems(content: dict) -> list[PublishProblem]:
    """Why this content is not a complete interview, or [] when it is.

    Complete = at least one enabled question, and every enabled question has a rubric whose
    weights sum to 100 (forbidden items carry 0, as the editor normalizes them).
    """
    enabled = [q for q in content["questions"] if q["enabled"]]
    if not enabled:
        return [PublishProblem(code="no_questions")]
    problems: list[PublishProblem] = []
    for no, q in enumerate(enabled, start=1):
        rubric = q["rubric"]
        if not rubric:
            problems.append(PublishProblem("no_rubric", no, q["text"]))
            continue
        total = sum(int(it["weight"]) for it in rubric)
        if total != 100:
            problems.append(PublishProblem("weights", no, q["text"], weights_sum=total))
    return problems


async def latest(db: AsyncSession, bank_id: str) -> BankVersion | None:
    """The bank's latest published version."""
    return (
        await db.execute(
            select(BankVersion)
            .where(BankVersion.bank_id == bank_id)
            .order_by(BankVersion.version_no.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def get(db: AsyncSession, version_id: str) -> BankVersion | None:
    return await db.get(BankVersion, version_id)


async def list_versions(db: AsyncSession, bank_id: str) -> Sequence[BankVersion]:
    """The bank's published versions, newest first."""
    return (
        (
            await db.execute(
                select(BankVersion)
                .where(BankVersion.bank_id == bank_id)
                .order_by(BankVersion.version_no.desc())
            )
        )
        .scalars()
        .all()
    )


async def has_unpublished_changes(db: AsyncSession, bank_id: str) -> bool:
    """Whether the draft differs from the latest published version (True when there is none)."""
    current = await latest(db, bank_id)
    return current is None or current.content_hash != _hash(await draft_content(db, bank_id))


async def publish(
    db: AsyncSession, bank_id: str, *, reason: str = "publish", created_by: str | None = None
) -> PublishResult:
    """Freeze the bank's draft as a new version, if it is complete and differs from the latest.

    Returns the problems (and no version) when the draft is incomplete; the latest version with
    ``created=False`` when the draft is unchanged. Commits.
    """
    if reason not in BANK_VERSION_REASONS:
        raise ValueError(f"Unknown bank version reason: {reason!r}")
    content = await draft_content(db, bank_id)
    problems = publish_problems(content)
    if problems:
        return PublishResult(version=None, problems=problems)
    content_hash = _hash(content)
    bank = await db.get(QuestionBank, bank_id)
    for attempt in range(2):
        current = await latest(db, bank_id)
        if current is not None and current.content_hash == content_hash:
            return PublishResult(version=current, created=False)
        version = BankVersion(
            bank_id=bank_id,
            version_no=(current.version_no if current else 0) + 1,
            bank_name=bank.name if bank else "",
            content_json=json.dumps(content, ensure_ascii=False),
            content_hash=content_hash,
            reason=reason,
            created_by=created_by,
        )
        db.add(version)
        try:
            await db.commit()
        except IntegrityError:
            # A concurrent publish of this bank took the number first; recompute once from the new
            # latest (which may already be identical to ours).
            await db.rollback()
            if attempt:
                raise
            continue
        await db.refresh(version)
        return PublishResult(version=version, created=True)
    raise RuntimeError("unreachable")  # pragma: no cover


async def resolve_for_start(
    db: AsyncSession, bank_id: str | None, assigned_version_id: str | None
) -> str | None:
    """Which version a new interview on ``bank_id`` pins: the assigned one when it is a version of
    this bank, else the bank's latest published one. None when the bank has none (the interview
    then reads the draft, as before versioning) or there is no bank."""
    if bank_id is None:
        return None
    if assigned_version_id:
        assigned = await get(db, assigned_version_id)
        if assigned is not None and assigned.bank_id == bank_id:
            return assigned.id
    current = await latest(db, bank_id)
    if current is None:
        logger.warning("Bank %s has no published version; the interview reads its draft", bank_id)
        return None
    return current.id


def interview_questions(version: BankVersion) -> tuple[Question, ...]:
    """The questions an interview on this version asks, in order (enabled ones only)."""
    return tuple(
        Question(
            id=q["id"],
            prompt=q["text"],
            max_follow_ups=int(q.get("max_follow_ups", 0)),
            follow_up_prompt=q.get("follow_up_prompt") or Question.follow_up_prompt,
            expected_points=tuple(str(p) for p in q.get("expected_points", [])),
            weight=int(q.get("weight", 1)),
            language=q.get("language") or "en-US",
        )
        for q in questions_of(version)
        if q.get("enabled", True)
    )


async def rubric_rows(
    db: AsyncSession, *, question_id: str, bank_version_id: str | None
) -> list[RubricRow]:
    """One question's rubric items: from the pinned version, or — for an interview with no version
    (started before versioning, or on a bank never published) — from the draft."""
    if bank_version_id:
        version = await get(db, bank_version_id)
        if version is not None:
            question = _question_by_id(version).get(question_id)
            items = question["rubric"] if question else []
            if not items:
                logger.info(
                    "Bank version %s has no rubric for question %s", version.id, question_id
                )
            return sorted((_row_from(it) for it in items), key=lambda r: r.order_index)
        logger.warning("Bank version %s is gone; reading the draft rubric", bank_version_id)

    from app.services import checklist_service

    checklist = await checklist_service.get_default_checklist(db, question_id)
    if checklist is None:
        return []
    return [
        _row_from({f: getattr(r, f) for f in ITEM_FIELDS})
        for r in await checklist_service.list_items(db, checklist.id)
    ]


def question_count(version: BankVersion) -> int:
    """How many questions an interview on this version asks."""
    return sum(1 for q in questions_of(version) if q.get("enabled", True))


async def version_numbers(db: AsyncSession, version_ids: set[str]) -> dict[str, int]:
    """``{version_id: version_no}`` for the given ids (for list views)."""
    if not version_ids:
        return {}
    rows = (
        await db.execute(
            select(BankVersion.id, BankVersion.version_no).where(BankVersion.id.in_(version_ids))
        )
    ).all()
    return {vid: no for vid, no in rows}
