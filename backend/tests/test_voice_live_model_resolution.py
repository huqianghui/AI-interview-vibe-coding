"""Voice Live model resolution — pure priority guard, runs in zero-Azure CI.

The EXTERNAL/MODEL-mode Voice Live model used to be hardcoded to the ``.env``
``VOICE_LIVE_DEFAULT_MODEL`` (read once via ``get_settings()``'s ``lru_cache``), so a model change
in the admin UI silently had NO effect and required a backend restart. The owner directive is that
the model must follow USER CONFIG: per-persona first, then the admin-saved master config, then the
env value only as a last resort. These tests lock that priority order so it can't regress back into
env-only behavior (the "怎么改坏的" scenario).

Like ``test_voice_live_reader_prompt``, this has NO azure importorskip — ``resolve_voice_model`` is
pure and must stay importable and tested without the ``azure`` extra.
"""

from app.api.voice_live_ws import resolve_voice_model

ENV = "gpt-4o"


def test_persona_model_wins_over_everything():
    assert resolve_voice_model("gpt-5.4-mini", "gpt-4o-mini", ENV) == "gpt-5.4-mini"


def test_master_config_used_when_persona_model_is_absent():
    # persona.model is nullable — null means "fall back to the global config", not "use env".
    assert resolve_voice_model(None, "gpt-4o-mini", ENV) == "gpt-4o-mini"


def test_env_used_only_when_no_user_config():
    assert resolve_voice_model(None, None, ENV) == ENV


def test_blank_values_do_not_shadow_the_next_source():
    # An empty/whitespace master_or_deployment row (the ServiceConfig default is "") must NOT
    # shadow the env fallback, and a blank persona.model must fall through to master.
    assert resolve_voice_model("", "", ENV) == ENV
    assert resolve_voice_model("   ", "gpt-4o-mini", ENV) == "gpt-4o-mini"
    assert resolve_voice_model("gpt-5.4-mini", "  ", ENV) == "gpt-5.4-mini"


def test_resolved_model_is_stripped():
    # Values arrive from a DB text column / env; trailing whitespace must not reach the Azure
    # connect() model string (Voice Live matches the model name exactly).
    assert resolve_voice_model("  gpt-5.4-mini  ", None, ENV) == "gpt-5.4-mini"
