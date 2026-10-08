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

from app.models.checklist import Checklist, ChecklistItem
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


# A version never changes once written, so its parsed content is cached by id. Scoring, the
# coverage audit, the citation guard and every judge call read it once per question; without the
# cache each read re-parsed the whole bank's JSON.
_PARSED: dict[str, dict[str, list[dict]]] = {}
_PARSED_MAX = 256


def questions_of(version: RubricVersion) -> dict[str, list[dict]]:
    """The version's ``{question_id: [item, ...]}`` map."""
    key = f"{version.id}:{version.content_hash}"
    parsed = _PARSED.get(key)
    if parsed is None:
        if len(_PARSED) >= _PARSED_MAX:
            _PARSED.clear()
        parsed = _PARSED[key] = json.loads(version.content_json).get("questions", {})
    return parsed


def _item_dict(row: ChecklistItem) -> dict:
    return {f: getattr(row, f) for f in ITEM_FIELDS}


async def _bank_content(db: AsyncSession, bank_id: str) -> dict:
    """The bank's current rubric (each question's default checklist), in a stable order.

    Two queries for the whole bank, whatever its size: this runs on every rubric save, every
    interview start and every assignment. Must build exactly what the migration builds
    (``e2f3a4b5c6d7_rubric_versions._bank_content``), or the first save after it mints a version.
    """
    checklists = (
        await db.execute(
            select(Checklist.id, Checklist.question_id)
            .join(Question, Question.id == Checklist.question_id)
            .where(Question.bank_id == bank_id, Checklist.is_default.is_(True))
            .order_by(Checklist.created_at.desc())
        )
    ).all()
    # One default per question (uq_one_default_checklist_per_question); the newest wins otherwise,
    # like the migration's ORDER BY created_at DESC LIMIT 1.
    checklist_of: dict[str, str] = {}
    for checklist_id, question_id in checklists:
        checklist_of.setdefault(question_id, checklist_id)
    if not checklist_of:
        return {"questions": {}}
    rows = (
        (
            await db.execute(
                select(ChecklistItem)
                .where(ChecklistItem.checklist_id.in_(set(checklist_of.values())))
                .order_by(ChecklistItem.order_index)
            )
        )
        .scalars()
        .all()
    )
    by_checklist: dict[str, list[dict]] = {}
    for row in rows:
        by_checklist.setdefault(row.checklist_id, []).append(_item_dict(row))
    questions = {
        qid: by_checklist[cid] for qid, cid in sorted(checklist_of.items()) if by_checklist.get(cid)
    }
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


async def current(db: AsyncSession, bank_id: str) -> RubricVersion:
    """The version matching the bank's rubric as it is NOW: the latest one when nothing changed,
    otherwise a new one (``reason='sync'``).

    What assignment and interview start pin. A rubric write commits before its snapshot, so a
    snapshot that failed (or a writer that never snapshots, such as a question deletion) would
    otherwise leave "latest" behind the rubric and pin the stale one.
    """
    return await snapshot(db, bank_id, reason="sync")


async def ensure_latest(db: AsyncSession, bank_id: str) -> RubricVersion:
    """The bank's latest version, creating the first one if the bank has none yet."""
    return await latest(db, bank_id) or await snapshot(db, bank_id, reason="initial")


async def resolve_for_start(
    db: AsyncSession, bank_id: str | None, assigned_version_id: str | None
) -> str | None:
    """Which version a new interview on ``bank_id`` pins: the assigned one when it is a version of
    this bank that still describes its questions, otherwise the bank's current version. None only
    when there is no bank at all.

    "Still describes its questions": a bank re-import keeps the bank id but replaces every question
    (new ids). A version from before it is keyed by ids that no longer exist, so pinning it would
    find no rubric for any question and silently score the whole interview as unauthored.
    """
    if bank_id is None:
        return None
    if assigned_version_id:
        assigned = await get(db, assigned_version_id)
        if assigned is not None and assigned.bank_id == bank_id:
            frozen = set(questions_of(assigned))
            if not frozen or frozen & set(await _question_ids(db, bank_id)):
                return assigned.id
            logger.warning(
                "Assigned rubric version %s of bank %s no longer matches its questions (the bank "
                "was re-imported); pinning the current version instead",
                assigned.id,
                bank_id,
            )
    return (await current(db, bank_id)).id


async def _question_ids(db: AsyncSession, bank_id: str) -> list[str]:
    return list(
        (await db.execute(select(Question.id).where(Question.bank_id == bank_id))).scalars().all()
    )


async def rubric_rows(
    db: AsyncSession, *, question_id: str, rubric_version_id: str | None
) -> list[RubricRow]:
    """One question's rubric items: from the pinned version, or — for an interview started before
    versioning (no version) — from the current default checklist. Empty when there is none."""
    if rubric_version_id:
        version = await get(db, rubric_version_id)
        if version is not None:
            items = questions_of(version).get(question_id, [])
            if not items:
                # Legitimate for a question with no rubric, or one added after this version; logged
                # so a whole interview scored without a rubric is visible rather than silent.
                logger.info(
                    "Rubric version %s has no items for question %s", version.id, question_id
                )
            return sorted((_row_from(it) for it in items), key=lambda r: r.order_index)
        logger.warning("Rubric version %s is gone; reading the live checklist", rubric_version_id)

    from app.services import checklist_service

    checklist = await checklist_service.get_default_checklist(db, question_id)
    if checklist is None:
        return []
    return [_row_from(_item_dict(r)) for r in await checklist_service.list_items(db, checklist.id)]


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
