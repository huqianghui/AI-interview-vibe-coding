"""Pluggable SOP blob storage (SPEC F1).

An uploaded SOP's raw bytes are kept out of the DB (P4: candidates never get a direct blob URL —
only server-mediated citation text). The store is behind a tiny protocol so local dev writes to
disk and prod writes to Azure Blob without touching the ingestion service.

Selection: :func:`get_storage` resolves ``settings.default_storage_provider``. ``local`` (dev/CI)
writes under ``material_storage_path``; ``azure`` writes to the ``material_blob_container`` of
``azure_storage_account_url`` with the managed identity. Production MUST be ``azure``: a Container
App's disk is thrown away on every new revision while the database (PostgreSQL) keeps the row, so a
local file outlives nothing — that is exactly how every live SOP file went missing.

A ``blob_path`` is self-describing: ``blob://<container>/<key>`` for Azure, a filesystem path for
local. :func:`load` dispatches on it, so rows written before the switch still resolve to the right
place (and fail as ``FileNotFoundError`` when that place is gone, which callers answer as a 404).
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Protocol, runtime_checkable

from app.config import get_settings

logger = logging.getLogger(__name__)

BLOB_SCHEME = "blob://"


@runtime_checkable
class BlobStore(Protocol):
    name: str

    def save(self, key: str, content: bytes) -> str:
        """Persist ``content`` under ``key``; return the resolved storage pointer (blob_path)."""
        ...

    def load(self, blob_path: str) -> bytes:
        """Read back the bytes at ``blob_path`` (server-side only — never handed to candidates)."""
        ...

    def exists(self, blob_path: str) -> bool:
        """Whether ``blob_path`` still has bytes behind it."""
        ...

    def remove(self, blob_path: str) -> None:
        """Delete the bytes at ``blob_path``; nothing there is not an error."""
        ...


def _safe_key(key: str) -> str:
    """Normalise a key and refuse one that climbs out of its root ("../")."""
    safe = key.replace("\\", "/").lstrip("/")
    if any(part == ".." for part in safe.split("/")):
        raise ValueError(f"Refusing a storage key outside the store root: {key!r}")
    return safe


class LocalBlobStore:
    """Filesystem store for local dev / CI. Writes under ``settings.material_storage_path``."""

    name = "local"

    def __init__(self, root: str) -> None:
        self._root = Path(root)

    def save(self, key: str, content: bytes) -> str:
        dest = (self._root / _safe_key(key)).resolve()
        if not str(dest).startswith(str(self._root.resolve())):
            raise ValueError(f"Refusing to write outside storage root: {key!r}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(content)
        return str(dest)

    def load(self, blob_path: str) -> bytes:
        return Path(blob_path).read_bytes()

    def exists(self, blob_path: str) -> bool:
        return bool(blob_path) and Path(blob_path).is_file()

    def remove(self, blob_path: str) -> None:
        path = Path(blob_path).resolve()
        # Only a file this store wrote (under its root), never a path a damaged row points at.
        if not str(path).startswith(str(self._root.resolve())):
            raise ValueError(f"Refusing to delete outside the storage root: {blob_path!r}")
        path.unlink(missing_ok=True)


class AzureBlobStore:
    """Azure Blob container, reached keylessly with the backend's managed identity.

    The client is built on first use, so constructing the store (at import or boot) never needs a
    token. ``client`` lets tests pass a fake ``ContainerClient``.
    """

    name = "azure"

    def __init__(self, account_url: str, container: str, client=None) -> None:  # noqa: ANN001
        self._account_url = account_url
        self._container = container
        self._client = client

    def _container_client(self):  # noqa: ANN202 — azure.storage.blob.ContainerClient
        if self._client is None:
            from azure.identity import DefaultAzureCredential
            from azure.storage.blob import ContainerClient

            self._client = ContainerClient(
                account_url=self._account_url,
                container_name=self._container,
                credential=DefaultAzureCredential(),
            )
        return self._client

    def _key(self, blob_path: str) -> str:
        prefix = f"{BLOB_SCHEME}{self._container}/"
        if not blob_path.startswith(prefix):
            raise FileNotFoundError(blob_path)
        return blob_path[len(prefix) :]

    def save(self, key: str, content: bytes) -> str:
        safe = _safe_key(key)
        self._container_client().upload_blob(safe, content, overwrite=True)
        return f"{BLOB_SCHEME}{self._container}/{safe}"

    def load(self, blob_path: str) -> bytes:
        from azure.core.exceptions import ResourceNotFoundError

        try:
            return self._container_client().download_blob(self._key(blob_path)).readall()
        except ResourceNotFoundError as exc:
            raise FileNotFoundError(blob_path) from exc

    def exists(self, blob_path: str) -> bool:
        try:
            key = self._key(blob_path)
        except FileNotFoundError:
            return False
        return bool(self._container_client().get_blob_client(key).exists())

    def remove(self, blob_path: str) -> None:
        from azure.core.exceptions import ResourceNotFoundError

        try:
            self._container_client().delete_blob(self._key(blob_path))
        except (FileNotFoundError, ResourceNotFoundError):
            pass


_STORES: dict[str, BlobStore] = {}


def _default_root() -> str:
    return getattr(get_settings(), "material_storage_path", "") or "./_sop_storage"


def _local() -> BlobStore:
    if "local" not in _STORES:
        _STORES["local"] = LocalBlobStore(_default_root())
    return _STORES["local"]


def get_storage(name: str | None = None) -> BlobStore:
    """Resolve the configured blob store (or ``name``). Instances are cached per process."""
    settings = get_settings()
    provider = name or getattr(settings, "default_storage_provider", "") or "local"
    if provider == "azure":
        account_url = getattr(settings, "azure_storage_account_url", "")
        if not account_url:
            # Unconfigured Azure falls back to local rather than 500 (CI safety), but loudly: in
            # production this means uploads land on a disk the next revision throws away.
            logger.warning("DEFAULT_STORAGE_PROVIDER=azure but AZURE_STORAGE_ACCOUNT_URL is empty")
            return _local()
        if "azure" not in _STORES:
            _STORES["azure"] = AzureBlobStore(account_url, settings.material_blob_container)
        return _STORES["azure"]
    return _local()


def container_store(container: str) -> BlobStore:
    """A store for another private container of the same account (candidate recordings), or a
    local directory beside the SOP storage when Azure is not configured (dev, CI)."""
    settings = get_settings()
    provider = getattr(settings, "default_storage_provider", "") or "local"
    account_url = getattr(settings, "azure_storage_account_url", "")
    if provider == "azure" and account_url:
        key = f"azure:{container}"
        if key not in _STORES:
            _STORES[key] = AzureBlobStore(account_url, container)
        return _STORES[key]
    key = f"local:{container}"
    if key not in _STORES:
        _STORES[key] = LocalBlobStore(os.path.join(_default_root(), container))
    return _STORES[key]


def load(blob_path: str) -> bytes:
    """Read ``blob_path`` from whichever store wrote it (see the module note on blob_path)."""
    if blob_path.startswith(BLOB_SCHEME):
        container = blob_path[len(BLOB_SCHEME) :].split("/", 1)[0]
        store = (
            get_storage("azure")
            if container == get_settings().material_blob_container
            else container_store(container)
        )
        if store.name != "azure":
            raise FileNotFoundError(blob_path)
        return store.load(blob_path)
    return _local().load(blob_path)


def exists(blob_path: str) -> bool:
    """Whether ``blob_path`` still has bytes behind it, in whichever store wrote it."""
    if not blob_path:
        return False
    if blob_path.startswith(BLOB_SCHEME):
        store = get_storage("azure")
        return store.name == "azure" and store.exists(blob_path)
    return _local().exists(blob_path)


def remove(blob_path: str) -> None:
    """Delete an SOP file (``blob_path``) from whichever store wrote it. Best effort: a failure is
    logged, never raised (the document row is already gone; a stray file is the lesser harm)."""
    if not blob_path:
        return
    try:
        if blob_path.startswith(BLOB_SCHEME):
            container = blob_path[len(BLOB_SCHEME) :].split("/", 1)[0]
            # SOP files live in the materials container only: never delete from another one.
            if container != get_settings().material_blob_container:
                raise ValueError(f"Refusing to delete outside the SOP container: {blob_path!r}")
            store = get_storage("azure")
            if store.name == "azure":
                store.remove(blob_path)
            return
        _local().remove(blob_path)
    except Exception:  # noqa: BLE001
        logger.exception("Could not delete stored file %s", blob_path)
