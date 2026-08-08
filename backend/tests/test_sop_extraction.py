"""SOP text extraction dispatch + chunking (SPEC F1 ingestion)."""

import pytest

from app.sop.extraction import chunk_text, extract_text


def test_extract_plain_text_txt_and_md():
    assert extract_text(b"hello world", "notes.txt") == "hello world"
    assert extract_text(b"# Title\n\nbody", "readme.MD") == "# Title\n\nbody"


def test_extract_decodes_invalid_utf8_without_raising():
    # Lone continuation byte → replacement char, never an exception.
    out = extract_text(b"ok\xff", "a.txt")
    assert out.startswith("ok")


def test_unknown_extension_returns_empty():
    assert extract_text(b"data", "archive.zip") == ""
    assert extract_text(b"data", "noext") == ""


def test_extractor_that_raises_degrades_to_empty(monkeypatch):
    # The dispatcher's belt-and-suspenders guard: even if an extractor raises, ingestion
    # gets "" rather than an exception.
    from app.sop import extraction

    def boom(_content):
        raise RuntimeError("parser exploded")

    monkeypatch.setitem(extraction._EXTRACTORS, ".txt", boom)
    assert extract_text(b"data", "x.txt") == ""


def test_chunk_short_text_single_chunk():
    assert chunk_text("short") == ["short"]


def test_chunk_whitespace_only_yields_nothing():
    assert chunk_text("   \n\n  ") == []


def test_chunk_respects_size_and_covers_all_content():
    text = "x" * 1300
    chunks = chunk_text(text, chunk_size=512, overlap=0)
    assert all(len(c) <= 512 for c in chunks)
    assert "".join(chunks) == text  # no data lost with zero overlap


def test_chunk_prefers_newline_boundary():
    # A newline sits within the trailing overlap window; the first chunk ends cleanly there
    # (no mid-line slice) rather than at the hard 512 cut.
    body = "a" * 500 + "\n" + "b" * 500
    chunks = chunk_text(body, chunk_size=512, overlap=64)
    assert chunks[0] == "a" * 500
    # Every "b" is covered (overlap may duplicate some across the boundary, so ≥ 500).
    assert sum(c.count("b") for c in chunks) >= 500


def test_chunk_overlap_carries_context_forward():
    text = "abcdefghij" * 10  # 100 chars, no newlines
    chunks = chunk_text(text, chunk_size=40, overlap=10)
    assert len(chunks) > 1
    # Consecutive chunks share the overlap tail → forward progress guaranteed.
    assert chunks[1].startswith(chunks[0][-10:])


def test_chunk_rejects_bad_params():
    with pytest.raises(ValueError):
        chunk_text("x", chunk_size=0)
    with pytest.raises(ValueError):
        chunk_text("x", chunk_size=10, overlap=10)
    with pytest.raises(ValueError):
        chunk_text("x", chunk_size=10, overlap=-1)
