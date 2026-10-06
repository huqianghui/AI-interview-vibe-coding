"""judge_flow's freshness and budget exits that the API tests never reach.

Each one is a race the route cannot be driven into deterministically over HTTP: the session moving
on WHILE the judge's LLM call is in flight, or between a dry run and its delivery. The scripted
judge adapter's callable response is what puts the competing write in the middle of the call.
"""

import pytest
from sqlalchemy import update

from app.interview import judge_flow
from app.models.interview import InterviewSession
from tests.test_interview_api import _events, _judge_body, _judged_setup

NUDGE = '{"verdict": "nudge", "speech_text": "Please go on.", "reason": "trailed off"}'


async def _bump_turn_version(db_session, interview_id: str) -> None:
    """What a concurrent /answer or /restart commits: a new turn_version on the session row.

    Written through a SECOND session, as another request would: committing through the route's
    own session would expire its loaded row and hide exactly the staleness under test.
    """
    async with db_session._test_factory() as other:
        await other.execute(
            update(InterviewSession)
            .where(InterviewSession.id == interview_id)
            .values(turn_version=InterviewSession.turn_version + 1)
        )
        await other.commit()


@pytest.mark.asyncio
async def test_a_submit_during_the_llm_call_turns_the_verdict_into_a_silent_wait(
    client, db_session, scripted_judge
):
    headers, iv, qid = await _judged_setup(client, db_session)

    async def answered_meanwhile(_prompt: str) -> str:
        await _bump_turn_version(db_session, iv)
        return NUDGE

    scripted_judge.responses.append(answered_meanwhile)
    resp = await client.post(
        f"/candidate/interview/{iv}/judge", headers=headers, json=_judge_body(qid)
    )
    assert resp.json()["verdict"] == "wait"
    # No row, so no budget slot spent on a question the candidate already left.
    assert await _events(db_session, iv) == []


async def _dry_nudge(client, headers, iv, qid, scripted_judge) -> str:
    scripted_judge.responses.append(NUDGE)
    dry = await client.post(
        f"/candidate/interview/{iv}/judge",
        headers=headers,
        json={**_judge_body(qid), "dry_run": True},
    )
    assert dry.json()["verdict"] == "nudge"
    return dry.json()["event_id"]


@pytest.mark.asyncio
async def test_apply_with_a_moved_follow_up_count_waits_and_leaves_the_event_undelivered(
    client, db_session, scripted_judge
):
    headers, iv, qid = await _judged_setup(client, db_session)
    event_id = await _dry_nudge(client, headers, iv, qid, scripted_judge)

    resp = await client.post(
        f"/candidate/interview/{iv}/judge/apply",
        headers=headers,
        json={"event_id": event_id, "question_id": qid, "follow_ups_asked": 1},
    )
    assert resp.json() == {
        "verdict": "wait",
        "speech_text": "",
        "event_id": event_id,
        "interview": None,
    }
    assert [e.applied for e in await _events(db_session, iv)] == [False]


@pytest.mark.asyncio
async def test_apply_when_the_session_moves_on_mid_apply_waits_and_leaves_the_event_undelivered(
    client, db_session, scripted_judge, monkeypatch
):
    headers, iv, qid = await _judged_setup(client, db_session)
    event_id = await _dry_nudge(client, headers, iv, qid, scripted_judge)

    # A /restart lands after apply's own question/follow-up checks, before its write: the budget
    # lookup is the step in that gap.
    real_usage = judge_flow._judge_usage

    async def usage_then_restart(db, session_id, question_id):
        used = await real_usage(db, session_id, question_id)
        await _bump_turn_version(db_session, iv)
        return used

    monkeypatch.setattr(judge_flow, "_judge_usage", usage_then_restart)

    resp = await client.post(
        f"/candidate/interview/{iv}/judge/apply",
        headers=headers,
        json={"event_id": event_id, "question_id": qid, "follow_ups_asked": 0},
    )
    assert resp.json()["verdict"] == "wait"
    assert [e.applied for e in await _events(db_session, iv)] == [False]


@pytest.mark.asyncio
async def test_the_raw_llm_call_bound_stops_a_chatty_answer(client, db_session, scripted_judge):
    # max_calls=1 ⇒ at most JUDGE_LLM_CALLS_PER_APPLIED raw calls, delivered or not.
    headers, iv, qid = await _judged_setup(client, db_session, max_calls=1)
    for _ in range(judge_flow.JUDGE_LLM_CALLS_PER_APPLIED):
        dry = await client.post(
            f"/candidate/interview/{iv}/judge",
            headers=headers,
            json={**_judge_body(qid), "dry_run": True},
        )
        assert dry.json()["verdict"] == "wait"  # the scripted default
    calls_before = len(scripted_judge.prompts)
    over = await client.post(
        f"/candidate/interview/{iv}/judge",
        headers=headers,
        json={**_judge_body(qid), "dry_run": True},
    )
    assert over.json()["verdict"] == "wait"
    assert len(scripted_judge.prompts) == calls_before  # no LLM call made
    assert len(await _events(db_session, iv)) == judge_flow.JUDGE_LLM_CALLS_PER_APPLIED
