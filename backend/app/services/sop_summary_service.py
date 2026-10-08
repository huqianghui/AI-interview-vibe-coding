"""SOP key-points summaries (spec-sop-section-grounding §2, PR 2 of 3).

Each converted document gets one summary, drafted by the LLM from its WHOLE Markdown: purpose,
scope, key responsibilities, mandatory requirements. An admin edits it and approves it in the SOP
documents tab. Owner decision 2026-10-08: **only an approved summary is used in scoring**; a draft
never is (:func:`reviewed_summaries` is the one reader scoring uses).

Drafting runs in the background, after conversion (:func:`summarize_missing`, called by
``sop_section_service.build_missing`` under its lock), never in a request. Measured 2026-10-08 with
gpt-5-mini: 16-30 s per client SOP, 30 s for the largest (140k characters of Markdown), so one call
is bounded at :data:`SUMMARY_TIMEOUT_SECONDS`. With the mock LLM (dev / CI) nothing is drafted: a
canned placeholder must not look like a summary waiting for approval.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Iterable
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.sop import SopDocument
from app.services.agents.base import LLMAdapter
from app.services.agents.registry import get_llm_adapter

logger = logging.getLogger(__name__)

SUMMARY_TIMEOUT_SECONDS = 180.0
# Documents whose summary is being drafted right now, so the admin list can say so.
_DRAFTING: set[str] = set()
# A converted document has a usable Markdown; these sources mean it does not.
_NOT_CONVERTED = ("", "failed")
# Drafted when there is no summary yet, or the last draft failed (retried on the next run).
_NEEDS_SUMMARY = ("", "failed")
MAX_RESPONSIBILITIES = 8
MAX_REQUIREMENTS = 12

PROMPT = """You summarise one Standard Operating Procedure (SOP). The summary is shown to the model
that scores interview answers against this SOP, so it must state what the SOP requires, not
describe the document.

Read the WHOLE document below and return JSON only:
{{"purpose": str, "scope": str, "key_responsibilities": [str], "mandatory_requirements": [str]}}

Rules:
- Use only what the document says. Do not add good practice it does not state.
- key_responsibilities: at most {max_resp}, each one sentence naming the role and what it does.
- mandatory_requirements: at most {max_req}, each one sentence, the most important first; keep any
  time limit, threshold or approval the document gives ("within 5 working days").
- Write in the document's language.

DOCUMENT: {name}

{markdown}
"""


class SummaryError(ValueError):
    """The model's answer is not a usable summary."""


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def render(data: dict) -> str:
    """The model's JSON as the Markdown an admin reads and edits."""
    purpose = str(data.get("purpose") or "").strip()
    scope = str(data.get("scope") or "").strip()
    responsibilities = [str(x).strip() for x in data.get("key_responsibilities") or [] if x]
    requirements = [str(x).strip() for x in data.get("mandatory_requirements") or [] if x]
    if not purpose or not requirements:
        raise SummaryError("the summary has no purpose or no mandatory requirements")
    parts = [f"**Purpose:** {purpose}"]
    if scope:
        parts.append(f"**Scope:** {scope}")
    if responsibilities:
        parts.append(
            "**Key responsibilities**\n"
            + "\n".join(f"- {r}" for r in responsibilities[:MAX_RESPONSIBILITIES])
        )
    parts.append(
        "**Mandatory requirements**\n"
        + "\n".join(f"- {r}" for r in requirements[:MAX_REQUIREMENTS])
    )
    return "\n\n".join(parts)


