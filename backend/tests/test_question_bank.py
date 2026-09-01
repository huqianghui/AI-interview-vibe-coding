"""Question bank (SPEC F2): bank/question service, one-enabled-default, seed, and the state
machine resolving from a seeded bank instead of the fallback."""

import json

import pytest

from app.interview import state_machine
from app.interview.questions import resolve_questions
from app.services import question_seed
from app.services import question_service as svc
from app.services.anonymous_session_service import create_anonymous_session


async def test_first_default_bank_is_the_default(db_session):
    bank = await svc.create_bank(db_session, name="B1", is_default=True)
    assert (await svc.get_default_bank(db_session)).id == bank.id


async def test_promoting_new_default_demotes_old(db_session):
    first = await svc.create_bank(db_session, name="first", is_default=True)
    second = await svc.create_bank(db_session, name="second", is_default=True)
    assert (await svc.get_default_bank(db_session)).id == second.id
    await db_session.refresh(first)
    assert first.is_default is False


async def test_questions_returned_in_order_index(db_session):
    bank = await svc.create_bank(db_session, name="B", is_default=True)
    # Insert out of order; the read must sort by order_index.
    await svc.add_question(db_session, bank_id=bank.id, text="third", order_index=2)
    await svc.add_question(db_session, bank_id=bank.id, text="first", order_index=0)
    await svc.add_question(db_session, bank_id=bank.id, text="second", order_index=1)
    rows = await svc.list_questions_for_bank(db_session, bank.id)
    assert [r.text for r in rows] == ["first", "second", "third"]


async def test_disabled_questions_excluded(db_session):
    bank = await svc.create_bank(db_session, name="B", is_default=True)
    await svc.add_question(db_session, bank_id=bank.id, text="on", order_index=0)
    await svc.add_question(db_session, bank_id=bank.id, text="off", order_index=1, enabled=False)
    rows = await svc.list_questions_for_bank(db_session, bank.id)
    assert [r.text for r in rows] == ["on"]


# --- seed (AC #1) ----------------------------------------------------------


async def test_seed_installs_default_bank_with_ten_questions(db_session):
    bank_id = await question_seed.seed_default_bank(db_session)
    assert bank_id is not None
    rows = await svc.list_questions_for_bank(db_session, bank_id)
    assert len(rows) == 10
    # Ordered 0..9 with no gaps.
    assert [r.order_index for r in rows] == list(range(10))


async def test_seed_is_idempotent(db_session):
    first = await question_seed.seed_default_bank(db_session)
    second = await question_seed.seed_default_bank(db_session)  # default already exists → no-op
    assert first is not None
    assert second is None
    assert len(await svc.list_banks(db_session)) == 1


# --- committed generic bank bundles (issue 2: match local's multi-bank catalogue) -----------


async def test_seed_bundled_banks_imports_committed_generic_banks(db_session):
    # The three committed generic bundles (Demo / Deployment SOP / test) are imported alongside
    # whatever default already exists, all en-US, and none claims the enabled-default slot.
    ids = await question_seed.seed_bundled_banks(db_session)
    assert len(ids) == 3
    banks = {b.name: b for b in await svc.list_banks(db_session)}
    assert {"Demo interview bank", "Deployment SOP Interview", "test-demo01"} <= set(banks)
    for name in ("Demo interview bank", "Deployment SOP Interview", "test-demo01"):
        assert banks[name].language == "en-US"
        assert banks[name].is_default is False


async def test_seed_bundled_banks_is_idempotent_and_preserves_default(db_session):
    # A committed generic bundle must never steal the default slot from the boot importer's bank,
    # and re-running (every boot) converges by name rather than duplicating.
    rf = await svc.create_bank(db_session, name="rf-CSM (client)", is_default=True)
    await question_seed.seed_bundled_banks(db_session)
    await question_seed.seed_bundled_banks(db_session)  # second boot: replace-by-name, no dupes
    banks = await svc.list_banks(db_session)
    names = [b.name for b in banks]
    assert names.count("Demo interview bank") == 1  # not duplicated across the two runs
    assert len(banks) == 4  # rf-CSM default + 3 generic
    assert (await svc.get_default_bank(db_session)).id == rf.id  # default untouched


async def test_seed_bundled_banks_public_demo_keeps_a_default(db_session):
    # Public-demo boot order (main.py): seed_default_bank creates "Demo interview bank" as the
    # default, THEN seed_bundled_banks imports a same-named non-default bundle that replaces it.
    # The seeder must restore the default so the interview doesn't drop to the built-in fallback.
    await question_seed.seed_default_bank(db_session)  # "Demo interview bank" is now default
    await question_seed.seed_bundled_banks(db_session)
    default = await svc.get_default_bank(db_session)
    assert default is not None
    assert default.name == "Demo interview bank"


