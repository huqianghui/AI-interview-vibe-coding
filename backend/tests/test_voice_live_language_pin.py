"""Session-language pin (the "说着说着变中文" fix) — pure-shape guard, runs in zero-Azure CI.

The Voice Live proxy injects ONE system conversation item right after ``session.update`` that
pins the whole session to the candidate's explicit UI language choice. These tests lock the two
properties the fix depends on:

- the pinned language comes from the ``locale`` query param (the UI dropdown), never a guess;
- the item is a system message in the client-event shape ``_forward_client_to_azure`` relays,
  so ``conn.send`` accepts it in both agent and model modes.

Unlike ``test_voice_live_proxy`` this file has NO azure importorskip — ``build_language_pin_item``
is pure shaping and must stay importable (and tested) without the ``azure`` extra.
"""

from app.services.voice_live_proxy import build_language_pin_item


def test_pin_is_a_system_conversation_item():
    event = build_language_pin_item("en-US")
    assert event["type"] == "conversation.item.create"
    item = event["item"]
    assert item["type"] == "message"
    assert item["role"] == "system"
    assert item["content"][0]["type"] == "input_text"


def test_pin_names_the_ui_locale_language():
    text = build_language_pin_item("zh-CN")["item"]["content"][0]["text"]
    assert "中文" in text
    # The contract: one language for the ENTIRE session, no translation of provided questions,
    # switching only on the candidate's explicit request.
    assert "ENTIRE" in text
    assert "explicitly asks" in text


def test_pin_defaults_to_english_when_locale_missing():
    for locale in (None, "", "   "):
        text = build_language_pin_item(locale)["item"]["content"][0]["text"]
        assert "SESSION LANGUAGE: English" in text


def test_pin_passes_unknown_locale_through():
    text = build_language_pin_item("fr-FR")["item"]["content"][0]["text"]
    assert "SESSION LANGUAGE: fr-FR" in text
