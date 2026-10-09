"""SOP libraries (spec-sop-libraries): every document belongs to exactly one library.

A library is created and renamed in the admin page; one that still holds documents cannot be
deleted. Documents never move between libraries (owner, 2026-10-09): an SOP that belongs
elsewhere is uploaded again into the other library.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.sop import DEFAULT_LIBRARY_ID, DEFAULT_LIBRARY_NAME, SopDocument, SopLibrary

MAX_NAME = 255


class LibraryNotFound(Exception):
    pass


class LibraryNameTaken(Exception):
    pass


class LibraryNotEmpty(Exception):
    pass


class LibraryNameInvalid(Exception):
    pass


class LibraryInUse(Exception):
    """A question bank is bound to the library (spec-sop-libraries): rebind it first."""


@dataclass(frozen=True)
class LibraryRow:
    library: SopLibrary
    document_count: int


def _clean(name: str) -> str:
    cleaned = " ".join((name or "").split())
    if not cleaned or len(cleaned) > MAX_NAME:
        raise LibraryNameInvalid(f"A library name is 1 to {MAX_NAME} characters")
    return cleaned


async def list_libraries(db: AsyncSession) -> Sequence[LibraryRow]:
    rows = await db.execute(
        select(SopDocument.library_id, func.count()).group_by(SopDocument.library_id)
    )
    counts: dict[str, int] = {library_id: n for library_id, n in rows.all()}
    libraries = (await db.execute(select(SopLibrary).order_by(SopLibrary.name))).scalars().all()
    return [LibraryRow(lib, counts.get(lib.id, 0)) for lib in libraries]


async def get_library(db: AsyncSession, library_id: str) -> SopLibrary:
    library = await db.get(SopLibrary, library_id)
    if library is None:
        raise LibraryNotFound(library_id)
    return library


async def _commit_name(db: AsyncSession) -> None:
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise LibraryNameTaken("A library with that name already exists") from exc


async def create_library(db: AsyncSession, name: str, description: str = "") -> SopLibrary:
    library = SopLibrary(name=_clean(name), description=(description or "").strip())
    db.add(library)
    await _commit_name(db)
    await db.refresh(library)
    return library


async def update_library(
    db: AsyncSession, library_id: str, *, name: str | None = None, description: str | None = None
) -> SopLibrary:
    library = await get_library(db, library_id)
    if name is not None:
        library.name = _clean(name)
    if description is not None:
        library.description = description.strip()
    await _commit_name(db)
    await db.refresh(library)
    return library


async def delete_library(db: AsyncSession, library_id: str) -> None:
    library = await get_library(db, library_id)
    held = await db.scalar(
        select(func.count()).select_from(SopDocument).where(SopDocument.library_id == library_id)
    )
    if held:
        raise LibraryNotEmpty(f"The library still holds {held} document(s)")
    from app.models.question import QuestionBank

    banks = (
        (
            await db.execute(
                select(QuestionBank.name).where(QuestionBank.sop_library_id == library_id)
            )
        )
        .scalars()
        .all()
    )
    if banks:
        raise LibraryInUse(
            "The library is used by question bank(s): " + ", ".join(banks) + ". Rebind them first."
        )
    await db.delete(library)
    try:
        await db.commit()
    except IntegrityError as exc:
        # A document was uploaded into it between the count and the delete: the foreign key
        # refuses, and the answer is the same as above.
        await db.rollback()
        raise LibraryNotEmpty("The library still holds documents") from exc


async def ensure_default(db: AsyncSession) -> str:
    """The default library's id, creating it if it was deleted (documents stored without a library
    go there: the boot-time bank importer). Not committed; the caller's commit carries it."""
    if await db.get(SopLibrary, DEFAULT_LIBRARY_ID) is None:
        name = DEFAULT_LIBRARY_NAME
        if await db.scalar(select(SopLibrary.id).where(SopLibrary.name == name)):
            name = f"{DEFAULT_LIBRARY_NAME} (default)"
        db.add(SopLibrary(id=DEFAULT_LIBRARY_ID, name=name))
        await db.flush()
    return DEFAULT_LIBRARY_ID
