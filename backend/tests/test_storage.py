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
