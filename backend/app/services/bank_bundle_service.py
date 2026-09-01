"""Question-bank bundle import/export (deploy-time bank sync).

The server runs on **ephemeral SQLite** (reseeded on every boot/redeploy) and the private-blob
seeding channel is unavailable under the MCAPS storage policy (public network access disabled). So
the only way to make the deployed server's bank match a local one is through the admin API. This
module is that channel: a full **bank bundle** — the bank, its ordered questions, and each
question's complete scoring checklist (rubric items with weights, ``advisory`` gates, and SOP
source attribution) — serialized as pure data and re-materialized on the server atomically.

Why not the existing per-resource admin routes: ``POST /admin/question-banks/{id}/questions``
auto-drafts a checklist from the question text (an LLM guess, non-deterministic), and
``PUT /admin/checklists/{id}/items`` silently drops ``advisory`` and ``source_document_id`` — so
neither can reproduce a hand-authored rubric faithfully. This importer writes the rubric verbatim.

**SOP source resolution.** A checklist item's ``source_document_id`` is a per-DB uuid that differs
between local and server, so a bundle carries the item's ``source_document_name`` (the SOP
filename) instead. On import we resolve name → the server's own ``SopDocument.id`` from documents
uploaded separately (via ``POST /admin/sop/documents``); an unresolved name degrades gracefully to
no citation link (scoring is unaffected — ``source_document_id`` is nullable and never enters the
weighted score). The bundle format carries no raw SOP bodies; documents travel through the SOP
upload endpoint, keeping this payload small and the two channels decoupled.

Idempotent by name: importing a bundle whose bank name already exists replaces that bank (its
questions + checklists are deleted first), so re-running converges rather than duplicating.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.interview.checklist_draft import ChecklistDraft, DraftItem, normalize_weights
from app.models.checklist import Checklist, ChecklistItem
from app.models.question import Question, QuestionBank
from app.models.sop import SopDocument
from app.services import checklist_service, question_service


@dataclass
class ImportResult:
    """What an import did — surfaced to the admin/script so a sync is auditable."""

    bank_id: str
    bank_name: str
    replaced: bool
    question_count: int
    checklist_item_count: int
    # SOP filenames referenced by rubric items that had no matching document on the server. Not an
    # error (the citation link is simply omitted), but reported so the operator can upload the docs.
    unresolved_sop_names: list[str] = field(default_factory=list)


async def export_bank_bundle(db: AsyncSession, bank_id: str) -> dict:
    """Serialize a bank + its questions + checklists to a JSON-able bundle dict.

    Rubric items carry ``source_document_name`` (resolved from the item's ``source_document_id``)
    rather than the id, so the bundle is portable across DBs. Raises if the bank does not exist.
    """
    bank = (
        await db.execute(select(QuestionBank).where(QuestionBank.id == bank_id))
    ).scalar_one_or_none()
    if bank is None:
        raise ValueError(f"Question bank {bank_id!r} not found")

    # Build a doc-id → name map once so item serialization is a lookup, not a query per item.
    doc_names: dict[str, str] = {
        str(i): str(n)
        for i, n in (await db.execute(select(SopDocument.id, SopDocument.name))).all()
    }

    questions = (
        (
            await db.execute(
                select(Question).where(Question.bank_id == bank_id).order_by(Question.order_index)
            )
        )
        .scalars()
        .all()
    )

    q_bundles: list[dict] = []
    for q in questions:
        checklist = await checklist_service.get_default_checklist(db, q.id)
        items: list[dict] = []
        if checklist is not None:
            for it in await checklist_service.list_items(db, checklist.id):
                items.append(
                    {
                        "kind": it.kind,
                        "text": it.text,
                        "weight": it.weight,
                        "advisory": it.advisory,
                        "source_quote": it.source_quote,
                        "source_page": it.source_page,
                        "source_document_name": (
                            doc_names.get(it.source_document_id) if it.source_document_id else None
                        ),
                        "order_index": it.order_index,
                    }
                )
        q_bundles.append(
            {
                "text": q.text,
                "language": q.language,
                "weight": q.weight,
                "expected_points": _loads_points(q.expected_points),
                "max_follow_ups": q.max_follow_ups,
                "follow_up_prompt": q.follow_up_prompt,
                "enabled": q.enabled,
                "checklist": {
                    "prompt_version": checklist.prompt_version if checklist else "imported_v1",
                    "items": items,
                },
            }
        )

    return {
        "format_version": 1,
        "bank": {
            "name": bank.name,
            "description": bank.description,
            "language": bank.language,
            "is_default": bank.is_default,
        },
        "questions": q_bundles,
    }


async def import_bank_bundle(db: AsyncSession, bundle: dict) -> ImportResult:
    """Create (or replace by name) a bank + questions + checklists from a bundle dict.

    Atomic: everything is written in one transaction and committed once at the end, so a failure
    leaves the DB untouched rather than half-imported. Returns an :class:`ImportResult`.
    """
    bank_spec = bundle.get("bank")
    if not isinstance(bank_spec, dict) or not str(bank_spec.get("name", "")).strip():
        raise ValueError("bundle.bank.name is required")
    questions = bundle.get("questions")
    if not isinstance(questions, list):
        raise ValueError("bundle.questions must be a list")

    name = str(bank_spec["name"]).strip()
    is_default = bool(bank_spec.get("is_default", False))

    # Server-side SOP name → id map for citation resolution (documents uploaded separately).
    doc_ids: dict[str, str] = {
        n: i for i, n in (await db.execute(select(SopDocument.id, SopDocument.name))).all()
    }
    unresolved: set[str] = set()

    # Idempotent-by-name: drop any existing bank of the same name (with its questions/checklists)
    # so a re-import replaces rather than duplicates.
    existing = (
        await db.execute(select(QuestionBank).where(QuestionBank.name == name))
    ).scalar_one_or_none()
    replaced = existing is not None
    if existing is not None:
        await _delete_bank_cascade(db, existing.id)

    # If this bank will be the enabled default, demote any current default first (single-default
    # invariant is DB-enforced; clear the slot before claiming it).
    if is_default:
        await question_service._clear_enabled_default_banks(db, exclude_id=None)
        await db.flush()

    bank = QuestionBank(
        name=name,
        description=str(bank_spec.get("description", "")),
        language=str(bank_spec.get("language", "en-US")),
        enabled=True,
        is_default=is_default,
    )
    db.add(bank)
    await db.flush()  # assign bank.id

    total_items = 0
    for order_index, q in enumerate(questions):
        if not isinstance(q, dict) or not str(q.get("text", "")).strip():
            continue
        question = Question(
            bank_id=bank.id,
            text=str(q["text"]).strip(),
            order_index=order_index,
            language=str(q.get("language", bank.language)),
            weight=int(q.get("weight", 1)),
            expected_points=json.dumps(list(q.get("expected_points", [])), ensure_ascii=False),
            enabled=bool(q.get("enabled", True)),
            max_follow_ups=int(q.get("max_follow_ups", 0)),
            follow_up_prompt=str(
                q.get("follow_up_prompt", "Can you walk me through that in a bit more detail?")
            ),
        )
        db.add(question)
        await db.flush()  # assign question.id before its checklist

        checklist_spec = q.get("checklist") or {}
        raw_items = checklist_spec.get("items") or []
        items, item_unresolved = _draft_items_from_bundle(raw_items, doc_ids)
        unresolved.update(item_unresolved)
        if items:
            normalize_weights(items)
            draft = ChecklistDraft(
                prompt_version=str(checklist_spec.get("prompt_version", "imported_v1")),
                items=items,
            )
            await checklist_service._persist_draft(db, question.id, draft)
            total_items += len(items)

    await db.commit()
    await db.refresh(bank)
    return ImportResult(
        bank_id=bank.id,
        bank_name=bank.name,
        replaced=replaced,
        question_count=len(
            [q for q in questions if isinstance(q, dict) and str(q.get("text", "")).strip()]
        ),
        checklist_item_count=total_items,
        unresolved_sop_names=sorted(unresolved),
    )


def _draft_items_from_bundle(
    raw_items: list, doc_ids: dict[str, str]
) -> tuple[list[DraftItem], set[str]]:
    """Turn bundle rubric-item dicts into :class:`DraftItem`s, resolving SOP names → ids.

    Unlike ``parse_draft_items`` (which drops ``advisory`` unless the LLM marks it and never carries
    a document id), this preserves the hand-authored ``advisory`` gate and binds each item to the
    server's own SOP document id by name. Invalid rows (bad kind / empty text) are skipped. Returns
    the items and the set of SOP names that could not be resolved on this server.
    """
    from app.models.checklist import CHECKLIST_ITEM_KINDS

    items: list[DraftItem] = []
    unresolved: set[str] = set()
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        kind = str(raw.get("kind", "")).strip().lower()
        text = str(raw.get("text", "")).strip()
        if kind not in CHECKLIST_ITEM_KINDS or not text:
            continue
        doc_name = raw.get("source_document_name")
        doc_id: str | None = None
        if doc_name:
            doc_id = doc_ids.get(doc_name)
            if doc_id is None:
                unresolved.add(str(doc_name))
        items.append(
            DraftItem(
                kind=kind,
                text=text,
                weight=int(raw.get("weight", 0) or 0),
                source_quote=str(raw.get("source_quote", "") or ""),
                source_document_id=doc_id,
                source_page=(str(raw["source_page"]) if raw.get("source_page") else None),
                order_index=len(items),
                advisory=bool(raw.get("advisory", False)) and kind == "forbidden",
            )
        )
    return items, unresolved


async def _delete_bank_cascade(db: AsyncSession, bank_id: str) -> None:
    """Delete a bank + all its questions + their checklists/items (SQLite has no cascade here)."""
    q_ids = (
        (await db.execute(select(Question.id).where(Question.bank_id == bank_id))).scalars().all()
    )
    for qid in q_ids:
        cl_ids = (
            (await db.execute(select(Checklist.id).where(Checklist.question_id == qid)))
            .scalars()
            .all()
        )
        for cid in cl_ids:
            await db.execute(delete(ChecklistItem).where(ChecklistItem.checklist_id == cid))
        await db.execute(delete(Checklist).where(Checklist.question_id == qid))
    await db.execute(delete(Question).where(Question.bank_id == bank_id))
    await db.execute(delete(QuestionBank).where(QuestionBank.id == bank_id))
    await db.flush()


def _loads_points(raw: str) -> list[str]:
    try:
        v = json.loads(raw)
        return [str(p) for p in v] if isinstance(v, list) else []
    except (ValueError, TypeError):
        return []
