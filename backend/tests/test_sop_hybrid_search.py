"""Hybrid SOP search: keyword (BM25) and vector rankings fused by rank (RRF), vectors stored per
unit and refreshed only for units whose text changed (owner, 2026-10-09: option B)."""

import math
import os
from types import SimpleNamespace as S

import pytest
from sqlalchemy import select

from app.models.sop import SopDocument, SopSection, SopUnitEmbedding
from app.services import sop_embeddings, sop_section_service
from app.services.sop_search import SectionIndex
from app.sop.sections import parse_sections
from app.sop.units import units

pytestmark = pytest.mark.asyncio


def _words(n, word="word"):
    return " ".join([word] * n)


# Three units: deviations, records, training. "Deviation" is not in the training text and the
# query says neither "deviation" nor any training word.
MD = "\n\n".join(
    [
        f"## 1. DEVIATIONS\n\nEvery deviation is logged. {_words(300, 'deviation')}",
        f"## 2. RECORDS\n\nRecords are archived. {_words(300, 'archive')}",
        f"## 3. TRAINING\n\nStaff complete training. {_words(300, 'course')}",
    ]
)


def _rows():
    return [
        S(
            document_id="d",
            order_index=i,
            parent_index=s.parent,
            number=s.number,
            title=s.title,
            level=s.level,
            page_start=s.page_start,
            page_end=s.page_end,
            text=s.text,
        )
        for i, s in enumerate(parse_sections(MD))
    ]


# A fake meaning space: deviations, records, training.
_MEANING = {"1": [1.0, 0.0, 0.0], "2": [0.0, 1.0, 0.0], "3": [0.0, 0.0, 1.0]}


def _vectors(rows):
    return {
        ("d", sop_embeddings.unit_key(u), sop_embeddings.text_hash(u.text)): _MEANING[
            u.members[0].number
        ]
        for u in units(rows)
    }


async def test_hybrid_search_finds_by_meaning_what_keywords_miss():
    rows = _rows()
    index = SectionIndex(rows, {"d": "SOP.pdf"}, _vectors(rows))
    assert index.has_vectors
    query = "newcomer onboarding"  # no keyword of any unit
    assert index.search(query) == []
    (hit,) = index.search(query, limit=1, query_vector=[0.1, 0.0, 0.9])
    assert hit.number == "3"  # training, by meaning


async def test_fusion_ranks_a_unit_both_lists_agree_on_first():
    rows = _rows()
    index = SectionIndex(rows, {"d": "SOP.pdf"}, _vectors(rows))
    # Keywords: 1 first ("deviation" 300 times), 2 second ("archived" once). Meaning: 2, 3, 1.
    assert [c.number for c in index.search("deviation archived")] == ["1", "2"]
    got = index.search("deviation archived", limit=3, query_vector=[0.0, 0.9, 0.1])
    assert [c.number for c in got] == ["2", "1", "3"]
    # RRF: 1 / (60 + rank), summed over the lists a unit is in.
    assert got[0].score == pytest.approx(1 / 62 + 1 / 61, abs=1e-3)
    assert got[1].score == pytest.approx(1 / 61 + 1 / 63, abs=1e-3)


async def test_without_vectors_it_is_keyword_search():
    rows = _rows()
    index = SectionIndex(rows, {"d": "SOP.pdf"})
    assert not index.has_vectors
    assert [c.number for c in index.search("archived records", limit=1)] == ["2"]


def _enable(monkeypatch):
    settings = sop_embeddings.get_settings()
    monkeypatch.setattr(settings, "azure_foundry_endpoint", "https://ai.example")
    monkeypatch.setattr(settings, "sop_embedding_deployment", "text-embedding-3-small")


async def test_refresh_embeds_only_changed_units_and_drops_gone_ones(db_session, monkeypatch):
    _enable(monkeypatch)
    calls: list[int] = []

    async def fake_embed(texts):
        calls.append(len(texts))
        return [[float(len(t)), 1.0] for t in texts]

    monkeypatch.setattr(sop_embeddings, "embed", fake_embed)
    doc = SopDocument(name="SOP.md", status="chunked", markdown_source="text", markdown=MD)
    db_session.add(doc)
    await db_session.commit()
    await sop_section_service.resplit(db_session, doc)
    assert await sop_embeddings.refresh(db_session, doc.id) == 3  # one per section
    assert await sop_embeddings.refresh(db_session, doc.id) == 0  # nothing changed
    assert calls == [3]

    doc.markdown = MD + f"\n\n## 4. AUDITS\n\n{_words(900, 'audit')}"
    await db_session.commit()
    await sop_section_service.resplit(db_session, doc)
    embedded = await sop_embeddings.refresh(db_session, doc.id)
    rows = (
        (
            await db_session.execute(
                select(SopUnitEmbedding).where(SopUnitEmbedding.document_id == doc.id)
            )
        )
        .scalars()
        .all()
    )
    sections = (
        (await db_session.execute(select(SopSection).where(SopSection.document_id == doc.id)))
        .scalars()
        .all()
    )
    assert {(r.unit_key, r.text_hash) for r in rows} == {
        (sop_embeddings.unit_key(u), sop_embeddings.text_hash(u.text)) for u in units(sections)
    }  # the old whole-document unit is gone
    assert embedded == len(rows) - 3  # only the new section: 1-3 kept their vectors


async def test_a_failed_query_embedding_falls_back_to_keywords(monkeypatch):
    _enable(monkeypatch)

    async def broken(texts):
        raise RuntimeError("throttled")

    monkeypatch.setattr(sop_embeddings, "embed", broken)
    assert await sop_embeddings.embed_query("deviations") is None
    monkeypatch.setattr(sop_embeddings.get_settings(), "sop_embedding_deployment", "")
    assert not sop_embeddings.enabled()


@pytest.mark.skipif(bool(os.environ.get("CI")), reason="CI never calls Azure")
async def test_the_real_embedding_model_puts_related_text_closer(monkeypatch):
    """Local only, with backend/.env (owner rule: the real model locally, a fake in CI)."""
    from dotenv import dotenv_values

    vals = dotenv_values(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))
    if not vals.get("AZURE_FOUNDRY_ENDPOINT"):
        pytest.skip("no AZURE_FOUNDRY_ENDPOINT in backend/.env")
    settings = sop_embeddings.get_settings()
    monkeypatch.setattr(settings, "azure_foundry_endpoint", vals["AZURE_FOUNDRY_ENDPOINT"])
    monkeypatch.setattr(
        settings,
        "sop_embedding_deployment",
        vals.get("SOP_EMBEDDING_DEPLOYMENT") or "text-embedding-3-small",
    )
    query, near, far = await sop_embeddings.embed(
        [
            "How is a protocol deviation reported?",
            "Every deviation from the protocol is documented and escalated to the study lead.",
            "Archive boxes are labelled with the year and stored in the basement.",
        ]
    )

    def cos(a, b):
        return sum(x * y for x, y in zip(a, b, strict=True)) / (
            math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
        )

    assert len(query) == 1536
    assert cos(query, near) > cos(query, far)
