"""Strict citation full-field gate (SPEC F1 traceability invariant)."""

from app.services.agents.citations import shape_citations


def _ref(title=None, url=None, page=None):
    return {"sourceData": {"title": title, "url": url, "page": page}}


def test_full_field_reference_is_kept():
    refs = [_ref("SOP §3", "sop://h#3", "p.3")]
    assert shape_citations(refs) == [{"title": "SOP §3", "url": "sop://h#3", "page": "p.3"}]


def test_reference_missing_any_field_is_dropped():
    refs = [
        _ref(None, "sop://h#1", "p.1"),  # no title
        _ref("t", None, "p.2"),  # no url
        _ref("t", "sop://h#3", None),  # no page
    ]
    assert shape_citations(refs) == []


def test_page_zero_is_dropped_matching_truthy_gate():
    # Reference uses `if title and url and page`, so a falsy page (0) is dropped by design.
    assert shape_citations([_ref("t", "u", 0)]) == []


def test_missing_source_data_is_dropped():
    assert shape_citations([{}, {"sourceData": None}]) == []


def test_order_preserved_and_capped():
    refs = [_ref(f"t{i}", f"u{i}", f"p{i}") for i in range(5)]
    out = shape_citations(refs, max_citations=3)
    assert [c["title"] for c in out] == ["t0", "t1", "t2"]


def test_partial_refs_do_not_consume_the_cap():
    refs = [
        _ref("good1", "u1", "p1"),
        _ref(None, "u2", "p2"),  # dropped, must not count toward cap
        _ref("good2", "u3", "p3"),
    ]
    out = shape_citations(refs, max_citations=2)
    assert [c["title"] for c in out] == ["good1", "good2"]


def test_empty_references_is_the_no_match_signal():
    assert shape_citations([]) == []
    assert shape_citations(None) == []


def test_non_positive_cap_returns_empty():
    assert shape_citations([_ref("t", "u", "p")], max_citations=0) == []


# --- Generalized gate (fields discovered live in the F1 spike) ---


def test_field_map_remaps_kb_specific_source_data_fields():
    # A real KB (spike) exposes domain-specific sourceData fields, not title/url/page.
    # Map canonical citation fields -> the index's actual field names.
    refs = [
        {
            "sourceData": {
                "question": "Section 3 heading",
                "answer": "the answer body text",
                "source": "handbook",
            }
        }
    ]
    out = shape_citations(
        refs,
        required_fields=("title", "url", "page"),
        field_map={"title": "question", "url": "source", "page": "answer"},
    )
    assert out == [
        {
            "title": "Section 3 heading",
            "url": "handbook",
            "page": "the answer body text",
        }
    ]


def test_field_map_still_drops_ref_missing_a_mapped_field():
    refs = [{"sourceData": {"question": "q", "source": "s"}}]  # no mapped "page" source
    out = shape_citations(
        refs,
        field_map={"title": "question", "url": "source", "page": "answer"},
    )
    assert out == []


def test_custom_required_fields_subset():
    # Some indexes only guarantee two fields; the gate stays strict over whatever set we require.
    refs = [{"sourceData": {"title": "t", "url": "u"}}]
    out = shape_citations(refs, required_fields=("title", "url"))
    assert out == [{"title": "t", "url": "u"}]
