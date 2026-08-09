"""Checklist draft shaping (SPEC F3): kind validation, weight normalization to exactly 100,
and the expected_points fallback — all pure, no LLM/DB."""

from app.interview.checklist_draft import (
    DraftItem,
    fallback_items_from_points,
    normalize_weights,
    parse_draft_items,
    weights_sum,
)


def test_parse_drops_invalid_kind_and_empty_text():
    raw = [
        {"kind": "required", "text": "keep me", "weight": 10},
        {"kind": "bogus", "text": "bad kind"},
        {"kind": "recommended", "text": "   "},  # empty after strip
        {"kind": "forbidden", "text": "no shortcuts"},
    ]
    items = parse_draft_items(raw)
    assert [i.text for i in items] == ["keep me", "no shortcuts"]
    assert [i.kind for i in items] == ["required", "forbidden"]


def test_parse_carries_source_fields():
    raw = [{"kind": "required", "text": "t", "source_quote": "SOP says X", "source_page": "p.3"}]
    item = parse_draft_items(raw, source_document_id="doc-1")[0]
    assert item.source_quote == "SOP says X"
    assert item.source_page == "p.3"
    assert item.source_document_id == "doc-1"


def test_normalize_weights_sums_to_exactly_100():
    items = [
        DraftItem(kind="required", text="a", weight=1),
        DraftItem(kind="required", text="b", weight=1),
        DraftItem(kind="required", text="c", weight=1),  # 3-way split: 34/33/33
    ]
    normalize_weights(items)
    assert weights_sum(items) == 100


def test_normalize_weights_proportional_and_forbidden_zeroed():
    items = [
        DraftItem(kind="required", text="a", weight=30),
        DraftItem(kind="recommended", text="b", weight=10),
        DraftItem(kind="forbidden", text="never", weight=99),  # gate → weight 0
    ]
    normalize_weights(items)
    assert weights_sum(items) == 100
    forbidden = next(i for i in items if i.kind == "forbidden")
    assert forbidden.weight == 0
    # 30:10 proportion preserved → 75/25.
    assert items[0].weight == 75
    assert items[1].weight == 25


def test_normalize_even_split_when_no_weights():
    items = [DraftItem(kind="required", text=f"i{n}", weight=0) for n in range(4)]
    normalize_weights(items)
    assert weights_sum(items) == 100
    assert all(w == 25 for w in (i.weight for i in items))


def test_normalize_only_forbidden_leaves_unweighted():
    items = [DraftItem(kind="forbidden", text="never")]
    normalize_weights(items)
    assert weights_sum(items) == 0  # no weighted items → nothing to normalize


def test_fallback_items_from_points():
    items = fallback_items_from_points(("point one", "point two", ""))
    assert [i.text for i in items] == ["point one", "point two"]
    assert all(i.kind == "required" for i in items)
