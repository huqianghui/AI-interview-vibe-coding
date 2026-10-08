"""Application Insights: OpenTelemetry traces, requests and dependencies, plus five business spans.

``configure()`` runs once, before the FastAPI app exists, and only when
``APPLICATIONINSIGHTS_CONNECTION_STRING`` is set (the deployment injects it; dev and CI have none)
and the Azure Monitor distro is installed (the ``azure`` extra; CI installs ``.[dev]`` only). It
turns on the distro's automatic instrumentation (FastAPI requests, Azure SDK calls, warnings and
errors from the ``app`` loggers, httpx: Azure OpenAI and the external interview brain, URL and
status only) plus SQLAlchemy, which the distro does not include (parameterised statements; bound
values are never exported). FastAPI requests are instrumented on the app (:func:`instrument_app`).

:func:`span` is the one way code opens a business span. Without the SDK it is a no-op, so call
sites never check. Business spans carry ids, counts, durations and outcomes — never a transcript,
an answer, a question or any SOP text.
"""

from __future__ import annotations

import functools
import logging
import os
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

logger = logging.getLogger(__name__)

# Requests left out of the request traces, as the FastAPI instrumentation reads them: regexes
# searched in the FULL URL. The health probes (every few seconds) are noise. The voice WebSocket is
# one "request" lasting a whole interview, and its URL carries the session token in the query
# string: this exclusion is what keeps that token out of telemetry, so it is merged into any value
# an operator sets, never replaced by it.
EXCLUDED_URLS = r"/health(/db)?(\?|$),/voice-live/ws"
# The distro's instrumentations this app has no use for.
DISABLED_INSTRUMENTATIONS = "django,flask,psycopg2"
# Exceptions that end a span normally: a candidate closing the tab, a cancelled task at shutdown.
_NOT_ERRORS = ("WebSocketDisconnect", "CancelledError")

_tracer: Any = None
_configured = False


def _merged(name: str, ours: str) -> str:
    current = [v for v in os.environ.get(name, "").split(",") if v.strip()]
    return ",".join(dict.fromkeys([*current, *ours.split(",")]))


def configure(engine: Any = None) -> bool:
    """Turn telemetry on if this deployment has App Insights. Returns whether it did. Idempotent."""
    global _tracer, _configured
    if _configured:
        return _tracer is not None
    _configured = True
    connection = os.environ.get("APPLICATIONINSIGHTS_CONNECTION_STRING", "").strip()
    if not connection:
        return False
    try:
        from azure.monitor.opentelemetry import configure_azure_monitor
        from opentelemetry import trace
    except ImportError:
        logger.warning("APPLICATIONINSIGHTS_CONNECTION_STRING is set but the SDK is not installed")
        return False
    os.environ["OTEL_PYTHON_DISABLED_INSTRUMENTATIONS"] = _merged(
        "OTEL_PYTHON_DISABLED_INSTRUMENTATIONS", DISABLED_INSTRUMENTATIONS
    )
    os.environ.setdefault("OTEL_SERVICE_NAME", "ai-interview-backend")
    # Every trace by default (a PoC's traffic is small); an operator can sample down without a
    # code change.
    ratio = float(os.environ.get("APPLICATIONINSIGHTS_SAMPLING_RATIO", "1.0"))
    # FastAPI is instrumented by :func:`instrument_app`, on the app object itself, with the URL
    # exclusions passed in: the distro's own FastAPI hook patches the FastAPI class and reads the
    # exclusions from the environment at import, so its result depended on import order (measured
    # on live: health probes were traced although the exclusion matched them).
    configure_azure_monitor(
        connection_string=connection,
        logger_name="app",
        sampling_ratio=ratio,
        instrumentation_options={"fastapi": {"enabled": False}},
    )
    if engine is not None:
        try:
            from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor

            SQLAlchemyInstrumentor().instrument(engine=getattr(engine, "sync_engine", engine))
        except ImportError:
            logger.info("SQLAlchemy instrumentation not installed; database calls are not traced")
    _tracer = trace.get_tracer("ai-interview")
    logger.info("Application Insights telemetry on")
    return True


def excluded_urls() -> str:
    """The URL exclusions in force: ours, merged into any an operator set."""
    return _merged("OTEL_PYTHON_FASTAPI_EXCLUDED_URLS", EXCLUDED_URLS)


def instrument_app(app: Any) -> None:
    """Trace the app's requests, minus :data:`EXCLUDED_URLS`. A no-op without telemetry."""
    if _tracer is None:
        return
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    except ImportError:
        logger.warning("FastAPI instrumentation not installed; requests are not traced")
        return
    FastAPIInstrumentor.instrument_app(app, excluded_urls=excluded_urls())


class _NoSpan:
    def set_attribute(self, *_a: Any) -> None:
        pass

    def add_event(self, *_a: Any, **_k: Any) -> None:
        pass


@contextmanager
def span(name: str, **attributes: Any) -> Iterator[Any]:
    """A business span (or a no-op without telemetry). Exceptions are recorded and re-raised."""
    if _tracer is None:
        yield _NoSpan()
        return
    from opentelemetry.trace import Status, StatusCode

    # Exceptions are recorded by TYPE only: an exception message can carry model output or request
    # detail, and nothing in a span may carry text.
    with _tracer.start_as_current_span(
        name, record_exception=False, set_status_on_exception=False
    ) as current:
        for key, value in attributes.items():
            if value is not None:
                current.set_attribute(key, value)
        try:
            yield current
        except BaseException as exc:
            kind = type(exc).__name__
            if kind not in _NOT_ERRORS:
                current.set_status(Status(StatusCode.ERROR, kind))
                current.set_attribute("error.type", kind)
            raise


def event(name: str, **attributes: Any) -> None:
    """An event on the current span (or nothing without telemetry)."""
    if _tracer is None:
        return
    from opentelemetry import trace

    trace.get_current_span().add_event(name, {k: v for k, v in attributes.items() if v is not None})


def traced(name: str, result: Callable[[Any], dict] | None = None, **static: Any):  # noqa: ANN201
    """Run an async function inside a business span; ``result`` maps its return value to the span
    attributes worth keeping (counts, outcomes — never text)."""

    def decorate(fn):  # noqa: ANN001, ANN202
        @functools.wraps(fn)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            with span(name, **static) as current:
                value = await fn(*args, **kwargs)
                if result is not None:
                    try:  # telemetry never breaks the call it observes
                        for key, attr in result(value).items():
                            if attr is not None:
                                current.set_attribute(key, attr)
                    except Exception:  # noqa: BLE001
                        logger.debug("Span attributes for %s failed", name, exc_info=True)
                return value

        return wrapper

    return decorate
