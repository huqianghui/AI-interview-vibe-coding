"""Sections sized for reading and citing (spec-sop-conversion-and-sections §2): 4000 / 500."""

from types import SimpleNamespace

from app.sop.sections import parse_sections
from app.sop.units import MAX_CHARS, MIN_CHARS, units


def _rows(markdown: str):
    return [
        SimpleNamespace(
            order_index=i,
            parent_index=s.parent,
            number=s.number,
            title=s.title,
            level=s.level,
            page_start=s.page_start,
            page_end=s.page_end,
            text=s.text,
        )
        for i, s in enumerate(parse_sections(markdown))
    ]


def _words(n: int, word: str = "word") -> str:
    return " ".join([word] * n)


def test_a_short_document_is_one_unit():
    md = "## 1. PURPOSE\n\nWhy.\n\n## 2. SCOPE\n\nWhere.\n"
    (only,) = units(_rows(md))
    assert [m.number for m in only.members] == ["1", "2"]
    assert only.label == "1–2 PURPOSE / SCOPE"
    assert "## 1 PURPOSE" in only.text and "## 2 SCOPE" in only.text  # each keeps its heading


def test_small_sections_merge_and_big_ones_stand_alone():
    md = "\n\n".join(
        [
            f"## 1. PURPOSE\n\n{_words(20)}",
            f"## 2. SCOPE\n\n{_words(20)}",
            f"## 3. DEFINITIONS\n\n{_words(30)}",
            f"## 4. PROCEDURE\n\n{_words(760)}",
            f"## 5. RECORDS\n\n{_words(10)}",
        ]
    )
    got = units(_rows(md))
    assert [[m.number for m in u.members] for u in got] == [["1", "2", "3"], ["4", "5"]]
    assert all(u.length <= MAX_CHARS for u in got)


def test_a_long_section_opens_and_only_a_part_left_too_small_crosses_into_it():
    md = "\n\n".join(
        [
            f"## 1. PURPOSE\n\n{_words(150)}",
            "## 2. PROCEDURE\n\nIntro to the steps.",
            f"2.1 Step one\n\n{_words(500)}",
            f"2.2 Step two\n\n{_words(500)}",
            f"## 3. RECORDS\n\n{_words(10)}",
        ]
    )
    got = units(_rows(md))
    groups = [[(m.number, m.own) for m in u.members] for u in got]
    # 1 is big enough on its own; 2 opens: its intro joins 2.1; 3 is too small and both of its
    # neighbours under the top level are too big, so it joins 2.2, its smaller neighbour.
    assert groups == [[("1", False)], [("2", True), ("2.1", False)], [("2.2", False), ("3", False)]]
    assert got[2].label == "2.2–3 Step two / RECORDS"
    assert all(u.length <= MAX_CHARS for u in got)


def test_a_leaf_longer_than_the_limit_stays_whole():
    md = f"## 1. TABLE\n\n{_words(1500)}\n\n## 2. END\n\n{_words(200)}"
    got = units(_rows(md))
    assert got[0].members[0].number == "1" and got[0].length > MAX_CHARS
    assert [m.number for m in got[1].members] == ["2"]


def test_units_cover_every_section_once_and_almost_none_is_small():
    parts = []
    for n in range(1, 13):
        parts.append(f"## {n}. CLAUSE {n}\n\n{_words(15)}")
        for k in range(1, 4):
            parts.append(f"{n}.{k} Sub {k}\n\n{_words(40 * k)}")
    rows = _rows("\n\n".join(parts))
    got = units(rows)
    covered = []
    for u in got:
        for m in u.members:
            covered.append(m.order_index)
            if not m.own:
                # a whole member covers its subsections too
                covered += [r.order_index for r in rows if _descends(rows, r, m.order_index)]
    assert sorted(covered) == [r.order_index for r in rows]
    assert sum(1 for u in got if u.length < MIN_CHARS) <= 1


def _descends(rows, row, ancestor):
    by = {r.order_index: r for r in rows}
    p = row.parent_index
    while p is not None:
        if p == ancestor:
            return True
        p = by[p].parent_index
    return False


def test_no_sections_no_units():
    assert units([]) == []


