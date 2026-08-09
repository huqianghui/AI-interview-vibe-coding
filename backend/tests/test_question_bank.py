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
