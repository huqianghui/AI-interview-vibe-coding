"""Local SOP blob store (SPEC F1): round-trip + path-traversal guard."""

import pytest

from app.services.storage import LocalBlobStore, get_storage


def test_local_store_round_trip(tmp_path):
    store = LocalBlobStore(str(tmp_path))
    blob_path = store.save("docs/sop.txt", b"hello")
    assert store.load(blob_path) == b"hello"


def test_local_store_rejects_path_traversal(tmp_path):
    store = LocalBlobStore(str(tmp_path))
    with pytest.raises(ValueError):
        store.save("../escape.txt", b"nope")


def test_local_store_strips_leading_slash(tmp_path):
    store = LocalBlobStore(str(tmp_path))
    blob_path = store.save("/abs/sop.txt", b"data")
    assert store.load(blob_path) == b"data"
    assert str(tmp_path) in blob_path


def test_get_storage_defaults_to_local(monkeypatch, tmp_path):
    from app.services import storage

    monkeypatch.setattr(storage, "_STORES", {})
    monkeypatch.setattr(storage, "_default_root", lambda: str(tmp_path))
    assert get_storage().name == "local"


def test_get_storage_unknown_falls_back_to_local(monkeypatch, tmp_path):
    from app.services import storage

    monkeypatch.setattr(storage, "_STORES", {})
    monkeypatch.setattr(storage, "_default_root", lambda: str(tmp_path))
    assert get_storage("azure").name == "local"


class _FakeBlob:
    def __init__(self, blobs, key):
        self._blobs, self._key = blobs, key

    def exists(self):
        return self._key in self._blobs

    def readall(self):
        return self._blobs[self._key]


class _FakeContainer:
    """The slice of azure.storage.blob.ContainerClient that AzureBlobStore uses."""

    def __init__(self):
        self.blobs: dict[str, bytes] = {}

    def upload_blob(self, key, content, overwrite=False):
        assert overwrite
        self.blobs[key] = content

    def download_blob(self, key):
        from azure.core.exceptions import ResourceNotFoundError

        if key not in self.blobs:
            raise ResourceNotFoundError("missing")
        return _FakeBlob(self.blobs, key)

    def get_blob_client(self, key):
        return _FakeBlob(self.blobs, key)


def test_azure_store_round_trip_and_self_describing_path():
    from app.services.storage import AzureBlobStore

    fake = _FakeContainer()
    store = AzureBlobStore("https://acct.blob.core.windows.net", "materials", client=fake)
    blob_path = store.save("/doc-1/SOP (1).pdf", b"pdf")
    assert blob_path == "blob://materials/doc-1/SOP (1).pdf"
    assert fake.blobs == {"doc-1/SOP (1).pdf": b"pdf"}
    assert store.load(blob_path) == b"pdf"
    assert store.exists(blob_path)


def test_azure_store_missing_blob_is_file_not_found():
    # Callers answer FileNotFoundError with a 404, so a gone blob must surface as one.
    from app.services.storage import AzureBlobStore

    store = AzureBlobStore("https://acct", "materials", client=_FakeContainer())
    with pytest.raises(FileNotFoundError):
        store.load("blob://materials/gone.pdf")
    # A pointer into another container, or a legacy local path, is not this store's to serve.
    with pytest.raises(FileNotFoundError):
        store.load("blob://other/x.pdf")
    assert not store.exists("/app/data/_sop_storage/x.pdf")


def test_azure_store_rejects_path_traversal():
    from app.services.storage import AzureBlobStore

    store = AzureBlobStore("https://acct", "materials", client=_FakeContainer())
    with pytest.raises(ValueError):
        store.save("a/../../escape.pdf", b"nope")


def test_get_storage_azure_when_configured(monkeypatch):
    from app.services import storage

    settings = storage.get_settings()
    monkeypatch.setattr(storage, "_STORES", {})
    monkeypatch.setattr(settings, "default_storage_provider", "azure")
    monkeypatch.setattr(settings, "azure_storage_account_url", "https://acct.blob.core.windows.net")
    assert get_storage().name == "azure"


def test_load_dispatches_on_the_blob_path(monkeypatch, tmp_path):
    # Rows written before the switch keep a local path; new ones carry blob://. Both must resolve.
    from app.services import storage

    fake = _FakeContainer()
    fake.blobs["k.pdf"] = b"from-blob"
    local = storage.LocalBlobStore(str(tmp_path))
    monkeypatch.setattr(
        storage,
        "_STORES",
        {"azure": storage.AzureBlobStore("https://acct", "materials", client=fake), "local": local},
    )
    monkeypatch.setattr(storage.get_settings(), "azure_storage_account_url", "https://acct")
    legacy = local.save("old.pdf", b"from-disk")
    assert storage.load("blob://materials/k.pdf") == b"from-blob"
    assert storage.load(legacy) == b"from-disk"
    assert storage.exists("blob://materials/k.pdf") and storage.exists(legacy)
    assert not storage.exists("") and not storage.exists(str(tmp_path / "gone.pdf"))


def test_blob_path_without_azure_configured_is_missing(monkeypatch, tmp_path):
    from app.services import storage

    monkeypatch.setattr(storage, "_STORES", {})
    monkeypatch.setattr(storage, "_default_root", lambda: str(tmp_path))
    monkeypatch.setattr(storage.get_settings(), "azure_storage_account_url", "")
    with pytest.raises(FileNotFoundError):
        storage.load("blob://materials/k.pdf")
    assert not storage.exists("blob://materials/k.pdf")
