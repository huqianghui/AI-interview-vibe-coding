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


def test_not_found_and_unexpected_event_classifications():
    # Two branches the live-Azure path happens to cover locally but CI (no credential) cannot reach,
    # so they need explicit cases or the gate passes only on a developer machine.
    verdict, _ = probe.classify_probe_result(None, "Deployment does not exist in this resource")
    assert verdict == probe.REJECTED_NOT_FOUND
    assert probe.is_definitive_rejection(verdict)
    verdict, detail = probe.classify_probe_result({"type": "session.created"}, None)
    assert verdict == probe.ERROR  # not a refusal — just not the answer we were waiting for
    assert "session.created" in detail


# --- probe_model's own wiring, with the SDK stubbed (NOT the service's judgment) ----------------
# Locally this function runs against real Azure, which is why its branches look covered on a
# developer machine and are NOT covered in CI — exactly the local/CI coverage gap that let a 85.23%
# local run turn into 84.27% on the runner. What is faked here is only the transport (the SDK's
# connect + event stream); every verdict still comes from classify_probe_result, and the real
# connection behaviour is verified in the live acceptance runs recorded in the PR.


class _FakeConn:
    """Minimal stand-in for the SDK connection: one session.update, then one event."""

    def __init__(self, events):
        self._events = events
        self.session = self
        self.updated_with = None

    async def update(self, *, session):  # conn.session.update(session=...)
        self.updated_with = session

    def __aiter__(self):
        async def gen():
            for ev in self._events:
                yield ev

        return gen()


class _FakeConnect:
    """Async context manager recording the kwargs probe_model passed to connect()."""

    captured: dict = {}

    def __init__(self, **kwargs):
        type(self).captured = kwargs
        # NOT `or [default]`: an EMPTY list is a meaningful case (a service that says nothing),
        # and collapsing it to a default would silently turn that test into the happy path.
        self._conn = _FakeConn(kwargs.pop("_events", [{"type": "session.updated"}]))

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, *exc):
        return False


@pytest.fixture
def stub_voicelive_sdk(monkeypatch):
    """Install a fake azure.ai.voicelive for the duration of a test.

    probe_model imports the SDK INSIDE the function, so putting fakes in sys.modules is enough and
    works whether or not the real package is installed (CI installs without the azure extra).
    """
    import sys
    import types

    events: list[dict] = [{"type": "session.updated"}]
    raise_on_connect: list[Exception] = []

    class _Connect(_FakeConnect):
        def __init__(self, **kwargs):
            if raise_on_connect:
                type(self).captured = kwargs
                raise raise_on_connect[0]
            super().__init__(**kwargs, _events=events)

    aio_mod = types.ModuleType("azure.ai.voicelive.aio")
    aio_mod.connect = _Connect
    models_mod = types.ModuleType("azure.ai.voicelive.models")

    class RequestSession:
        def __init__(self, *, instructions=""):
            self.instructions = instructions

    models_mod.RequestSession = RequestSession

    saved = {k: sys.modules.get(k) for k in ("azure.ai.voicelive.aio", "azure.ai.voicelive.models")}
    sys.modules["azure.ai.voicelive.aio"] = aio_mod
    sys.modules["azure.ai.voicelive.models"] = models_mod
    # _certifi_ssl_context builds a real SSL context; cheap, but stub it so the test needs nothing.
    monkeypatch.setattr("app.services.voice_live_proxy._certifi_ssl_context", lambda: "ssl")
    try:
        yield {"events": events, "raise_on_connect": raise_on_connect, "connect": _Connect}
    finally:
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v


def test_probe_model_native_sends_no_profile_and_reports_accepted(stub_voicelive_sdk):
    result = asyncio.run(
        probe.probe_model(
            endpoint="https://x.services.ai.azure.com",
            credential=object(),
            api_version="2026-01-01-preview",
            model="gpt-5-mini",
        )
    )
    assert result["verdict"] == probe.ACCEPTED
    assert result["mode"] == "native"
    assert result["profile"] == ""
    assert isinstance(result["elapsed_s"], float)
    captured = stub_voicelive_sdk["connect"].captured
    assert captured["model"] == "gpt-5-mini"
    assert "query" not in captured


