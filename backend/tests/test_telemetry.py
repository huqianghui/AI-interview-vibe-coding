"""Application Insights wiring (app/telemetry.py): off without a connection string, on with one,
business spans that carry outcomes and never text."""

import pytest

from app import telemetry
from app.services import voice_live_proxy


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    monkeypatch.setattr(telemetry, "_tracer", None)


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
    calls = {}
    monkeypatch.setenv("APPLICATIONINSIGHTS_CONNECTION_STRING", "InstrumentationKey=x")
    monkeypatch.delenv("OTEL_PYTHON_FASTAPI_EXCLUDED_URLS", raising=False)
    monkeypatch.setattr(monitor, "configure_azure_monitor", lambda **kw: calls.update(kw))
    assert telemetry.configure() is True
    assert calls["connection_string"] == "InstrumentationKey=x"
    import os

    assert os.environ["OTEL_PYTHON_FASTAPI_EXCLUDED_URLS"] == "health,voice-live/ws"


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
