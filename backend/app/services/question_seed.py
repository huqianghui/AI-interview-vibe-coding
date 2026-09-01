"""Demo question-bank seed (SPEC F2 AC #1): one enabled default bank + 10 ordered questions.

Idempotent — :func:`seed_default_bank` is a no-op when an enabled default bank already exists, so
it is safe to call on every boot or in a test fixture. The interview state machine resolves
questions from this bank once it's seeded (otherwise it uses the built-in fallback pair).

PUBLIC repo: these are generic, role-agnostic placeholder questions. Real client SOP-derived
questions and their ``expected_points`` are loaded at deploy time, never committed here.

Beyond the single programmatic default, :func:`seed_bundled_banks` imports every committed bank
bundle under ``app/seeds/banks/*.json`` (non-default, SOP-doc-free generic banks) so the ephemeral
server presents the same multi-bank catalogue as a local checkout — the boot importer's rf-CSM
bank stays the enabled default, these ride alongside it. Client-derived banks are NOT committed;
they arrive via the private-blob channel (see ``entrypoint.sh``).
"""

import json
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.services import bank_bundle_service, question_service

# Committed generic bank bundles, imported alongside the default on boot. Directory may be absent
# in a bare test tree — treated as "no bundles" rather than an error.
_SEED_BANKS_DIR = Path(__file__).resolve().parent.parent / "seeds" / "banks"

# 10 generic behavioral/procedural questions. `expected_points` are neutral placeholders that F3
# checklist items will later attach to; they are interviewer-internal (never candidate-facing, P3).
DEMO_QUESTIONS: tuple[dict, ...] = (
    {"text": "Please introduce your relevant experience for this role.", "points": []},
    {
        "text": "Describe a situation where you had to follow a strict procedure. What did you do?",
        "points": ["identifies the procedure", "follows each step", "verifies the outcome"],
        "max_follow_ups": 1,
    },
    {"text": "How do you make sure you understand a task before starting it?", "points": []},
    {
        "text": "Tell me about a time you caught a mistake before it caused a problem.",
        "points": ["notices the issue early", "takes corrective action"],
    },
    {"text": "How do you prioritise when several tasks are urgent at once?", "points": []},
    {
        "text": "Describe how you handle a step you are unsure about during a procedure.",
        "points": ["pauses safely", "seeks the right reference or person"],
    },
    {
        "text": "Give an example of following a safety or compliance rule under pressure.",
        "points": [],
    },
    {"text": "How do you record and hand off work so someone else can continue it?", "points": []},
    {
        "text": "Tell me about a time you improved a process you were responsible for.",
        "points": ["identifies the inefficiency", "proposes a concrete change"],
    },
    {
        "text": "Why are you interested in this role, and what do you hope to contribute?",
        "points": [],
    },
)

DEFAULT_BANK_NAME = "Demo interview bank"


async def seed_default_bank(db: AsyncSession, *, language: str = "en-US") -> str | None:
    """Create the demo default bank + questions if none is set. Returns the bank id, or None.

    Idempotent: returns None (and writes nothing) when an enabled default bank already exists.
    """
    existing = await question_service.get_default_bank(db)
    if existing is not None:
        return None

    bank = await question_service.create_bank(
        db,
        name=DEFAULT_BANK_NAME,
        description="Seeded generic interview questions for the demo.",
        language=language,
        enabled=True,
        is_default=True,
    )
    for order_index, q in enumerate(DEMO_QUESTIONS):
        await question_service.add_question(
            db,
            bank_id=bank.id,
            text=q["text"],
            order_index=order_index,
            language=language,
            expected_points=json.dumps(q.get("points", []), ensure_ascii=False),
            max_follow_ups=int(q.get("max_follow_ups", 0)),
        )
    return bank.id


