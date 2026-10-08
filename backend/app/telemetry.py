"""Application Insights: OpenTelemetry traces, requests and dependencies, plus five business spans.

``configure()`` runs once, before the FastAPI app exists, and only when
``APPLICATIONINSIGHTS_CONNECTION_STRING`` is set (the deployment injects it; dev and CI have none)
and the Azure Monitor distro is installed (the ``azure`` extra; CI installs ``.[dev]`` only). It
turns on the distro's automatic instrumentation (FastAPI requests, httpx/requests calls, Azure
SDK calls, logging) and SQLAlchemy, which the distro does not cover for asyncpg.

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

# Requests that are noise as traces: the health probes (every few seconds) and the voice WebSocket
# (one "request" lasting a whole interview; its spans are the voice.session span instead).
EXCLUDED_URLS = "health,voice-live/ws"

_tracer: Any = None


def configure(engine: Any = None) -> bool:
    """Turn telemetry on if this deployment has App Insights. Returns whether it did."""
    global _tracer
    connection = os.environ.get("APPLICATIONINSIGHTS_CONNECTION_STRING", "").strip()
    if not connection:
        return False
    try:
        from azure.monitor.opentelemetry import configure_azure_monitor
        from opentelemetry import trace
    except ImportError:
        logger.warning("APPLICATIONINSIGHTS_CONNECTION_STRING is set but the SDK is not installed")
        return False
    os.environ.setdefault("OTEL_PYTHON_FASTAPI_EXCLUDED_URLS", EXCLUDED_URLS)
    os.environ.setdefault("OTEL_SERVICE_NAME", "ai-interview-backend")
    configure_azure_monitor(connection_string=connection, logger_name="app")
    if engine is not None:
        try:
            from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor

            SQLAlchemyInstrumentor().instrument(engine=getattr(engine, "sync_engine", engine))
        except ImportError:
            logger.info("SQLAlchemy instrumentation not installed; database calls are not traced")
    _tracer = trace.get_tracer("ai-interview")
    logger.info("Application Insights telemetry on")
    return True


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
    with _tracer.start_as_current_span(name) as current:
        for key, value in attributes.items():
            if value is not None:
                current.set_attribute(key, value)
        yield current


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
                    for key, attr in result(value).items():
                        if attr is not None:
                            current.set_attribute(key, attr)
                return value

        return wrapper

    return decorate
