"""Voice Live connection PLAN (pure, azure-free): which personas are a "mouth" vs an agent session.

Locks the v0.38.3.1 fix: a LINEAR-TURNS bank persona must connect exactly like an external one —
MODEL mode + reader prompt (``is_mouth_persona`` True) — because in agent mode the agent's own
"acknowledge the answer" instruction hijacked the response meant to read the next question
("Thank you." instead of question 2; live-verified 2026-09-24). Bank MODEL-turn personas and the
editor Playground keep the agent.
"""

from dataclasses import dataclass

from app.services.voice_live_proxy import is_mouth_persona, linear_turns_for_persona


@dataclass
class P:
    interview_brain: str = "bank"
    bank_turn_mode: str = "linear"
    agent_id: str = "interviewer-x:1"


def test_external_is_always_a_mouth_regardless_of_bank_mode_or_playground():
    for mode in ("linear", "model"):
        for pg in (False, True):
            assert is_mouth_persona(P("external", mode), playground=pg) is True
            assert linear_turns_for_persona(P("external", mode), playground=pg) is True


def test_bank_linear_is_a_mouth_in_the_interview_but_keeps_its_agent_in_the_playground():
    assert is_mouth_persona(P("bank", "linear")) is True
    assert is_mouth_persona(P("bank", "linear"), playground=True) is False


def test_bank_model_turn_keeps_the_agent_everywhere():
    assert is_mouth_persona(P("bank", "model")) is False
    assert is_mouth_persona(P("bank", "model"), playground=True) is False


def test_legacy_persona_without_the_field_defaults_to_mouth():
    @dataclass
    class Legacy:
        interview_brain: str = "bank"
        agent_id: str = "x:1"

    assert is_mouth_persona(Legacy()) is True