async def test_seed_bundled_bank_preserves_hand_authored_rubric(db_session):
    # The bundle importer writes the rubric verbatim (unlike add_question's LLM auto-draft), so a
    # seeded generic bank keeps its checklist items — proving the multi-bank seed is scoreable.
    await question_seed.seed_bundled_banks(db_session)
    banks = {b.name: b for b in await svc.list_banks(db_session)}
    from app.services import checklist_service

    dep = banks["Deployment SOP Interview"]
    rows = await svc.list_questions_for_bank(db_session, dep.id)
    total_items = 0
    for q in rows:
        cl = await checklist_service.get_default_checklist(db_session, q.id)
        if cl is not None:
            total_items += len(await checklist_service.list_items(db_session, cl.id))
    assert total_items > 0  # rubric survived the export→commit→import round-trip


# --- client bank bundles via the private-blob channel (task #42) ------------------------------


def _client_bundle(name: str, *, is_default: bool = True) -> dict:
    """A minimal bank bundle as export_bank_bundle would emit it, for a private client bank."""
    return {
        "format_version": 1,
        "bank": {"name": name, "language": "en-US", "is_default": is_default},
        "questions": [
            {
                "text": "How do you oversee safety reporting across EMEA?",
                "order_index": 0,
                "weight": 1,
                "max_follow_ups": 0,
                "checklist": {
                    "items": [
                        {"kind": "criterion", "text": "Regional governance model", "weight": 100},
                    ]
                },
            }
        ],
    }


async def test_seed_client_banks_imports_from_external_dir(db_session, tmp_path):
    # Client-derived banks arrive via the private-blob channel (never committed): a directory of
    # *.json bundles is imported alongside the default, all non-default regardless of the bundle.
    (tmp_path / "demo01.bank.json").write_text(
        json.dumps(_client_bundle("rf-CSM demo01", is_default=True)), encoding="utf-8"
    )
    ids = await question_seed.seed_client_banks(db_session, directory=tmp_path)
    assert len(ids) == 1
    bank = next(b for b in await svc.list_banks(db_session) if b.name == "rf-CSM demo01")
    assert bank.is_default is False  # forced non-default even though the bundle asked for default
    assert bank.language == "en-US"


async def test_seed_client_banks_absent_dir_is_noop(db_session):
    # Public-demo mode / CI: no client bundle extracted → the configured dir is absent → no-op.
    ids = await question_seed.seed_client_banks(db_session, directory="/nonexistent/extra_banks")
    assert ids == []


async def test_seed_client_banks_preserves_default(db_session, tmp_path):
    # The boot importer's rf-CSM bank keeps the enabled-default slot across a client bank import.
    rf = await svc.create_bank(db_session, name="rf-CSM (client default)", is_default=True)
    (tmp_path / "demo01.bank.json").write_text(
        json.dumps(_client_bundle("rf-CSM demo01")), encoding="utf-8"
    )
    await question_seed.seed_client_banks(db_session, directory=tmp_path)
    await question_seed.seed_client_banks(db_session, directory=tmp_path)  # idempotent by name
    banks = await svc.list_banks(db_session)
    assert [b.name for b in banks].count("rf-CSM demo01") == 1  # no dupes across boots
    assert (await svc.get_default_bank(db_session)).id == rf.id  # default untouched


# --- state machine resolves from the seeded bank ---------------------------


async def test_resolve_questions_uses_seeded_bank(db_session):
    await question_seed.seed_default_bank(db_session)
    questions = await resolve_questions(db_session)
    assert len(questions) == 10  # not the 2-item fallback
    assert questions[0].id  # real DB ids, not "q1"/"q2"


async def test_interview_runs_over_seeded_bank(db_session):
    await question_seed.seed_default_bank(db_session)
    cand, _ = await create_anonymous_session(db_session, ip_address="1.2.3.4")
    interview = await state_machine.start_interview(db_session, cand.id)
    q = await state_machine.get_current_question(db_session, interview)
    assert q["total"] == 10  # driven by the seeded bank, not the fallback


async def test_set_default_bank_switches_and_keeps_one(db_session):
    a = await svc.create_bank(db_session, name="a", is_default=True)
    b = await svc.create_bank(db_session, name="b")  # non-default
    await svc.set_default_bank(db_session, b.id)
    assert (await svc.get_default_bank(db_session)).id == b.id
    await db_session.refresh(a)
    assert a.is_default is False
    enabled_defaults = [x for x in await svc.list_banks(db_session) if x.enabled and x.is_default]
    assert len(enabled_defaults) == 1


async def test_set_default_bank_missing_raises(db_session):
    with pytest.raises(svc.QuestionBankNotFound):
        await svc.set_default_bank(db_session, "nope")


async def test_no_default_bank_falls_back_to_builtin(db_session):
    # With no bank seeded, the state machine's question source is the fallback pair.
    questions = await resolve_questions(db_session)
    assert len(questions) == 2
    assert questions[0].id == "q1"


async def test_expected_points_round_trip(db_session):
    bank = await svc.create_bank(db_session, name="B", is_default=True)
    await svc.add_question(
        db_session,
        bank_id=bank.id,
        text="q",
        order_index=0,
        expected_points=json.dumps(["a", "b"]),
    )
    questions = await resolve_questions(db_session)
    assert questions[0].expected_points == ("a", "b")
