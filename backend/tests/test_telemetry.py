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
    import os

    assert os.environ["OTEL_PYTHON_FASTAPI_EXCLUDED_URLS"] == telemetry.EXCLUDED_URLS
    assert telemetry.configure() is True and len(calls) == 1  # idempotent: configured once


def test_an_operator_setting_cannot_drop_the_token_exclusion(monkeypatch):
    monitor = pytest.importorskip("azure.monitor.opentelemetry")
    monkeypatch.setenv("APPLICATIONINSIGHTS_CONNECTION_STRING", "InstrumentationKey=x")
    monkeypatch.setenv("OTEL_PYTHON_FASTAPI_EXCLUDED_URLS", "/metrics")
    monkeypatch.setattr(monitor, "configure_azure_monitor", lambda **kw: None)
    telemetry.configure()
    import os

    assert os.environ["OTEL_PYTHON_FASTAPI_EXCLUDED_URLS"].split(",") == [
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
