"""EXTERNAL-mode reader prompt — pure-shape guard, runs in zero-Azure CI.

In external mode the persona is a pure "mouth" running MODEL mode with no Foundry agent, so the
reading contract can't ride on agent ``instructions``. The proxy injects it as ONE system
conversation item right after ``session.update`` — the same channel ``build_language_pin_item``
uses. These tests lock the shape the item MUST have so ``conn.send`` accepts it in model mode, and
that the persona-default reading contract carries the invariant clauses (read verbatim, then wait,
don't decide the questions).

Like ``test_voice_live_language_pin`` and unlike ``test_voice_live_proxy``, this file has NO azure
importorskip — both ``build_reader_prompt_item`` and ``default_external_reader_prompt`` are pure and
must stay importable (and tested) without the ``azure`` extra.
"""

from app.models.persona import default_external_reader_prompt
from app.services.voice_live_proxy import build_reader_prompt_item


def test_reader_prompt_is_a_system_conversation_item():
    event = build_reader_prompt_item("Read this exactly.")
    assert event["type"] == "conversation.item.create"
    item = event["item"]
    assert item["type"] == "message"
    assert item["role"] == "system"
    assert item["content"][0]["type"] == "input_text"


def test_reader_prompt_carries_the_text_verbatim():
    # The builder is a pure envelope — it must forward whatever text it's handed unchanged (the
    # per-persona reader prompt or the generated default), not rewrite or wrap it.
    text = "You are Ava. Say only what you are given."
    assert build_reader_prompt_item(text)["item"]["content"][0]["text"] == text


def test_default_reader_prompt_names_the_persona_and_states_the_contract():
    # The generated default is a READING contract, not interviewer instructions: read verbatim,
    # stop and wait, and never decide the questions. Guards against it drifting into an
    # ask-follow-ups persona (which would make external mode improvise off-script).
    text = default_external_reader_prompt("Ava")
    assert "Ava" in text  # name-aware, so the mouth introduces itself correctly
    lowered = text.lower()
    assert "exactly" in lowered  # read the provided text EXACTLY as written
    assert "stop and wait" in lowered  # read once, then wait for the next injected text
    assert "do not decide the questions" in lowered  # the external system is the brain
    assert "never translate" in lowered  # read in the language it's written in
    # Issue 6: the mouth model prepended acknowledgments ("Understood. <question>") that the
    # transcript then showed as if the external system had said them. The contract must forbid
    # acknowledgment openers and demand the reply start at the provided text's first word.
    assert "first word" in lowered
    assert '"understood"' in lowered  # named as a banned opener (with 好的/明白/收到 for zh)
