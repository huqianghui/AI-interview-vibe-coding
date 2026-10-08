"""Rubric versions: freeze a bank's rubric, pick one for an interview, read rubric items through it.

Spec: ``docs/planning/spec-rubric-versioning.md``. The ``checklists`` rows stay the editable
working copy; a :class:`RubricVersion` is a frozen copy of the whole bank's rubric. Every rubric
READ that decides a score goes through :func:`rubric_rows`, which serves the interview's pinned
version, so an edit made after an interview started can never change how it is scored.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.question import Question
from app.models.rubric_version import RUBRIC_VERSION_REASONS, RubricVersion

logger = logging.getLogger(__name__)

# What a frozen item keeps: everything scoring, the coverage audit and the citation guard read.
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
    """One rubric item as a reader sees it, from a version or (legacy) from the live checklist."""

    item_id: str
    kind: str
    text: str
    weight: int
    advisory: bool
    source_quote: str
    source_document_id: str | None
    source_page: str | None
    order_index: int


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


def questions_of(version: RubricVersion) -> dict[str, list[dict]]:
    """The version's ``{question_id: [item, ...]}`` map."""
    return json.loads(version.content_json).get("questions", {})


async def _bank_content(db: AsyncSession, bank_id: str) -> dict:
    """The bank's current rubric (each question's default checklist), in a stable order."""
    from app.services import checklist_service

    question_ids = (
        (
            await db.execute(
                select(Question.id).where(Question.bank_id == bank_id).order_by(Question.id)
            )
        )
        .scalars()
        .all()
    )
    questions: dict[str, list[dict]] = {}
    for qid in question_ids:
        checklist = await checklist_service.get_default_checklist(db, qid)
        if checklist is None:
            continue
        rows = await checklist_service.list_items(db, checklist.id)
        if rows:
            questions[qid] = [{f: getattr(r, f) for f in ITEM_FIELDS} for r in rows]
    return {"questions": questions}


def _hash(content_json: str) -> str:
    return hashlib.sha256(content_json.encode("utf-8")).hexdigest()


def _content_key(content: dict) -> str:
    """The hashed form. Item row ids are left out: the editor replaces every row on each save, so
    two identical rubrics would otherwise never hash alike and every no-op save would mint one."""
    stripped = {
        qid: [{k: v for k, v in it.items() if k != "id"} for it in items]
        for qid, items in content["questions"].items()
    }
    return json.dumps(stripped, sort_keys=True, ensure_ascii=False)


async def latest(db: AsyncSession, bank_id: str) -> RubricVersion | None:
    return (
        await db.execute(
            select(RubricVersion)
            .where(RubricVersion.bank_id == bank_id)
            .order_by(RubricVersion.version_no.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def get(db: AsyncSession, version_id: str) -> RubricVersion | None:
    return await db.get(RubricVersion, version_id)


async def list_versions(db: AsyncSession, bank_id: str) -> Sequence[RubricVersion]:
    """The bank's versions, newest first."""
    return (
        (
            await db.execute(
                select(RubricVersion)
                .where(RubricVersion.bank_id == bank_id)
                .order_by(RubricVersion.version_no.desc())
            )
        )
        .scalars()
        .all()
    )


async def snapshot(
    db: AsyncSession, bank_id: str, *, reason: str, created_by: str | None = None
) -> RubricVersion:
    """Freeze the bank's current rubric as a new version, unless it equals the latest one.

    Commits. Callers run it after their own rubric write has committed.
    """
    if reason not in RUBRIC_VERSION_REASONS:
        raise ValueError(f"Unknown rubric version reason: {reason!r}")
    content = await _bank_content(db, bank_id)
    content_hash = _hash(_content_key(content))
    for attempt in range(2):
        current = await latest(db, bank_id)
        if current is not None and current.content_hash == content_hash:
            return current
        version = RubricVersion(
            bank_id=bank_id,
            version_no=(current.version_no if current else 0) + 1,
            content_json=json.dumps(content, ensure_ascii=False),
            content_hash=content_hash,
            reason=reason,
            created_by=created_by,
        )
        db.add(version)
        try:
            await db.commit()
        except IntegrityError:
            # A concurrent snapshot of this bank took the number first; recompute once from the
            # new latest (which may already be identical to ours).
            await db.rollback()
            if attempt:
                raise
            continue
        await db.refresh(version)
        return version
    raise RuntimeError("unreachable")  # pragma: no cover


async def snapshot_for_question(
    db: AsyncSession, question_id: str, *, reason: str, created_by: str | None = None
) -> RubricVersion | None:
    """:func:`snapshot` for the bank this question belongs to (None for an unknown question)."""
    bank_id = (
        await db.execute(select(Question.bank_id).where(Question.id == question_id))
    ).scalar_one_or_none()
    if bank_id is None:
        return None
    return await snapshot(db, bank_id, reason=reason, created_by=created_by)


async def latest_for_question(db: AsyncSession, question_id: str) -> RubricVersion | None:
    """The latest version of the bank this question belongs to."""
    bank_id = (
        await db.execute(select(Question.bank_id).where(Question.id == question_id))
    ).scalar_one_or_none()
    return await latest(db, bank_id) if bank_id else None


async def ensure_latest(db: AsyncSession, bank_id: str) -> RubricVersion:
    """The bank's latest version, creating the first one if the bank has none yet."""
    return await latest(db, bank_id) or await snapshot(db, bank_id, reason="initial")


async def resolve_for_start(
    db: AsyncSession, bank_id: str | None, assigned_version_id: str | None
) -> str | None:
    """Which version a new interview on ``bank_id`` pins: the assigned one when it belongs to this
    bank, otherwise the bank's latest. None only when there is no bank at all."""
    if bank_id is None:
        return None
    if assigned_version_id:
        assigned = await get(db, assigned_version_id)
        if assigned is not None and assigned.bank_id == bank_id:
            return assigned.id
    return (await ensure_latest(db, bank_id)).id


async def rubric_rows(
    db: AsyncSession, *, question_id: str, rubric_version_id: str | None
) -> list[RubricRow]:
    """One question's rubric items: from the pinned version, or — for an interview started before
    versioning (no version) — from the current default checklist. Empty when there is none."""
    if rubric_version_id:
        version = await get(db, rubric_version_id)
        if version is not None:
            items = questions_of(version).get(question_id, [])
            return sorted((_row_from(it) for it in items), key=lambda r: r.order_index)
        logger.warning("Rubric version %s is gone; reading the live checklist", rubric_version_id)

    from app.services import checklist_service

    checklist = await checklist_service.get_default_checklist(db, question_id)
    if checklist is None:
        return []
    return [
        _row_from({f: getattr(r, f) for f in ITEM_FIELDS})
        for r in await checklist_service.list_items(db, checklist.id)
    ]


def question_count(version: RubricVersion) -> int:
    return len(questions_of(version))


async def version_numbers(db: AsyncSession, version_ids: set[str]) -> dict[str, int]:
    """``{version_id: version_no}`` for the given ids (for list views)."""
    if not version_ids:
        return {}
    rows = (
        await db.execute(
            select(RubricVersion.id, RubricVersion.version_no).where(
                RubricVersion.id.in_(version_ids)
            )
        )
    ).all()
    return {vid: no for vid, no in rows}