async def _import_bank_bundles(db: AsyncSession, directory: Path) -> list[str]:
    """Import every ``*.json`` bank bundle under ``directory`` as non-default, idempotently.

    Shared by :func:`seed_bundled_banks` (committed generic bundles) and :func:`seed_client_banks`
    (private client bundles). :func:`bank_bundle_service.import_bank_bundle` is idempotent by name
    (it replaces an existing same-named bank), so re-running on every boot converges rather than
    duplicating. Every bundle is forced non-default so this never fights the boot importer for the
    single enabled-default slot; the previously-default bank is preserved across the import (a
    same-name replace drops the flag, and we restore it by name afterward).

    Returns the imported bank ids (empty when the directory is absent). Best-effort per file: a
    malformed bundle raises with its own path in context rather than silently importing nothing.
    """
    # Blocking pathlib IO is fine here: boot-time seeding of a handful of small local files, before
    # the server accepts traffic (ASYNC240 suppressed — no event loop starvation in practice).
    if not directory.is_dir():  # noqa: ASYNC240
        return []

    # Preserve whichever bank owns the enabled-default slot across the import. On live that's the
    # boot importer's rf-CSM bank (no bundle shares its name, so it's untouched). In public-demo
    # mode it's the programmatic "Demo interview bank" — and a committed bundle of the SAME name
    # replaces it as non-default, which would otherwise leave NO default and drop the interview
    # back to the built-in fallback pair. Capture the name up front and restore it after.
    prior_default = await question_service.get_default_bank(db)
    prior_default_name = prior_default.name if prior_default is not None else None

    imported: list[str] = []
    for path in sorted(directory.glob("*.json")):  # noqa: ASYNC240 — boot-time local IO, see above
        bundle = json.loads(path.read_text(encoding="utf-8"))
        # Defensive: a seeded/imported bundle must never claim the default slot.
        bundle.setdefault("bank", {})["is_default"] = False
        result = await bank_bundle_service.import_bank_bundle(db, bundle)
        imported.append(result.bank_id)

    # Restore the default if an import replaced the previously-default bank (same-name replace
    # drops the flag). Match by name — the bundle re-created it under a fresh id.
    if prior_default_name is not None and await question_service.get_default_bank(db) is None:
        restored = next(
            (b for b in await question_service.list_banks(db) if b.name == prior_default_name),
            None,
        )
        if restored is not None:
            await question_service.set_default_bank(db, restored.id)

    return imported


async def seed_bundled_banks(db: AsyncSession) -> list[str]:
    """Import every committed generic bank bundle (``app/seeds/banks/*.json``), idempotently.

    So the ephemeral server matches a local checkout's multi-bank catalogue: on live the boot
    importer seeds the client rf-CSM bank as the enabled default, and this adds the generic banks
    (Demo / Deployment SOP / test) alongside it. Each committed bundle is non-default so this never
    fights the boot importer for the single-default slot. Returns the imported bank ids (empty when
    the seeds directory is absent, e.g. in a bare test tree).
    """
    return await _import_bank_bundles(db, _SEED_BANKS_DIR)


async def seed_client_banks(db: AsyncSession, directory: str | Path | None = None) -> list[str]:
    """Import client bank bundles delivered via the private-blob channel, idempotently.

    Client-derived banks (e.g. the rf-CSM demo01 bank) carry SOP ``source_quotes`` and so are NEVER
    committed to this public repo. Instead the private bundle extracts to ``/app/_client_bundle``
    (see ``entrypoint.sh``) and its ``extra_banks/*.json`` files are imported here on every boot,
    alongside the committed generic bundles. The directory is configurable via ``CLIENT_BANKS_DIR``;
    it is absent in public-demo mode and in CI, where this is a no-op.

    Non-default like the generic bundles — the client rf-CSM importer keeps the enabled-default
    slot. ``directory`` overrides the configured path (used by tests). Returns the imported bank
    ids (empty when the directory is absent).
    """
    target = Path(directory) if directory is not None else Path(get_settings().client_banks_dir)
    return await _import_bank_bundles(db, target)
