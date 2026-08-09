"""Pluggable SOP blob storage (SPEC F1).

An uploaded SOP's raw bytes are kept out of the DB (P4: candidates never get a direct blob URL —
only server-mediated citation text). The store is behind a tiny protocol so local dev writes to
disk and prod can swap an Azure Blob backend without touching the ingestion service.

Selection mirrors the agent registry: :func:`get_storage` resolves by name, defaulting to the
``local`` filesystem store. The ``azure`` blob store is coverage-omitted (needs a live account)
and registers only when a connection string is configured.
"""

from __future__ import annotations

from pathlib import Path
from typing import Protocol, runtime_checkable

from app.config import get_settings


@runtime_checkable
class BlobStore(Protocol):
    name: str

    def save(self, key: str, content: bytes) -> str:
        """Persist ``content`` under ``key``; return the resolved storage pointer (blob_path)."""
        ...

    def load(self, blob_path: str) -> bytes:
        """Read back the bytes at ``blob_path`` (server-side only — never handed to candidates)."""
        ...


class LocalBlobStore:
    """Filesystem store for local dev / CI. Writes under ``settings.material_storage_path``."""

    name = "local"

    def __init__(self, root: str) -> None:
        self._root = Path(root)

    def save(self, key: str, content: bytes) -> str:
        # Guard against a key escaping the storage root (path traversal via "../").
        safe_key = key.replace("\\", "/").lstrip("/")
        dest = (self._root / safe_key).resolve()
        if not str(dest).startswith(str(self._root.resolve())):
            raise ValueError(f"Refusing to write outside storage root: {key!r}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(content)
        return str(dest)

    def load(self, blob_path: str) -> bytes:
        return Path(blob_path).read_bytes()


_STORES: dict[str, BlobStore] = {}


def _default_root() -> str:
    return getattr(get_settings(), "material_storage_path", "") or "./_sop_storage"


def get_storage(name: str | None = None) -> BlobStore:
    """Resolve a blob store by name (default ``local``). Instances are cached per process."""
    provider = name or "local"
    if provider not in _STORES:
        if provider == "local":
            _STORES["local"] = LocalBlobStore(_default_root())
        else:
            # Unknown/unconfigured backend falls back to local rather than 500 (CI safety).
            _STORES.setdefault("local", LocalBlobStore(_default_root()))
            return _STORES["local"]
    return _STORES[provider]