async def draft(name: str, markdown: str, llm: LLMAdapter) -> str:
    prompt = PROMPT.format(
        max_resp=MAX_RESPONSIBILITIES, max_req=MAX_REQUIREMENTS, name=name, markdown=markdown
    )
    raw = await asyncio.wait_for(llm.complete(prompt, json_mode=True), SUMMARY_TIMEOUT_SECONDS)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SummaryError(f"the model did not return JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise SummaryError("the model did not return a JSON object")
    return render(data)


def drafting(document_id: str) -> bool:
    return document_id in _DRAFTING


def mark_drafting(document_id: str) -> None:
    _DRAFTING.add(document_id)


def _drafting_available(llm: LLMAdapter) -> bool:
    return getattr(llm, "name", "") != "mock"


async def generate(db: AsyncSession, document: SopDocument, llm: LLMAdapter | None = None) -> bool:
    """Draft (or redraft) the document's summary. Commits. Returns whether a draft was written.

    A redraft replaces an approved summary with a new DRAFT: it is asked for explicitly, and what
    scoring uses must be what an admin approved."""
    llm = llm or get_llm_adapter()
    if document.markdown_source in _NOT_CONVERTED or not document.markdown.strip():
        return False
    if not _drafting_available(llm):
        logger.info("No LLM configured; SOP %r summary not drafted", document.name)
        return False
    _DRAFTING.add(document.id)
    try:
        text = await draft(document.name, document.markdown, llm)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — recorded on the document, retried on the next run
        logger.warning("SOP %r summary not drafted: %s", document.name, exc)
        error = f"{type(exc).__name__}: {exc}"[:1000]
        if document.summary_status in ("draft", "reviewed"):
            # Drafting again failed: keep the summary there is, say why.
            document.summary_error = f"drafting again failed, the summary is kept: {error}"[:1000]
        else:
            document.summary_status = "failed"
            document.summary_error = error
        await db.commit()
        return False
    finally:
        _DRAFTING.discard(document.id)
    document.summary = text
    document.summary_status = "draft"
    document.summary_error = ""
    document.summary_reviewed_at = None
    await db.commit()
    logger.info("SOP %r summary drafted (%d chars)", document.name, len(text))
    return True


async def summarize_missing(session_factory, llm: LLMAdapter | None = None) -> int:  # noqa: ANN001
    """Draft a summary for every converted document that has none (or whose draft failed). Each in
    its own session; failures recorded and skipped. The caller holds the build lock."""
    llm = llm or get_llm_adapter()
    if not _drafting_available(llm):
        return 0
    async with session_factory() as db:
        ids = (
            (
                await db.execute(
                    select(SopDocument.id).where(
                        SopDocument.summary_status.in_(_NEEDS_SUMMARY),
                        SopDocument.markdown_source.not_in(_NOT_CONVERTED),
                    )
                )
            )
            .scalars()
            .all()
        )
    done = 0
    for doc_id in ids:
        try:
            async with session_factory() as db:
                document = await db.get(SopDocument, doc_id)
                if document is not None and document.summary_status in _NEEDS_SUMMARY:
                    done += await generate(db, document, llm)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — background work: log, keep going
            logger.exception("Drafting the summary of SOP %s failed", doc_id)
    return done


class SummaryNotSaved(ValueError):
    """An admin's summary edit that cannot be saved."""


async def save(db: AsyncSession, document: SopDocument, text: str, *, approve: bool) -> None:
    """An admin's edit. ``approve`` marks it reviewed (used in scoring); otherwise it is a draft,
    so editing an approved summary without approving again takes it out of scoring."""
    text = text.strip()
    if approve and not text:
        raise SummaryNotSaved("an empty summary cannot be approved")
    document.summary = text
    document.summary_status = "reviewed" if approve else ("draft" if text else "")
    document.summary_error = ""
    document.summary_reviewed_at = _now() if approve else None
    await db.commit()


async def reviewed_summaries(db: AsyncSession, document_ids: Iterable[str]) -> dict[str, str]:
    """``{document_id: summary}`` for the given documents whose summary an admin approved. The only
    way scoring reads a summary: a draft is never returned."""
    ids = sorted({d for d in document_ids if d})
    if not ids:
        return {}
    rows = await db.execute(
        select(SopDocument.id, SopDocument.summary).where(
            SopDocument.id.in_(ids), SopDocument.summary_status == "reviewed"
        )
    )
    return {doc_id: summary for doc_id, summary in rows.all() if summary.strip()}
