"""Boot repair of SOP rows whose stored bytes are gone (the pre-blob local disk lost them)."""

import pytest

from app.models.sop import SopDocument
from app.services import storage
from app.services.sop_file_repair import repair_missing_sop_files


@pytest.fixture
def local_store(monkeypatch, tmp_path):
    root = tmp_path / "store"
    monkeypatch.setattr(storage, "_STORES", {})
    monkeypatch.setattr(storage, "_default_root", lambda: str(root))
    return storage.get_storage()


def _originals(tmp_path):
    src = tmp_path / "bundle" / "EU" / "Data_Sources"
    src.mkdir(parents=True)
    (src / "Monitoring Plan (1).docx").write_bytes(b"docx-bytes")
    return tmp_path / "bundle"


@pytest.mark.asyncio
async def test_restores_a_missing_file_from_the_original(db_session, local_store, tmp_path):
    doc = SopDocument(name="Monitoring Plan (1).docx", blob_path="/app/data/_sop_storage/gone.docx")
    db_session.add(doc)
    await db_session.commit()

    assert await repair_missing_sop_files(db_session, str(_originals(tmp_path))) == 1

    await db_session.refresh(doc)
    assert storage.load(doc.blob_path) == b"docx-bytes"
    # A second boot finds nothing to do.
    assert await repair_missing_sop_files(db_session, str(tmp_path / "bundle")) == 0


@pytest.mark.asyncio
async def test_leaves_present_and_unmatched_rows_alone(db_session, local_store, tmp_path):
    kept = local_store.save("kept/a.pdf", b"still-here")
    present = SopDocument(name="a.pdf", blob_path=kept)
    orphan = SopDocument(name="No Original.pdf", blob_path="")
    db_session.add_all([present, orphan])
    await db_session.commit()

    assert await repair_missing_sop_files(db_session, str(_originals(tmp_path))) == 0

    await db_session.refresh(present)
    await db_session.refresh(orphan)
    assert present.blob_path == kept
    assert orphan.blob_path == ""


@pytest.mark.asyncio
async def test_no_source_dir_is_a_no_op(db_session, local_store, tmp_path):
    db_session.add(SopDocument(name="x.pdf", blob_path=""))
    await db_session.commit()
    assert await repair_missing_sop_files(db_session, str(tmp_path / "absent")) == 0
