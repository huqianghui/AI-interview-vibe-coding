"""Application Insights wiring (app/telemetry.py): off without a connection string, on with one,
business spans that carry outcomes and never text."""

import pytest

from app import telemetry
from app.services import voice_live_proxy


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    monkeypatch.setattr(telemetry, "_tracer", None)
    monkeypatch.setattr(telemetry, "_configured", False)


def test_without_a_connection_string_nothing_is_configured(monkeypatch):
    monkeypatch.delenv("APPLICATIONINSIGHTS_CONNECTION_STRING", raising=False)
    assert telemetry.configure() is False
    with telemetry.span("x", a=1) as current:  # a no-op span still takes attributes
        current.set_attribute("b", 2)
    telemetry.event("y", c=3)


@pytest.mark.asyncio
async def test_traced_runs_the_function_and_returns_its_value_without_telemetry():
    @telemetry.traced("t", result=lambda r: {"n": r})
    async def f(x):
        return x + 1

    assert await f(1) == 2


def test_a_connection_string_turns_the_distro_on(monkeypatch):
    monitor = pytest.importorskip("azure.monitor.opentelemetry")
    calls: list[dict] = []
    monkeypatch.setenv("APPLICATIONINSIGHTS_CONNECTION_STRING", "InstrumentationKey=x")
    monkeypatch.delenv("OTEL_PYTHON_FASTAPI_EXCLUDED_URLS", raising=False)
    monkeypatch.setattr(monitor, "configure_azure_monitor", lambda **kw: calls.append(kw))
    assert telemetry.configure() is True
    assert calls[0]["connection_string"] == "InstrumentationKey=x"
    assert telemetry.excluded_urls() == telemetry.EXCLUDED_URLS
    assert calls[0]["instrumentation_options"] == {"fastapi": {"enabled": False}}
    assert telemetry.configure() is True and len(calls) == 1  # idempotent: configured once


def test_an_operator_setting_cannot_drop_the_token_exclusion(monkeypatch):
    monitor = pytest.importorskip("azure.monitor.opentelemetry")
    monkeypatch.setenv("APPLICATIONINSIGHTS_CONNECTION_STRING", "InstrumentationKey=x")
    monkeypatch.setenv("OTEL_PYTHON_FASTAPI_EXCLUDED_URLS", "/metrics")
    monkeypatch.setattr(monitor, "configure_azure_monitor", lambda **kw: None)
    telemetry.configure()
    assert telemetry.excluded_urls().split(",") == [
        "/metrics",
        *telemetry.EXCLUDED_URLS.split(","),
    ]


def test_the_exclusions_match_exactly_the_health_and_voice_urls():
    import re

    patterns = [re.compile(p) for p in telemetry.EXCLUDED_URLS.split(",")]

    def excluded(url):
        return any(p.search(url) for p in patterns)

    base = "https://ca-x.example.io"
    assert excluded(f"{base}/health")
    assert excluded(f"{base}/api/health/db")
    assert excluded(f"{base}/voice-live/ws?token=secret")
    assert excluded(f"{base}/api/voice-live/ws?token=secret")
    assert not excluded(f"{base}/admin/users")
    assert not excluded(f"{base}/candidate/interview/healthy-habits")
    assert not excluded("https://health-records.example.io/admin/users")


@pytest.mark.asyncio
async def test_a_business_span_records_outcomes_only(monkeypatch):
    sdk = pytest.importorskip("opentelemetry.sdk.trace")
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    exporter = InMemorySpanExporter()
    provider = sdk.TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(telemetry, "_tracer", provider.get_tracer("test"))

    @telemetry.traced("scoring.question", result=lambda r: {"scoring.items": r}, kind="t")
    async def score():
        telemetry.event("voice.azure_error", code="x", flag=True)
        return 3

    assert await score() == 3
    (span,) = exporter.get_finished_spans()
    assert span.name == "scoring.question"
    assert dict(span.attributes) == {"kind": "t", "scoring.items": 3}
    assert span.events[0].name == "voice.azure_error"

    @telemetry.traced("judge.call")
    async def fails():
        raise ValueError("the model said: the candidate's whole answer")

    with pytest.raises(ValueError):
        await fails()
    failed = exporter.get_finished_spans()[-1]
    assert failed.status.description == "ValueError"  # the type, never the message
    assert failed.attributes["error.type"] == "ValueError"
    assert not failed.events  # no recorded exception event carrying the message

    class WebSocketDisconnect(Exception):
        pass

    with pytest.raises(WebSocketDisconnect):
        with telemetry.span("voice.session"):
            raise WebSocketDisconnect()
    ended = exporter.get_finished_spans()[-1]
    assert ended.status.status_code.name == "UNSET"  # a closed tab is not a failure

    @telemetry.traced("scoring.question", result=lambda r: {"x": r.missing})
    async def bad_mapping():
        return 1

    assert await bad_mapping() == 1  # a broken attribute mapping never breaks the call