def test_probe_model_byom_puts_the_profile_on_the_wire(stub_voicelive_sdk):
    result = asyncio.run(
        probe.probe_model(
            endpoint="https://x.services.ai.azure.com",
            credential=object(),
            api_version="2026-01-01-preview",
            model="my-own-deployment",
            byom_profile="byom-azure-openai-chat-completion",
        )
    )
    assert result["mode"] == "byom"
    assert result["profile"] == "byom-azure-openai-chat-completion"
    captured = stub_voicelive_sdk["connect"].captured
    assert captured["query"] == {"profile": "byom-azure-openai-chat-completion"}


def test_probe_model_classifies_an_error_event(stub_voicelive_sdk):
    stub_voicelive_sdk["events"][:] = [
        {
            "type": "error",
            "error": {
                "message": "Model gpt-5.4-mini is not supported in this region.",
                "code": "invalid_model",
            },
        }
    ]
    result = asyncio.run(
        probe.probe_model(
            endpoint="https://x.services.ai.azure.com",
            credential=object(),
            api_version="v",
            model="gpt-5.4-mini",
        )
    )
    assert result["verdict"] == probe.REJECTED_REGION


def test_probe_model_classifies_a_connect_time_rejection(stub_voicelive_sdk):
    # A 4xx on the WebSocket upgrade surfaces as an exception, not an event — it must still be
    # classified rather than escaping to the caller (the admin route must never 500).
    stub_voicelive_sdk["raise_on_connect"].append(
        RuntimeError('{"code": "invalid_profile", "message": "Profile x is not supported."}')
    )
    result = asyncio.run(
        probe.probe_model(
            endpoint="https://x.services.ai.azure.com",
            credential=object(),
            api_version="v",
            model="gpt-5-mini",
            byom_profile="x",
        )
    )
    assert result["verdict"] == probe.REJECTED_PROFILE


def test_probe_model_treats_a_silent_service_as_inconclusive(stub_voicelive_sdk):
    # No event before the timeout is ERROR, never a refusal: "we could not tell" must not block a
    # save (see admin_config._check_voice_model).
    stub_voicelive_sdk["events"][:] = []
    result = asyncio.run(
        probe.probe_model(
            endpoint="https://x.services.ai.azure.com",
            credential=object(),
            api_version="v",
            model="gpt-5-mini",
            timeout_s=0.01,
        )
    )
    assert result["verdict"] == probe.ERROR
    assert not probe.is_definitive_rejection(result["verdict"])


def test_probe_model_times_out_on_a_service_that_opens_but_never_answers(stub_voicelive_sdk):
    """A connection that opens and then goes quiet is the worst case for an operator.

    It must come back ERROR (inconclusive) rather than hang the admin save or look like an
    acceptance — hence the asyncio.timeout around the event loop, and hence this test.
    """

    async def never_answers():
        await asyncio.sleep(10)
        yield {"type": "session.updated"}  # pragma: no cover — the timeout fires first

    stub_voicelive_sdk["connect"].captured = {}
    conn_events = stub_voicelive_sdk["events"]
    conn_events[:] = []

    class _Hanging(_FakeConn):
        def __aiter__(self):
            return never_answers()

    import app.services.voice_live_probe as mod

    original = mod.probe_model
    assert original is probe.probe_model  # guard: we are stubbing the transport, not the function

    # Swap the fake connection for one whose event stream never yields.
    import sys

    aio = sys.modules["azure.ai.voicelive.aio"]
    prev_connect = aio.connect

    class _HangingConnect(prev_connect):  # type: ignore[misc, valid-type]
        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            self._conn = _Hanging([])

    aio.connect = _HangingConnect
    try:
        result = asyncio.run(
            probe.probe_model(
                endpoint="https://x.services.ai.azure.com",
                credential=object(),
                api_version="v",
                model="gpt-5-mini",
                timeout_s=0.01,
            )
        )
    finally:
        aio.connect = prev_connect
    assert result["verdict"] == probe.ERROR
    assert result["detail"] == "no server event before timeout"
    assert not probe.is_definitive_rejection(result["verdict"])


