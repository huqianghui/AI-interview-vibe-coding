"""Embeddings of SOP units for hybrid search (owner, 2026-10-09: option B, a plain column with
the backend doing the math; the ranking is in ``sop_search``).

Each unit (``app.sop.units``: what the SOP tab shows and a citation names) is embedded once per
text: a row keeps the unit's citation key and a hash of its text, so a re-split re-embeds only
the units whose text changed, and rows of units that no longer exist are removed. The model is
the ``SOP_EMBEDDING_DEPLOYMENT`` on the Foundry resource, called with the managed identity (the
resource has key auth disabled). Without an endpoint or a deployment nothing is embedded and
search is by keywords alone.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from collections.abc import Iterable, Sequence

import httpx
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.sop import SopDocument, SopSection, SopUnitEmbedding
from app.services import azure_auth
from app.sop.units import Unit, units

logger = logging.getLogger(__name__)

# Inputs per request, and the characters kept of one input: text-embedding-3-small reads 8,191
# tokens, and a unit is at most 4,000 characters except a big table (one is 64,000, mostly HTML).
BATCH = 16
MAX_INPUT_CHARS = 20_000
TIMEOUT_SECONDS = 60.0
_RETRIES = 3


def enabled() -> bool:
    settings = get_settings()
    return bool(settings.azure_foundry_endpoint and settings.sop_embedding_deployment)


def unit_key(unit: Unit) -> str:
    """A unit's citation as a key: "section|through|own|piece"."""
    section, through, own, piece = unit.citation()
    return f"{section}|{through}|{int(own)}|{piece}"


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


async def embed(texts: Sequence[str]) -> list[list[float]]:
    """One vector per text, in order. Raises on a failed call (after retrying throttling)."""
    settings = get_settings()
    url = (
        f"{settings.azure_foundry_endpoint.rstrip('/')}/openai/deployments/"
        f"{settings.sop_embedding_deployment}/embeddings"
        f"?api-version={settings.sop_embedding_api_version}"
    )
    out: list[list[float]] = []
    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
        for start in range(0, len(texts), BATCH):
            batch = [t[:MAX_INPUT_CHARS] or " " for t in texts[start : start + BATCH]]
            token = await azure_auth.get_bearer_token(azure_auth.COGNITIVE_SERVICES_SCOPE)
            if not token:
                raise RuntimeError("no Azure credential for the embedding model")
            response: httpx.Response | None = None
            for attempt in range(_RETRIES):
                response = await client.post(
                    url, headers={"Authorization": f"Bearer {token}"}, json={"input": batch}
                )
                if response.status_code != 429 or attempt == _RETRIES - 1:
                    break
                await asyncio.sleep(float(response.headers.get("retry-after", 2 * (attempt + 1))))
            assert response is not None
            response.raise_for_status()
            data = sorted(response.json()["data"], key=lambda d: d["index"])
            out += [d["embedding"] for d in data]
    return out


async def embed_query(text: str) -> list[float] | None:
    """The query's vector, or None (embeddings off, or the call failed: keywords alone then)."""
    if not enabled() or not text.strip():
        return None
    try:
        (vector,) = await embed([text])
        return vector
    except Exception:  # noqa: BLE001 — search must still answer: by keywords alone
        logger.warning("Embedding a search query failed; searching by keywords only", exc_info=True)
        return None


async def refresh(db: AsyncSession, document_id: str) -> int:
    """Embed the document's units that have no vector for their current text, and remove the rows
    of units that no longer exist. Commits; returns how many units were embedded."""
    if not enabled():
        return 0
    rows = (
        (
            await db.execute(
                select(SopSection)
                .where(SopSection.document_id == document_id)
                .order_by(SopSection.order_index)
            )
        )
        .scalars()
        .all()
    )
    wanted = {(unit_key(u), text_hash(u.text)): u for u in units(rows)}
    stored = (
        (
            await db.execute(
                select(SopUnitEmbedding).where(SopUnitEmbedding.document_id == document_id)
            )
        )
        .scalars()
        .all()
    )
    have = {(e.unit_key, e.text_hash) for e in stored}
    stale = [e.id for e in stored if (e.unit_key, e.text_hash) not in wanted]
    missing = [(key, u) for key, u in wanted.items() if key not in have]
    await db.commit()  # reads done: no pooled connection waits on the embedding calls
    vectors = await embed([u.text for _, u in missing]) if missing else []
    if stale:
        await db.execute(delete(SopUnitEmbedding).where(SopUnitEmbedding.id.in_(stale)))
    model = get_settings().sop_embedding_deployment
    for ((key, digest), _), vector in zip(missing, vectors, strict=True):
        db.add(
            SopUnitEmbedding(
                document_id=document_id,
                unit_key=key,
                text_hash=digest,
                model=model,
                vector=json.dumps(vector),
            )
        )
    await db.commit()
    return len(missing)


async def refresh_all(session_factory) -> int:  # noqa: ANN001 — async_sessionmaker
    """Every converted document's embeddings brought up to date, each in its own session; a
    failure is logged and the next document still runs. Never raises."""
    if not enabled():
        return 0
    total = 0
    try:
        async with session_factory() as db:
            ids = (
                (
                    await db.execute(
                        select(SopDocument.id).where(SopDocument.markdown_source != "failed")
                    )
                )
                .scalars()
                .all()
            )
        for doc_id in ids:
            try:
                async with session_factory() as db:
                    total += await refresh(db, doc_id)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 — one document must not stop the rest
                logger.warning("Embedding SOP %s failed", doc_id, exc_info=True)
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 — e.g. the database is down; the next run retries
        logger.exception("Embedding SOP documents failed")
    if total:
        logger.info("Embedded %d SOP units", total)
    return total


async def vectors_for(
    db: AsyncSession, document_ids: Iterable[str]
) -> dict[tuple[str, str, str], list[float]]:
    """``(document_id, unit_key, text_hash) → vector`` for the given documents."""
    ids = sorted(set(document_ids))
    if not ids:
        return {}
    rows = await db.execute(
        select(
            SopUnitEmbedding.document_id,
            SopUnitEmbedding.unit_key,
            SopUnitEmbedding.text_hash,
            SopUnitEmbedding.vector,
        ).where(SopUnitEmbedding.document_id.in_(ids))
    )
    return {(d, k, h): json.loads(v) for d, k, h, v in rows.all()}