def test_an_avatar_rate_limit_error_is_flagged(monkeypatch):
    seen = []
    monkeypatch.setattr(telemetry, "event", lambda name, **a: seen.append((name, a)))
    voice_live_proxy._record_azure_error(
        {"type": "error", "error": {"code": "avatar_error", "message": "Too many avatar sessions"}}
    )
    voice_live_proxy._record_azure_error(
        {"type": "error", "error": {"code": "invalid_value", "message": "Bad voice name"}}
    )
    assert [a["avatar_rate_limited"] for _, a in seen] == [True, False]
    assert all("message" not in a for _, a in seen)  # the message text is never recorded


def test_the_app_is_traced_without_the_excluded_urls(monkeypatch):
    """The health probes and the voice WebSocket (token in its query string) make no request span;
    other requests do. Instrumented on the app itself, so import order cannot change it."""
    sdk = pytest.importorskip("opentelemetry.sdk.trace")
    pytest.importorskip("opentelemetry.instrumentation.fastapi")
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    exporter = InMemorySpanExporter()
    provider = sdk.TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(telemetry, "_tracer", provider.get_tracer("test"))
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

    app = FastAPI()

    @app.get("/health")
    def health():
        return {}

    @app.get("/admin/users")
    def users():
        return []

    real = FastAPIInstrumentor.instrument_app
    monkeypatch.setattr(
        FastAPIInstrumentor,
        "instrument_app",
        staticmethod(lambda a, **kw: real(a, tracer_provider=provider, **kw)),
    )
    telemetry.instrument_app(app)
    with TestClient(app) as client:
        client.get("/health")
        client.get("/admin/users?x=1")
    servers = [s.name for s in exporter.get_finished_spans() if s.kind.name == "SERVER"]
    assert servers == ["GET /admin/users"]


TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
PARENT_ID = "00f067aa0ba902b7"


def _recording_tracer(monkeypatch):
    sdk = pytest.importorskip("opentelemetry.sdk.trace")
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    exporter = InMemorySpanExporter()
    provider = sdk.TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(telemetry, "_tracer", provider.get_tracer("test"))
    return exporter


def test_a_voice_session_joins_the_browser_trace_it_names(monkeypatch):
    # The voice WebSocket cannot carry headers, so the page passes its traceparent in the query
    # string; the session's span must become a child of it (same trace id, the browser's span id
    # as parent), which is what joins the two in App Insights.
    exporter = _recording_tracer(monkeypatch)
    parent = telemetry.parent_context(f"00-{TRACE_ID}-{PARENT_ID}-01")
    with telemetry.span("voice.session", parent=parent, **{"voice.interview_id": "iv1"}):
        pass
    (span,) = exporter.get_finished_spans()
    assert format(span.context.trace_id, "032x") == TRACE_ID
    assert format(span.parent.span_id, "016x") == PARENT_ID
    assert span.attributes["voice.interview_id"] == "iv1"


@pytest.mark.parametrize(
    "value",
    [
        None,
        "",
        "garbage",
        f"01-{TRACE_ID}-{PARENT_ID}-01",  # unknown version
        f"00-{TRACE_ID.upper()}-{PARENT_ID}-01",  # the spec is lowercase hex
        f"00-{'0' * 32}-{PARENT_ID}-01",  # all-zero ids are invalid
        f"00-{TRACE_ID}-{'0' * 16}-01",
        f"00-{TRACE_ID}-{PARENT_ID}-01 extra",
    ],
)
def test_a_malformed_traceparent_is_ignored(monkeypatch, value):
    exporter = _recording_tracer(monkeypatch)
    assert telemetry.parent_context(value) is None
    with telemetry.span("voice.session", parent=telemetry.parent_context(value)):
        pass
    (span,) = exporter.get_finished_spans()
    assert span.parent is None  # a fresh root, not a trusted bogus parent


def test_without_telemetry_there_is_no_parent(monkeypatch):
    monkeypatch.setattr(telemetry, "_tracer", None)
    assert telemetry.parent_context(f"00-{TRACE_ID}-{PARENT_ID}-01") is None
