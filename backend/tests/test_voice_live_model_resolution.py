"""Voice Live model resolution — pure priority guard, runs in zero-Azure CI.

History, in two steps, because the second step undoes part of the first ON PURPOSE:

1. The MODEL-mode Voice Live model used to be hardcoded to the ``.env``
   ``VOICE_LIVE_DEFAULT_MODEL`` (read once via ``get_settings()``'s ``lru_cache``), so a model
   change in the admin UI silently had NO effect until a restart. #99 made it follow user config:
   ``persona.model`` → master ``model_or_deployment`` → env.
2. That chain fed the INFERENCE model into Voice Live, and the two take different kinds of name:
   judge / scoring / the Foundry agent address models by DEPLOYMENT NAME in the resource, while
   Voice Live MODEL mode accepts only models it hosts natively in the region. Measured on the live
   resource: ``gpt-5.4-mini`` is a real deployment and native Voice Live answers "Model gpt-5.4-mini
   is not supported in this region". So the voice model became its own setting
   (``service_config.voice_model``) and BOTH inference tiers were removed from this chain.

What step 2 kept from #99: the model still comes from user config, is still read from the DB per
connection, and is still never frozen by the env cache. What it dropped: the per-persona tier (a
second place an illegal value could enter) — ``persona.model`` now drives the agent / inference side
only.

Like ``test_voice_live_reader_prompt``, this has NO azure importorskip — both functions are pure and
must stay importable and tested without the ``azure`` extra.
"""

from app.api.voice_live_ws import resolve_byom_profile, resolve_voice_model

ENV = "gpt-4o"


def test_saved_voice_model_wins_over_env():
    assert resolve_voice_model("gpt-5-mini", ENV) == "gpt-5-mini"


def test_env_used_only_when_no_user_config():
    # voice_model is nullable/"" — unset means "fall back to the env default".
    assert resolve_voice_model(None, ENV) == ENV
    assert resolve_voice_model("", ENV) == ENV


def test_blank_value_does_not_shadow_env():
    # The ServiceConfig default is "" and an all-whitespace cell is just as empty; neither may
    # shadow the env fallback (that would connect with model="" and fail every session).
    assert resolve_voice_model("   ", ENV) == ENV


def test_resolved_model_is_stripped():
    # Values arrive from a DB text column / env; trailing whitespace must not reach the Azure
    # connect() model string (Voice Live matches the model name exactly).
    assert resolve_voice_model("  gpt-5-mini  ", ENV) == "gpt-5-mini"


def test_inference_model_can_never_reach_the_voice_session():
    """The regression this split exists to prevent.

    ``resolve_voice_model`` takes the VOICE model only — there is no parameter through which
    ``service_config.model_or_deployment`` or ``persona.model`` could arrive, so saving an own
    deployment as the inference model cannot break voice with "not supported in this region".
    """
    import inspect

    params = list(inspect.signature(resolve_voice_model).parameters)
    assert params == ["master_voice_model", "env_model"]


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
