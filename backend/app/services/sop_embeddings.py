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
from sqlalchemy.exc import IntegrityError
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
# A unit refused at that length (a big HTML table or Chinese text can pass 8,191 tokens): tried
# again alone, cut to this.
RETRY_INPUT_CHARS = 6_000
TIMEOUT_SECONDS = 60.0
_RETRIES = 3


def enabled() -> bool:
    settings = get_settings()
    return bool(settings.azure_foundry_endpoint and settings.sop_embedding_deployment)


_KEY_MAX = 120


def unit_key(unit: Unit) -> str:
    """A unit's citation as a key: "section|through|own|piece" (a key too long for the column,
    from a long heading number, is shortened with a hash so it stays unique)."""
    section, through, own, piece = unit.citation()
    key = f"{section}|{through}|{int(own)}|{piece}"
    if len(key) <= _KEY_MAX:
        return key
    return f"{key[: _KEY_MAX - 41]}#{hashlib.sha256(key.encode()).hexdigest()[:40]}"


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


# Query vectors fetched ahead (``prefetch``): a relocation run asks one query per rubric item, and
# one batched call beats one call per item. Small and bounded; texts repeat within a run.
_QUERY_CACHE: dict[str, list[float]] = {}
_QUERY_CACHE_MAX = 512


async def prefetch(texts: Sequence[str]) -> None:
    """Embed many search queries in one batched call, for :func:`embed_query` to find."""
    todo = [t for t in dict.fromkeys(texts) if t.strip() and t not in _QUERY_CACHE]
    if not enabled() or not todo:
        return
    try:
        vectors = await embed(todo)
    except Exception:  # noqa: BLE001 — each query then tries on its own (and falls back)
        logger.warning("Embedding %d search queries failed", len(todo), exc_info=True)
        return
    if len(_QUERY_CACHE) + len(todo) > _QUERY_CACHE_MAX:
        _QUERY_CACHE.clear()
    _QUERY_CACHE.update(zip(todo, vectors, strict=True))


async def embed_query(text: str) -> list[float] | None:
    """The query's vector, or None (embeddings off, or the call failed: keywords alone then)."""
    if not enabled() or not text.strip():
        return None
    if text in _QUERY_CACHE:
        return _QUERY_CACHE[text]
    try:
        (vector,) = await embed([text])
        return vector
    except Exception as exc:  # noqa: BLE001 — search must still answer: by keywords alone
        logger.warning("Embedding a search query failed (%s); keywords only", type(exc).__name__)
        return None


async def _embed_each(texts: Sequence[str]) -> list[list[float] | None]:
    """Vectors for one batch; if the batch is refused, each text alone, shorter. A text that still
    fails gets None (skipped), so one bad unit never costs a document all its vectors."""
    try:
        return list(await embed(texts))
    except Exception:  # noqa: BLE001 — retried one by one below
        logger.warning("An embedding batch of %d failed; trying each alone", len(texts))
    out: list[list[float] | None] = []
    for text in texts:
        try:
            (vector,) = await embed([text[:RETRY_INPUT_CHARS]])
            out.append(vector)
        except Exception:  # noqa: BLE001 — skipped: this unit is searched by keywords
            logger.warning("Embedding one SOP unit failed; it is searched by keywords only")
            out.append(None)
    return out


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
    model = get_settings().sop_embedding_deployment
    # A vector from another model is in another space: it is replaced, never compared.
    have = {(e.unit_key, e.text_hash) for e in stored if e.model == model}
    stale = [e.id for e in stored if (e.unit_key, e.text_hash) not in wanted or e.model != model]
    missing = [(key, u) for key, u in wanted.items() if key not in have]
    await db.commit()  # reads done: no pooled connection waits on the embedding calls
    if stale:
        await db.execute(delete(SopUnitEmbedding).where(SopUnitEmbedding.id.in_(stale)))
        await db.commit()
    embedded = 0
    # Stored batch by batch: what was embedded stays even if a later batch fails.
    for start in range(0, len(missing), BATCH):
        batch = missing[start : start + BATCH]
        vectors = await _embed_each([u.text for _, u in batch])
        for ((key, digest), _), vector in zip(batch, vectors, strict=True):
            if vector is None:
                continue
            db.add(
                SopUnitEmbedding(
                    document_id=document_id,
                    unit_key=key,
                    text_hash=digest,
                    model=model,
                    vector=json.dumps(vector),
                )
            )
            embedded += 1
        try:
            await db.commit()
        except IntegrityError:
            # Another replica stored the same units first (two boots at once): theirs stand.
            await db.rollback()
    return embedded


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
        ).where(
            SopUnitEmbedding.document_id.in_(ids),
            SopUnitEmbedding.model == get_settings().sop_embedding_deployment,
        )
    )
    return {(d, k, h): json.loads(v) for d, k, h, v in rows.all()}
