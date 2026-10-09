"""Split every converted SOP's stored Markdown again with the current splitter, and replace its
sections. No conversion and no Document Intelligence call: for a change to the splitter alone
(v0.62.4.0: headings with 7+ "#", "10.TITLE" clauses). Word documents are skipped: they are
converted again through the unified pipeline at boot (converter version bump).

Run inside the backend container, after ``scripts/compare_sop_sections.py`` has shown what will
change:

    python scripts/resplit_sop_sections.py

Prints counts only. Rubric citations name a section by number, so a number that survives keeps
its citation; run the comparison again afterwards and relocate any citation that no longer
resolves.
"""

from __future__ import annotations

import asyncio

from sqlalchemy import select

from app.db import async_session_factory
from app.models.sop import SopDocument
from app.services.sop_section_service import resplit


async def main() -> None:
    async with async_session_factory() as db:
        query = select(SopDocument).order_by(SopDocument.name)
        documents = (await db.execute(query)).scalars().all()
        for n, document in enumerate(documents, 1):
            if document.name.lower().endswith(".docx"):
                print(f"doc{n:02d}: Word, converted again at boot")
                continue
            print(f"doc{n:02d}: {await resplit(db, document)} sections")


if __name__ == "__main__":
    asyncio.run(main())