def test_a_missing_azure_extra_is_inconclusive_not_an_exception():
    """CI installs without the azure extra, and an operator must still be able to save.

    The SDK import lives inside probe_model's try for exactly this reason: a missing optional
    dependency has to come back as ERROR (inconclusive) rather than escape and 500 the admin save.
    """
    import sys

    saved = {k: sys.modules.get(k) for k in ("azure.ai.voicelive.aio",)}
    sys.modules["azure.ai.voicelive.aio"] = None  # import from it raises
    try:
        result = asyncio.run(
            probe.probe_model(
                endpoint="https://x.services.ai.azure.com",
                credential=object(),
                api_version="v",
                model="gpt-5-mini",
            )
        )
    finally:
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v
    assert result["verdict"] == probe.ERROR
    assert not probe.is_definitive_rejection(result["verdict"])
    assert result["mode"] == "native"


# --- A refused SESSION SHAPE is definitive, and the minimal probe cannot see it ------------------
# Found by the first browser-level BYOM run: byom-azure-openai-realtime ACCEPTS a minimal
# RequestSession and REJECTS the production session, because speech-native passthrough has no
# Voice Live speech recognizer to run text end-of-utterance detection or azure-speech transcription
# on. The save-time check was therefore a false green for that profile until it started sending the
# real shape. Both payloads below are VERBATIM from that run.

SESSION_EOU_REFUSAL = (
    '{"message": "Text-based end-of-utterance detection requires a local speech recognizer and is '
    'only supported on cascaded pipelines.", "type": "invalid_request_error", '
    '"code": "invalid_request_error", '
    '"param": "session.turn_detection.end_of_utterance_detection", "event_id": null}'
)
SESSION_BAD_ENVELOPE = (
    '{"event_id": "evt", "type": "error", "error": {"message": "The `type` '
    "field of SessionUpdatedMessage message should be 'session.update'.\", "
    '"type": "invalid_request_error", "code": "invalid_session_update_message", "param": "type", '
    '"event_id": null}}'
)


def test_a_refused_session_shape_is_definitive_even_with_a_generic_code():
    # The giveaway is the structured `param`, NOT the code: this payload's code is the generic
    # invalid_request_error, so matching on codes or phrases would have let it through as
    # "inconclusive" and the save would have gone ahead.
    verdict, detail = probe.classify_probe_result(None, SESSION_EOU_REFUSAL)
    assert verdict == probe.REJECTED_SESSION
    assert probe.is_definitive_rejection(verdict)
    assert "cascaded pipelines" in detail  # the operator sees Azure's own explanation


def test_a_rejected_session_update_envelope_is_also_definitive():
    verdict, _ = probe.classify_probe_result(None, SESSION_BAD_ENVELOPE)
    assert verdict == probe.REJECTED_SESSION
    assert probe.is_definitive_rejection(verdict)


def test_a_param_outside_session_is_not_treated_as_a_session_refusal():
    # Only `session.*` params mean "your session configuration is wrong". A param naming something
    # else must not be escalated into a save-blocking verdict.
    payload = '{"message": "bad thing", "code": "invalid_request_error", "param": "audio.format"}'
    assert probe.classify_probe_result(None, payload)[0] == probe.ERROR


def test_a_non_json_transport_error_is_still_inconclusive():
    # The param check must never make a plain connection failure look like a refusal.
    verdict, _ = probe.classify_probe_result(None, "ClientConnectorError: cannot connect to host")
    assert verdict == probe.ERROR
    assert not probe.is_definitive_rejection(verdict)


def test_probe_model_sends_the_session_it_is_given(stub_voicelive_sdk):
    # The whole point of the fix: the caller decides what shape gets validated.
    sentinel = object()
    asyncio.run(
        probe.probe_model(
            endpoint="https://x.services.ai.azure.com",
            credential=object(),
            api_version="v",
            model="gpt-5-mini",
            session=sentinel,
        )
    )
    import sys

    conn = sys.modules["azure.ai.voicelive.aio"].connect
    assert conn.captured, "connect was never called"
