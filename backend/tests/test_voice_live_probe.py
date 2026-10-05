"""The Voice Live model probe: verdict taxonomy, orchestration, and the result cache.

Every payload asserted here is a VERBATIM server response captured from the live swedencentral
resource on 2026-10-05 (api-version 2026-01-01-preview, Entra auth) and written up in
``docs/voice-live-model-support.md`` §4.4. That matters: the taxonomy decides whether a save is
blocked, so inventing plausible-looking error strings here would quietly make the gate wrong.

Azure-free — ``app.services.voice_live_probe`` imports the SDK lazily inside ``probe_model``, so the
classifier, the orchestration and the cache are all testable with no ``azure`` extra.
"""

import asyncio

import pytest

from app.services import voice_live_probe as probe

# --- verbatim server payloads (see module docstring) ---------------------------------------------
NATIVE_REGION_REJECT = (
    '{"message": "Model gpt-5.4-mini is not supported in this region.", '
    '"type": "invalid_request_error", "code": "invalid_model", "param": null}'
)
BAD_PROFILE = (
    '{"message": "Profile byom-not-a-real-profile is not supported.", '
    '"type": "invalid_request_error", "code": "invalid_profile", "param": null, "event_id": null}'
)
PROTOCOL_MISMATCH = (
    '{"message": "Connection error to BYOM Realtime service: status 400, message: Invalid '
    'response status", "type": "invalid_request_error", "code": "byom_realtime_connection_error", '
    '"param": null, "event_id": null}'
)


def test_session_updated_is_accepted():
    assert probe.classify_probe_result({"type": "session.updated"}, None)[0] == probe.ACCEPTED


def test_region_rejection_is_definitive():
    verdict, detail = probe.classify_probe_result(None, NATIVE_REGION_REJECT)
    assert verdict == probe.REJECTED_REGION
    assert probe.is_definitive_rejection(verdict)
    assert "not supported in this region" in detail  # the payload is kept verbatim for the operator


def test_bad_byom_profile_is_definitive():
    # Measured: the profile IS validated at connect, so a typo can be caught on save rather than
    # surfacing as a broken interview.
    verdict, _ = probe.classify_probe_result(None, BAD_PROFILE)
    assert verdict == probe.REJECTED_PROFILE
    assert probe.is_definitive_rejection(verdict)


def test_byom_protocol_mismatch_is_definitive():
    # A chat deployment under byom-azure-openai-realtime: also caught at connect.
    verdict, _ = probe.classify_probe_result(None, PROTOCOL_MISMATCH)
    assert verdict == probe.REJECTED_BYOM
    assert probe.is_definitive_rejection(verdict)


def test_an_error_event_is_classified_from_its_payload():
    # The service may answer with an `error` EVENT rather than failing the upgrade; same verdict.
    event = {
        "type": "error",
        "error": {"message": "Model x is not supported in this region.", "code": "invalid_model"},
    }
    assert probe.classify_probe_result(event, None)[0] == probe.REJECTED_REGION


def test_timeout_and_unknown_are_not_definitive():
    # "We could not tell" must never block a save — offline/CI admins still need to save.
    assert probe.classify_probe_result(None, None) == (
        probe.ERROR,
        "no server event before timeout",
    )
    assert not probe.is_definitive_rejection(probe.ERROR)
    verdict, _ = probe.classify_probe_result(None, "ClientConnectorError: cannot connect to host")
    assert verdict == probe.ERROR
    assert not probe.is_definitive_rejection(verdict)


def test_a_missing_deployment_name_is_not_something_a_probe_can_see():
    """The measured BYOM blind spot, locked so nobody "fixes" the gate into a false guarantee.

    A nonexistent deployment name connected fine (ACCEPTED), so the taxonomy must not be read as
    proof the deployment exists. The guarantee for that comes from listing the resource's real
    deployments, not from here.
    """
    assert probe.classify_probe_result({"type": "session.updated"}, None)[0] == probe.ACCEPTED


