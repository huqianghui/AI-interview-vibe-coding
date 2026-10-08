"""Put back the bytes of SOP documents whose stored file is gone.

Why this exists: before the blob store, SOP bytes were written to the Container App's local disk,
which every new revision throws away, while PostgreSQL kept the rows. The boot importer then saw
each document as already ingested and never wrote the file again, so every report citation link
answered 404 (measured live 2026-10-08: 26 rows, 0 files).

The originals still arrive at every boot inside the private client bundle, so this boot step
matches a row to its original by file name, stores it through the configured store (Azure Blob in
production) and repoints ``blob_path``. It touches only rows whose bytes are missing, so once the
files live in blob it is a cheap no-op. A row with no original on disk is left as it is, logged.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.sop import SopDocument
from app.services import storage

logger = logging.getLogger(__name__)


def _originals_by_name(root: Path) -> dict[str, Path]:
    """Every file under ``root``, by file name (the first one wins on a duplicate name)."""
    found: dict[str, Path] = {}
    for path in sorted(root.rglob("*")):
        if path.is_file():
            found.setdefault(path.name, path)
    return found


async def repair_missing_sop_files(db: AsyncSession, source_dir: str | None = None) -> int:
    """Re-store every SOP whose bytes are missing from an original under ``source_dir``.

    Returns how many documents were repaired.
    """
    root = Path(source_dir if source_dir is not None else get_settings().sop_repair_source_dir)
    if not await asyncio.to_thread(root.is_dir):
        return 0
    docs = (await db.execute(select(SopDocument))).scalars().all()
    missing = [d for d in docs if not await asyncio.to_thread(storage.exists, d.blob_path)]
    if not missing:
        return 0

    originals = await asyncio.to_thread(_originals_by_name, root)
    store = storage.get_storage()
    repaired = 0
    for doc in missing:
        original = originals.get(doc.name)
        if original is None:
            logger.warning(
                "SOP %s (%r) has no stored bytes and no original to restore", doc.id, doc.name
            )
            continue
        content = await asyncio.to_thread(original.read_bytes)
        doc.blob_path = await asyncio.to_thread(store.save, f"{doc.id}/{doc.name}", content)
        repaired += 1
    await db.commit()
    logger.info("Restored the stored bytes of %d of %d SOP documents", repaired, len(missing))
    return repaired
