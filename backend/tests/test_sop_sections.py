"""SOP → Markdown → sections (docs/planning/spec-sop-section-grounding.md). Synthetic text only:
this repo is public, the real client SOPs never appear here."""

import io

import pytest

from app.services import sop_markdown
from app.sop.docx_markdown import docx_to_markdown
from app.sop.sections import full_text, parse_sections

# Shaped like Document Intelligence's Markdown of a numbered SOP: running page headers, page
# breaks, numbered headings, and clauses whose number sits alone on its line.
DI_MARKDOWN = """<!-- PageHeader="Number: DOC-001" -->

# STANDARD OPERATING PROCEDURE

<!-- PageNumber="Page 1 of 3" -->

Company Confidential

## 1. PURPOSE

This procedure describes how the widget is inspected.

## 2. RESPONSIBILITIES

2.1
Inspector:

2.1.1
Checks every widget before release.

<!-- PageBreak -->

# STANDARD OPERATING PROCEDURE

Company Confidential

2.1.2 Records the result in the log.

2.2 Supervisor: reviews the log weekly.

<table>
<tr><td>Role</td><td>Task</td></tr>
</table>

<!-- PageBreak -->

# STANDARD OPERATING PROCEDURE

Company Confidential

## 3. RECORDS

Logs are kept for 3.5 years.

Company Confidential
"""


def _by_number(sections):
    return {s.number: i for i, s in enumerate(sections)}


def test_numbered_clauses_nest_and_running_headers_are_dropped_after_their_first_copy():
    sections = parse_sections(DI_MARKDOWN)
    numbers = [s.number for s in sections]
    assert numbers == ["§0", "1", "2", "2.1", "2.1.1", "2.1.2", "2.2", "3"]
    idx = _by_number(sections)
    assert sections[idx["2.1"]].title == "Inspector:"
    assert sections[idx["2.1.1"]].parent == idx["2.1"]
    assert sections[idx["2.1.2"]].page_start == 2
    # The running title and footer survive once (in the preamble), never inside a clause.
    assert "STANDARD OPERATING PROCEDURE" in sections[0].text
    assert all("Company Confidential" not in s.text for s in sections[1:])
    # "3.5 years" is prose, not a clause 3.5.
    assert "3.5" not in numbers


def test_a_full_section_is_the_whole_passage_with_every_subsection_and_table():
    sections = parse_sections(DI_MARKDOWN)
    text = full_text(sections, _by_number(sections)["2"])
    for part in (
        "2 RESPONSIBILITIES",
        "2.1 Inspector:",
        "Checks every widget",
        "2.1.2 Records",
        "2.2 Supervisor",
        "<table>",
        "Role",
    ):
        assert part in text
    assert "PURPOSE" not in text and "RECORDS" not in text


def test_unnumbered_headings_split_and_a_preamble_is_kept():
    md = "Intro before any heading.\n\n# Overview\n\nText A.\n\n## Detail\n\nText B.\n"
    sections = parse_sections(md)
    assert [(s.number, s.title, s.level) for s in sections] == [
        ("§0", "", 1),
        ("§1", "Overview", 1),
        ("§2", "Detail", 2),
    ]
    assert sections[0].text == "Intro before any heading."
    assert full_text(sections, 1) == "Overview\nText A.\n\nDetail\nText B."


def test_a_document_with_no_heading_is_one_section():
    (only,) = parse_sections("Just a paragraph.\n\nAnd another.")
    assert (only.number, only.text) == ("§0", "Just a paragraph.\nAnd another.")


def test_a_skipped_clause_does_not_orphan_the_ones_after_it():
    md = "1 Scope\n\n1.1 First.\n\n1.3 Third (1.2 was not split out).\n\n1.4 Fourth.\n\n2 Next\n"
    assert [s.number for s in parse_sections(md)] == ["1", "1.1", "1.3", "1.4", "2"]


def _docx(build) -> bytes:
    import docx

    document = docx.Document()
    build(document)
    out = io.BytesIO()
    document.save(out)
    return out.getvalue()