def test_the_native_candidate_list_keeps_the_known_rejects():
    # The docs name gpt-5.5 / gpt-5.4-mini / gpt-5.4-nano as "supported but NOT pre-deployed".
    # Keeping them in the probe list is what makes a run self-checking, so a well-meaning cleanup
    # that drops them would silently remove the control group.
    for expected_reject in ("gpt-5.5", "gpt-5.4-mini", "gpt-5.4-nano"):
        assert expected_reject in probe.NATIVE_MODEL_CANDIDATES
    assert probe.DEFAULT_BYOM_PROFILE in probe.BYOM_PROFILES


def test_probe_models_preserves_input_order_and_bounds_concurrency(monkeypatch):
    live = 0
    peak = 0

    async def fake_probe_model(*, model, **_kw):
        nonlocal live, peak
        live += 1
        peak = max(peak, live)
        await asyncio.sleep(0)
        live -= 1
        return {"model": model, "verdict": probe.ACCEPTED}

    monkeypatch.setattr(probe, "probe_model", fake_probe_model)
    models = [f"m{i}" for i in range(10)]
    results = asyncio.run(
        probe.probe_models(
            endpoint="https://x.services.ai.azure.com",
            credential=object(),
            api_version="2026-01-01-preview",
            models=models,
            concurrency=3,
        )
    )
    assert [r["model"] for r in results] == models  # order is the caller's, not completion order
    assert peak <= 3


def test_list_native_models_returns_accepted_only_and_caches(monkeypatch):
    probe.clear_native_cache()
    calls = 0

    async def fake_probe_models(**_kw):
        nonlocal calls
        calls += 1
        return [
            {"model": "gpt-5-mini", "verdict": probe.ACCEPTED},
            {"model": "gpt-5.4-mini", "verdict": probe.REJECTED_REGION},
            {"model": "flaky", "verdict": probe.ERROR},
        ]

    async def fake_credential(_api_key):
        return object(), True

    monkeypatch.setattr(probe, "probe_models", fake_probe_models)
    monkeypatch.setattr(
        "app.services.voice_live_proxy._resolve_voice_live_credential", fake_credential
    )
    kwargs = {
        "endpoint": "https://x.services.ai.azure.com",
        "api_key": "",
        "api_version": "2026-01-01-preview",
    }

    first = asyncio.run(probe.list_native_models(**kwargs))
    # Only ACCEPTED is offered: a region-rejected or inconclusive model must never be selectable,
    # which is the whole promise of the dropdown.
    assert first == ["gpt-5-mini"]

    assert asyncio.run(probe.list_native_models(**kwargs)) == ["gpt-5-mini"]
    assert calls == 1, "a cached list must not re-probe (23 live connections per page load)"

    assert asyncio.run(probe.list_native_models(refresh=True, **kwargs)) == ["gpt-5-mini"]
    assert calls == 2, "refresh=True must re-probe"

    # The cache is per endpoint: a different resource is a different region catalogue.
    asyncio.run(
        probe.list_native_models(**{**kwargs, "endpoint": "https://y.services.ai.azure.com"})
    )
    assert calls == 3
    probe.clear_native_cache()


def test_cached_list_is_a_copy_so_callers_cannot_poison_it(monkeypatch):
    probe.clear_native_cache()

    async def fake_probe_models(**_kw):
        return [{"model": "gpt-5-mini", "verdict": probe.ACCEPTED}]

    async def fake_credential(_api_key):
        return object(), True

    monkeypatch.setattr(probe, "probe_models", fake_probe_models)
    monkeypatch.setattr(
        "app.services.voice_live_proxy._resolve_voice_live_credential", fake_credential
    )
    kwargs = {"endpoint": "https://x.services.ai.azure.com", "api_key": "", "api_version": "v"}
    got = asyncio.run(probe.list_native_models(**kwargs))
    got.append("injected")
    assert asyncio.run(probe.list_native_models(**kwargs)) == ["gpt-5-mini"]
    probe.clear_native_cache()


@pytest.mark.parametrize("mode", ["native", "byom"])
def test_probe_model_is_importable_without_the_azure_extra(mode):
    # The SDK import lives inside probe_model, so the module (and everything above) stays usable in
    # zero-Azure CI. Guard that nobody hoists it to module level.
    import inspect

    src = inspect.getsource(probe.probe_model)
    assert "from azure.ai.voicelive.aio import connect" in src
    assert mode in ("native", "byom")