def test_a_unit_is_cited_as_one_run_and_that_run_reads_as_the_unit():
    """A unit cites (first, through last): resolving that run gives exactly the unit's text."""
    from types import SimpleNamespace as S

    from app.services import sop_citation

    md = "\n\n".join(
        [
            f"## 1. PURPOSE\n\n{_words(150)}",
            "## 2. PROCEDURE\n\nIntro to the steps.",
            f"2.1 Step one\n\n{_words(500)}",
            f"2.2 Step two\n\n{_words(500)}",
            f"## 3. RECORDS\n\n{_words(10)}",
        ]
    )
    rows = [S(document_id="d", **vars(r)) for r in _rows(md)]
    for unit in units(rows):
        section, through, own = unit.citation()
        ref = sop_citation.SectionRef("d", section, through, own)
        row, text, _ = sop_citation._passage(rows, ref)
        assert text == unit.text, unit.label


def test_search_proposes_units_and_each_names_its_run():
    from types import SimpleNamespace as S

    from app.services.sop_search import SectionIndex

    md = "\n\n".join(
        [
            f"## 1. PURPOSE\n\n{_words(20)}",
            f"## 2. SCOPE\n\nEvery widget batch is escalated. {_words(20)}",
            f"## 3. DEFINITIONS\n\n{_words(30)}",
            f"## 4. PROCEDURE\n\n{_words(760, 'step')}",
        ]
    )
    rows = [S(document_id="d", **vars(r)) for r in _rows(md)]
    (hit,) = SectionIndex(rows, {"d": "Widget SOP.pdf"}).search("escalated widget batch", limit=1)
    # Sections 1-3 are one unit: the candidate is that unit, named by its run.
    assert (hit.number, hit.through, hit.own) == ("1", "3", False)
    assert hit.title == "1–3 PURPOSE / SCOPE / DEFINITIONS"


def _round_trips(rows) -> None:
    """Every unit's one citation reads exactly the unit's text, and every section is covered."""
    from types import SimpleNamespace as S

    from app.services import sop_citation

    doc_rows = [S(document_id="d", **vars(r)) for r in rows]
    seen: list[int] = []
    for unit in units(doc_rows):
        section, through, own = unit.citation()
        found = sop_citation._passage(doc_rows, sop_citation.SectionRef("d", section, through, own))
        assert found is not None and found[1] == unit.text, unit.label
        seen += [m.order_index for m in unit.members]
    assert len(seen) == len(set(seen))


def test_a_small_section_never_merges_into_an_opened_neighbours_intro():
    """Adversarial review, 2026-10-10: 1 (small) + 2's own intro became one unit whose citation
    "1 through 2" read all of 2's subsections (170 characters shown, 8000 cited)."""
    md = "\n\n".join(
        [
            f"## 1. PURPOSE\n\n{_words(15)}",
            "## 2. PROCEDURE\n\nSteps.",
            f"2.1 One\n\n{_words(798)}",  # too big to take 2's intro: the intro stands alone
            f"2.2 Two\n\n{_words(798)}",
        ]
    )
    rows = _rows(md)
    got = units(rows)
    # 1 joins 2's intro, cited as a run ending with 2's own text: it reads 170 characters, not 8000.
    first = got[0]
    assert [(m.number, m.own) for m in first.members] == [("1", False), ("2", True)]
    assert first.citation() == ("1", "2", True) and first.length < 500 * 2
    _round_trips(rows)


def test_every_unit_of_any_outline_is_one_citation_that_reads_it():
    import random

    rng = random.Random(7)
    for _ in range(200):
        parts = []
        for n in range(1, rng.randint(2, 7)):
            parts.append(f"## {n}. TOP {n}\n\n{_words(rng.choice([2, 20, 120, 900]))}")
            for k in range(1, rng.randint(1, 5)):
                parts.append(f"{n}.{k} Sub {k}\n\n{_words(rng.choice([1, 30, 200, 700]))}")
                for m in range(1, rng.randint(1, 3)):
                    parts.append(f"{n}.{k}.{m} Leaf {m}\n\n{_words(rng.choice([5, 90, 400]))}")
        _round_trips(_rows("\n\n".join(parts)))
