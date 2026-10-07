"""An interview keeps the bank and interviewer it started with (#187, AC4).

Before #187 the session pinned neither: every call re-read the CURRENT default bank, so switching
the default mid-interview pointed ``current_question_index`` into a different bank's questions.
"""

import pytest

from app.services import question_service
from tests.candidate_helpers import mint_candidate_headers


async def _bank(db, name: str, prompts: list[str], *, is_default: bool):
    bank = await question_service.create_bank(db, name=name, is_default=is_default)
    for i, text in enumerate(prompts):
        await question_service.add_question(db, bank_id=bank.id, text=text, order_index=i)
    return bank


@pytest.mark.asyncio
async def test_switching_the_default_bank_mid_interview_keeps_the_started_bank(client, db_session):
    await _bank(db_session, "A", ["A first?", "A second?"], is_default=True)
    bank_b = await _bank(db_session, "B", ["B first?", "B second?"], is_default=False)
    await db_session.commit()

    headers = await mint_candidate_headers(client)
    start = (await client.post("/candidate/interview/start", headers=headers)).json()
    interview_id = start["interview_session_id"]
    assert start["current_question"]["prompt"] == "A first?"

    await question_service.set_default_bank(db_session, bank_b.id)
    await db_session.commit()

    current = (await client.get(f"/candidate/interview/{interview_id}", headers=headers)).json()
    assert current["current_question"]["prompt"] == "A first?"

    after = (
        await client.post(
            f"/candidate/interview/{interview_id}/answer",
            headers=headers,
            json={"text": "I always follow the documented steps.", "source": "text"},
        )
    ).json()
    assert after["current_question"]["prompt"] == "A second?"
