"""Voice Live connection PLAN (pure, azure-free): which personas are a "mouth" vs an agent session.

Locks the v0.38.3.1 fix: a LINEAR-TURNS bank persona must connect exactly like an external one —
MODEL mode + reader prompt (``is_mouth_persona`` True) — because in agent mode the agent's own
"acknowledge the answer" instruction hijacked the response meant to read the next question
("Thank you." instead of question 2; live-verified 2026-09-24). Only the editor Playground keeps
the agent, for a free conversation that tests a synced agent's instructions. The pre-v0.39
``bank_turn_mode="model"`` turn mode is retired (BANK_TURN_MODES = linear|judged); the migration
rewrites any stored ``"model"`` to ``"linear"``, so bank_turn_mode no longer selects the agent.
"""

from dataclasses import dataclass

from app.services.voice_live_proxy import is_mouth_persona, linear_turns_for_persona


@dataclass
class P:
    interview_brain: str = "bank"
    bank_turn_mode: str = "linear"
    agent_id: str = "interviewer-x:1"


def test_external_is_always_a_mouth_regardless_of_bank_mode_or_playground():
    for mode in ("linear", "judged"):
        for pg in (False, True):
            assert is_mouth_persona(P("external", mode), playground=pg) is True
            assert linear_turns_for_persona(P("external", mode), playground=pg) is True


def test_bank_linear_is_a_mouth_in_the_interview_but_keeps_its_agent_in_the_playground():
    assert is_mouth_persona(P("bank", "linear")) is True
    assert is_mouth_persona(P("bank", "linear"), playground=True) is False


def test_bank_judged_is_a_mouth_in_the_interview_but_keeps_its_agent_in_the_playground():
    # judged reads the bank text verbatim too; the judge nudges OFF the WebSocket (a separate
    # chat-completion call), never through a Voice Live model turn, so the candidate session is a
    # mouth exactly like linear. The Playground still keeps the agent for free conversation.
    assert is_mouth_persona(P("bank", "judged")) is True
    assert linear_turns_for_persona(P("bank", "judged")) is True
    assert is_mouth_persona(P("bank", "judged"), playground=True) is False
    assert linear_turns_for_persona(P("bank", "judged"), playground=True) is False


def test_retired_bank_model_value_never_resurrects_the_in_interview_agent():
    # The pre-v0.39 "model" turn mode is retired and the migration coerces stored "model" -> linear.
    # Even if a stale "model" value somehow reaches this pure plan, bank_turn_mode is no longer read
    # here at all: a bank candidate session is a mouth, full stop. This guards the retired branch
    # from ever coming back as an in-interview agent turn ("Thank you." regression, 2026-09-24).
    assert is_mouth_persona(P("bank", "model")) is True
    assert linear_turns_for_persona(P("bank", "model")) is True
    # Playground is the only surface that keeps the agent, and that is brain-independent.
    assert is_mouth_persona(P("bank", "model"), playground=True) is False


def test_legacy_persona_without_the_field_defaults_to_mouth():
    @dataclass
    class Legacy:
        interview_brain: str = "bank"
        agent_id: str = "x:1"

    assert is_mouth_persona(Legacy()) is True