def test_word_headings_come_from_styles_caps_and_bold_and_tables_become_markdown():
    def build(d):
        d.add_paragraph("Preface text.")
        d.add_heading("Styled heading", level=1)
        d.add_paragraph("Under the styled heading.")
        d.add_paragraph("TYPED IN CAPITALS")
        d.add_paragraph("Under the caps heading.")
        bold = d.add_paragraph()
        bold.add_run("Bold subheading").bold = True
        d.add_paragraph("Under the bold heading.")
        table = d.add_table(rows=2, cols=2)
        table.cell(0, 0).text, table.cell(0, 1).text = "Visit", "Window"
        table.cell(1, 0).text, table.cell(1, 1).text = "SIV", "Day 1"

    md = docx_to_markdown(_docx(build))
    assert "# Styled heading" in md and "# TYPED IN CAPITALS" in md and "## Bold subheading" in md
    assert "| Visit | Window |" in md and "| SIV | Day 1 |" in md
    sections = parse_sections(md)
    assert [s.title for s in sections] == [
        "",
        "Styled heading",
        "TYPED IN CAPITALS",
        "Bold subheading",
    ]
    assert "| SIV | Day 1 |" in full_text(sections, 3)


# --- conversion is all or nothing --------------------------------------------------------------


def _pages(*texts):
    return list(texts)


def test_page_gaps_flags_a_page_whose_recurring_words_are_missing():
    page1 = (
        "Widget inspection record checklist release batch quality signed dated VV-QDOC-12345 " * 2
    )
    page2 = (
        "Supervisor review logbook entries weekly monthly escalation deviation closure audit " * 2
    )
    assert sop_markdown.page_gaps(_pages(page1, page2), page1 + page2) == []
    gaps = sop_markdown.page_gaps(_pages(page1, page2), page1)
    assert [g[0] for g in gaps] == [2]
    # Rotated text comes out of the text layer reversed; merged words lose their spaces.
    assert (
        sop_markdown.page_gaps(
            _pages("reganaM " * 12 + "ataD tnemeganaM " * 6), "Manager Data Management"
        )
        == []
    )


@pytest.mark.asyncio
async def test_a_pdf_whose_pages_dont_all_come_back_fails_with_no_markdown(monkeypatch):
    monkeypatch.setattr(sop_markdown.get_settings(), "azure_foundry_endpoint", "https://di.example")
    monkeypatch.setattr(sop_markdown, "_pdf_page_texts", lambda _c: ["one " * 20, "two " * 20])

    async def two_of_three(_content, _endpoint, page_count):
        assert page_count == 2  # every page is named explicitly
        return {"content": "one", "pages": [{}]}

    monkeypatch.setattr(sop_markdown, "_analyze", two_of_three)
    result = await sop_markdown.to_markdown(b"%PDF", "x.pdf")
    assert (result.markdown, result.source) == ("", "failed")
    assert "1 of 2 pages converted" in result.error


@pytest.mark.asyncio
async def test_a_pdf_missing_a_pages_content_fails_and_a_complete_one_succeeds(monkeypatch):
    texts = [
        "Alpha bravo charlie delta echo foxtrot golf hotel india juliet " * 2,
        "Kilo lima mike november oscar papa quebec romeo sierra tango " * 2,
    ]
    monkeypatch.setattr(sop_markdown.get_settings(), "azure_foundry_endpoint", "https://di.example")
    monkeypatch.setattr(sop_markdown, "_pdf_page_texts", lambda _c: texts)

    async def partial(*_a):
        return {"content": texts[0], "pages": [{}, {}]}

    monkeypatch.setattr(sop_markdown, "_analyze", partial)
    failed = await sop_markdown.to_markdown(b"%PDF", "x.pdf")
    assert failed.source == "failed" and "page 2" in failed.error

    async def whole(*_a):
        return {"content": "\n".join(texts), "pages": [{}, {}]}

    monkeypatch.setattr(sop_markdown, "_analyze", whole)
    ok = await sop_markdown.to_markdown(b"%PDF", "x.pdf")
    assert (ok.source, ok.error) == ("document_intelligence", "")


@pytest.mark.asyncio
async def test_without_document_intelligence_the_text_layer_is_used_and_labelled(monkeypatch):
    monkeypatch.setattr(sop_markdown.get_settings(), "azure_foundry_endpoint", "")
    monkeypatch.setattr(sop_markdown, "_pdf_page_texts", lambda _c: ["p1", "p2"])
    result = await sop_markdown.to_markdown(b"%PDF", "x.pdf")
    assert (result.source, result.markdown) == ("pdf_text", "p1\n\n<!-- PageBreak -->\n\np2")
    unsupported = await sop_markdown.to_markdown(b"x", "x.xyz")
    assert unsupported.source == "failed" and "unsupported" in unsupported.error
