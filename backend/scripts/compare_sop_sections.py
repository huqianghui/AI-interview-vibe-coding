"""Compare every SOP's stored sections with what the unified pipeline would give it now, and say
which rubric citations would stop resolving. Read-only: nothing is written to the database.

Run inside the backend container (it has LibreOffice, Document Intelligence access through the
managed identity, the SOP files and the database):

    python scripts/compare_sop_sections.py            # every document
    python scripts/compare_sop_sections.py --word     # Word documents only

- Word (.docx): converted again through PDF (LibreOffice) → Document Intelligence → sections.
- Every other document: its stored Markdown split again by the current splitter (no DI call), which
  shows what a change to the splitter alone would do.

Prints numbers only (section numbers, counts), never document text: the output may be pasted into
a PR. A document is "same" when its numbered sections (number and title) are identical.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections import defaultdict

from sqlalchemy import select

from app.db import async_session_factory
from app.models.checklist import ChecklistItem
from app.models.sop import SopDocument, SopSection
from app.services import sop_markdown, storage
from app.sop.sections import parse_sections


def _numbered(rows: list[tuple[str, str]]) -> list[tuple[str, str]]:
    return [(n, " ".join(t.split()).upper()) for n, t in rows if not n.startswith("§")]


async def _cited(session) -> dict[str, set[str]]:  # noqa: ANN001
    """Section numbers each document is cited by, in any rubric."""
    cited: dict[str, set[str]] = defaultdict(set)
    for (refs,) in await session.execute(select(ChecklistItem.source_refs)):
        for ref in json.loads(refs or "[]"):
            if ref.get("document_id") and ref.get("section"):
                cited[ref["document_id"]].add(ref["section"])
    return cited


async def main(word_only: bool) -> int:
    endpoint = sop_markdown.get_settings().azure_foundry_endpoint
    soffice = sop_markdown.libreoffice()
    print(f"LibreOffice: {soffice or 'missing'}  DI: {'yes' if endpoint else 'no'}")
    if not (soffice and endpoint):
        print("the Word route needs both: run this inside the backend container")
        return 2
    differs = 0
    async with async_session_factory() as session:
        cited = await _cited(session)
        query = select(SopDocument).order_by(SopDocument.name)
        documents = (await session.execute(query)).scalars()
        for n, doc in enumerate(documents, 1):
            word = doc.name.lower().endswith(".docx")
            if word_only and not word:
                continue
            stored = [
                (s.number, s.title)
                for s in (
                    await session.execute(
                        select(SopSection)
                        .where(SopSection.document_id == doc.id)
                        .order_by(SopSection.order_index)
                    )
                ).scalars()
            ]
            try:
                if word:
                    content = await asyncio.to_thread(storage.load, doc.blob_path)
                    markdown = await sop_markdown._docx_via_document_intelligence(
                        content, endpoint, soffice
                    )
                else:
                    markdown = doc.markdown
                fresh = [(s.number, s.title) for s in parse_sections(markdown)]
            except Exception as exc:  # noqa: BLE001 — reported, the next document still runs
                differs += 1
                kind = "word" if word else "other"
                print(f"doc{n:02d} {kind}: FAILED {type(exc).__name__}: {exc}")
                continue
            old, new = _numbered(stored), _numbered(fresh)
            numbers = {num for num, _ in new}
            # A citation names any section, numbered or not ("§3"): checked against all of them.
            broken = sorted(cited.get(doc.id, set()) - {num for num, _ in fresh})
            same = old == new
            differs += not same or bool(broken)
            print(
                f"doc{n:02d} {'word' if word else 'other'}: {'same' if same else 'DIFFERENT'}"
                f"  numbered {len(old)}->{len(new)}  sections {len(stored)}->{len(fresh)}"
                f"  lost {sorted({x for x, _ in old} - numbers)}"
                f"  added {sorted(numbers - {x for x, _ in old})}"
                f"  retitled {sorted(x for (x, t) in new if (x, t) not in old and x in dict(old))}"
                f"  cited {len(cited.get(doc.id, ()))}  broken citations {broken}"
            )
    print(f"documents that differ or would break a citation: {differs}")
    return 0 if differs == 0 else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Compare stored SOP sections with a fresh run.")
    parser.add_argument("--word", action="store_true", help="Word documents only")
    sys.exit(asyncio.run(main(parser.parse_args().word)))
