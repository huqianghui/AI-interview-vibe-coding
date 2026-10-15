"""Voice Live model resolution — pure priority guard, runs in zero-Azure CI.

History, in three steps:

1. The MODEL-mode Voice Live model used to be hardcoded to the ``.env``
   ``VOICE_LIVE_DEFAULT_MODEL`` (read once via ``get_settings()``'s ``lru_cache``), so a model
   change in the admin UI silently had NO effect until a restart. #99 made it follow user config:
   ``persona.model`` → master ``model_or_deployment`` → env.
2. v0.43 split the voice model into ``service_config.voice_model`` and dropped both inference tiers,
   because native Voice Live accepts only the models it hosts in the region (measured:
   ``gpt-5.4-mini`` is a real deployment and is "not supported in this region").
3. v0.72 (owner, 2026-10-15): the persona's own model is the DEFAULT again, and the Connection
   tab's voice model is an OVERRIDE on top of it. ``model_or_deployment`` stays out — it is the
   judge/scoring model. The step-2 risk is handled at save time instead: the agent editor
   live-checks a changed model against Voice Live (``voice_model_check`` on the persona response).

Like ``test_voice_live_reader_prompt``, this has NO azure importorskip — both functions are pure and
must stay importable and tested without the ``azure`` extra.
"""

from app.api.voice_live_ws import resolve_byom_profile, resolve_voice_model

ENV = "gpt-4o"


def test_connection_override_wins_over_persona_and_env():
    assert resolve_voice_model("gpt-5-mini", "gpt-6-luna", ENV) == "gpt-5-mini"


def test_persona_model_is_the_default_without_an_override():
    assert resolve_voice_model(None, "gpt-6-luna", ENV) == "gpt-6-luna"
    assert resolve_voice_model("", "gpt-6-luna", ENV) == "gpt-6-luna"


def test_env_used_only_when_no_user_config():
    assert resolve_voice_model(None, None, ENV) == ENV
    assert resolve_voice_model("", "", ENV) == ENV


def test_blank_value_does_not_shadow_the_next_tier():
    # The ServiceConfig default is "" and an all-whitespace cell is just as empty; neither may
    # shadow the next tier (that would connect with model="" and fail every session).
    assert resolve_voice_model("   ", "gpt-6-luna", ENV) == "gpt-6-luna"
    assert resolve_voice_model("   ", "  ", ENV) == ENV


def test_resolved_model_is_stripped():
    # Values arrive from DB text columns / env; trailing whitespace must not reach the Azure
    # connect() model string (Voice Live matches the model name exactly).
    assert resolve_voice_model("  gpt-5-mini  ", None, ENV) == "gpt-5-mini"
    assert resolve_voice_model(None, " gpt-6-luna ", ENV) == "gpt-6-luna"


def test_inference_model_can_never_reach_the_voice_session():
    """``model_or_deployment`` is the judge/scoring model: no parameter lets it in."""
    import inspect

    params = list(inspect.signature(resolve_voice_model).parameters)
    assert params == ["master_voice_model", "persona_model", "env_model"]


def test_native_mode_never_carries_a_profile():
    # A profile on the native path is a different connection path altogether; a stale stored value
    # must not leak onto the wire when the operator switches back to native.
    assert resolve_byom_profile("native", "byom-azure-openai-chat-completion") == ""
    assert resolve_byom_profile(None, "byom-azure-openai-chat-completion") == ""
    assert resolve_byom_profile("", "byom-azure-openai-chat-completion") == ""


def test_byom_mode_passes_the_stored_profile():
    assert (
        resolve_byom_profile("byom", "byom-azure-openai-chat-completion")
        == "byom-azure-openai-chat-completion"
    )
    # Mode comparison is case/whitespace tolerant: it comes from a DB text column.
    assert resolve_byom_profile(" BYOM ", " byom-foundry-anthropic-messages ") == (
        "byom-foundry-anthropic-messages"
    )


def test_byom_mode_without_a_stored_profile_stays_native():
    # Half-configured must degrade to the native path rather than put profile="" on the wire.
    assert resolve_byom_profile("byom", "") == ""
    assert resolve_byom_profile("byom", None) == ""
