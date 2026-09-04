"""Transport client for the external interview API/server (SPEC Phase 2, vendor-neutral).

The backend drives the client's interview brain turn-by-turn **as an API client** (never a
Foundry-agent tool). This module owns exactly the wire contract and nothing about interview
orchestration (that is :mod:`app.interview.external_runner`):

Request (one turn):
    POST <endpoint>
    Authorization: Bearer <api_key>
    body: {"inputs": "<hex>", "user": "<user>"}
where ``hex`` = the UTF-8 bytes of the inner JSON
``{event, conversation_id, user_input, session_state_json}`` hex-encoded. ``event`` is one of
``start | message | end``. ``session_state_json`` is the opaque blob round-tripped verbatim (empty
string on the first ``start``).

Response: **SSE stream**. Each ``data:`` frame is a JSON object with an ``event`` field; the
authoritative payload is the ``workflow_finished`` frame → ``data.outputs``, carrying
``conversation_id``, ``final_session_state_json`` (opaque — validated for presence, never parsed),
``public_response_json`` (a JSON string with the candidate-safe ``speech_text`` / ``display_text``),
and a real-boolean ``session_complete``. Every other frame (``text_chunk``, keepalives, comments,
unknown events) is tolerated and ignored. Parsing is defensive: chunk-split tolerant, content-type
checked, response size capped, and bounded by connect/read/total deadlines.

Registry + ``mock`` implementation for CI/dev, imitating :mod:`app.services.voice_providers`. The
mock runs a small deterministic interview so the whole flow is exercisable with no live gateway.

Vendor-neutral by owner directive: nothing here names a product — only "external interview server".
"""

import json
import logging
import re
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

import httpx

logger = logging.getLogger(__name__)

# Deadlines (seconds). Generous read/total default per the owner decision (tune from the first live
# run's p95 in Slice 2); a short connect timeout fails fast on an unreachable host.
CONNECT_TIMEOUT = 10.0
READ_TIMEOUT = 60.0
TOTAL_TIMEOUT = 90.0

# Hard cap on the SSE body we will buffer, so a runaway/malicious stream can't exhaust memory.
MAX_RESPONSE_BYTES = 1_048_576  # 1 MiB

# Request event verbs (the ``event`` field of the inner JSON).
EVENT_START = "start"
EVENT_MESSAGE = "message"
EVENT_END = "end"

# Leading internal-id prefix on ``display_text`` (e.g. "RFCMS-Q03 — ...", "ABC_Q7: ..."). Scrubbed
# to a neutral ordinal so no internal question-id scheme leaks to the candidate. Vendor-neutral: the
# pattern matches a generic ``<CODE>-Q<digits>`` shape, not any specific product/content name.
_ID_PREFIX_RE = re.compile(r"^\s*[A-Za-z][A-Za-z0-9]*[-_ ]?Q0*(\d+)\s*[—\-:.)]*\s*")


class ExternalInterviewError(RuntimeError):
    """Raised on any transport/protocol failure (connect error, bad status, malformed SSE, missing
    ``workflow_finished``, oversized body). The runner treats every one as retryable (bounded)."""


@dataclass(frozen=True)
class ExternalTurn:
    """One committed turn from the external brain — candidate-safe fields plus the opaque state.

    ``state_blob`` is the ``final_session_state_json`` to round-trip next turn: it is backend-only
    and MUST NEVER reach the browser or any LLM (it carries live per-question scores/rubric).
    ``speech_text`` / ``display_text`` are candidate-safe (``display_text`` already scrubbed).
    """

    conversation_id: str
    state_blob: str
    speech_text: str
    display_text: str
    session_complete: bool
    # Present only when the brain reported an in-band error payload (defensive; Slice 2 acts on it).
    error: str | None = None


def scrub_display_text(text: str) -> str:
    """Strip a leading internal question-id prefix, rewriting it to a neutral ordinal.

    "RFCMS-Q03 — Describe the CAPA process" → "Question 3: Describe the CAPA process". A string with
    no such prefix is returned unchanged. Keeps any internal id scheme out of candidate-facing text.
    """
    if not text:
        return text

    def _repl(m: re.Match) -> str:
        return f"Question {int(m.group(1))}: "

    return _ID_PREFIX_RE.sub(_repl, text, count=1)


def _hex_encode_inner(
    *, event: str, conversation_id: str, user_input: str, session_state_json: str
) -> str:
    """Build the inner JSON and hex-encode its exact UTF-8 bytes (the ``inputs`` field)."""
    inner = {
        "event": event,
        "conversation_id": conversation_id,
        "user_input": user_input,
        "session_state_json": session_state_json,
    }
    return json.dumps(inner, ensure_ascii=False).encode("utf-8").hex()


def _parse_outputs(outputs: dict) -> ExternalTurn:
    """Turn a ``workflow_finished.data.outputs`` dict into a validated :class:`ExternalTurn`.

    Raises :class:`ExternalInterviewError` if the opaque state blob is absent (we cannot advance a
    stateless interview without it). ``public_response_json`` is itself a JSON string; a parse
    failure degrades to empty candidate text rather than raising, so a usable state blob is never
    discarded over a cosmetic field.
    """
    state_blob = outputs.get("final_session_state_json")
    if not isinstance(state_blob, str) or not state_blob:
        raise ExternalInterviewError("Response missing final_session_state_json")

    conversation_id = str(outputs.get("conversation_id") or "")

    speech_text = ""
    display_text = ""
    error: str | None = None
    session_complete = bool(outputs.get("session_complete", False))

    raw_public = outputs.get("public_response_json")
    if isinstance(raw_public, str) and raw_public:
        try:
            public = json.loads(raw_public)
        except (ValueError, TypeError):
            logger.warning("external interview: public_response_json was not valid JSON")
            public = {}
        if isinstance(public, dict):
            speech_text = str(public.get("speech_text") or "")
            display_text = str(public.get("display_text") or "")
            err_val = public.get("error")
            error = str(err_val) if err_val else None
            # outputs.session_complete is authoritative; fall back to the public payload's flag.
            if "session_complete" not in outputs:
                session_complete = bool(public.get("session_complete", False))

    return ExternalTurn(
        conversation_id=conversation_id,
        state_blob=state_blob,
        speech_text=speech_text,
        display_text=scrub_display_text(display_text),
        session_complete=session_complete,
        error=error,
    )


def parse_sse_outputs(frames: list[str]) -> dict:
    """Find the ``workflow_finished`` frame among decoded SSE data payloads → its ``data.outputs``.

    ``frames`` is the list of assembled ``data:`` payload strings (one per SSE event, multiline data
    already joined). Each is parsed as JSON defensively — non-JSON frames (keepalives, stray text)
    are skipped. The LAST ``workflow_finished`` frame wins. Raises :class:`ExternalInterviewError`
    if none is present.
    """
    outputs: dict | None = None
    for payload in frames:
        payload = payload.strip()
        if not payload:
            continue
        try:
            obj = json.loads(payload)
        except (ValueError, TypeError):
            continue  # keepalive / partial / non-JSON frame — ignore
        if not isinstance(obj, dict):
            continue
        if obj.get("event") == "workflow_finished":
            data = obj.get("data")
            if isinstance(data, dict) and isinstance(data.get("outputs"), dict):
                outputs = data["outputs"]
    if outputs is None:
        raise ExternalInterviewError("SSE stream had no workflow_finished/outputs frame")
    return outputs


def _assemble_frames(lines: list[str]) -> list[str]:
    """Group raw SSE lines into per-event ``data:`` payloads.

    SSE rules honored: ``data:`` lines accumulate (multiple in one event join with ``\\n``); a
    blank line dispatches the accumulated event; ``:`` comments and other fields (``event:``,
    ``id:``) are ignored for payload assembly (the event type is read from the JSON payload
    itself). A trailing event with no final blank line is still flushed.
    """
    frames: list[str] = []
    buf: list[str] = []
    for line in lines:
        if line == "":
            if buf:
                frames.append("\n".join(buf))
                buf = []
            continue
        if line.startswith(":"):
            continue  # comment / keepalive
        if line.startswith("data:"):
            buf.append(line[len("data:") :].lstrip())
    if buf:
        frames.append("\n".join(buf))
    return frames


@runtime_checkable
class ExternalInterviewProvider(Protocol):
    """One turn of the external interview, transport-agnostic. Implementations must not raise for
    normal interview outcomes (a completed interview is a normal :class:`ExternalTurn`, not an
    error); they raise :class:`ExternalInterviewError` only for transport/protocol failures."""

    name: str

    async def run_turn(
        self,
        *,
        endpoint: str,
        api_key: str,
        user: str,
        event: str,
        conversation_id: str,
        user_input: str,
        session_state_json: str,
    ) -> ExternalTurn: ...


class HttpExternalInterviewProvider:
    """Live provider: hex-encoded POST → defensive SSE parse → :class:`ExternalTurn`."""

    name = "http"

    async def run_turn(
        self,
        *,
        endpoint: str,
        api_key: str,
        user: str,
        event: str,
        conversation_id: str,
        user_input: str,
        session_state_json: str,
    ) -> ExternalTurn:
        if not endpoint:
            raise ExternalInterviewError("No external interview endpoint configured")
        inputs_hex = _hex_encode_inner(
            event=event,
            conversation_id=conversation_id,
            user_input=user_input,
            session_state_json=session_state_json,
        )
        body = {"inputs": inputs_hex, "user": user}
        headers = {"Accept": "text/event-stream"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        timeout = httpx.Timeout(TOTAL_TIMEOUT, connect=CONNECT_TIMEOUT, read=READ_TIMEOUT)

        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream("POST", endpoint, json=body, headers=headers) as resp:
                    if resp.status_code != 200:
                        # Drain a little for the log without buffering a huge error body.
                        raise ExternalInterviewError(
                            f"External interview server returned {resp.status_code}"
                        )
                    ctype = resp.headers.get("content-type", "")
                    if "text/event-stream" not in ctype and "application/json" not in ctype:
                        raise ExternalInterviewError(f"Unexpected content-type {ctype!r}")
                    lines: list[str] = []
                    total = 0
                    async for line in resp.aiter_lines():
                        total += len(line) + 1
                        if total > MAX_RESPONSE_BYTES:
                            raise ExternalInterviewError("External interview response too large")
                        lines.append(line)
        except httpx.HTTPError as exc:
            raise ExternalInterviewError(f"External interview transport error: {exc}") from exc

        outputs = parse_sse_outputs(_assemble_frames(lines))
        return _parse_outputs(outputs)


class MockExternalInterviewProvider:
    """Deterministic in-process interview for CI/dev (no network).

    Owns its own opaque state (a small JSON ``{"index": n}``) so the runner round-trips it exactly
    like a real blob without knowing its meaning. Runs a fixed 3-question interview, then completes.
    """

    name = "mock"
    _TOTAL = 3

    async def run_turn(
        self,
        *,
        endpoint: str,
        api_key: str,
        user: str,
        event: str,
        conversation_id: str,
        user_input: str,
        session_state_json: str,
    ) -> ExternalTurn:
        if event == EVENT_START or not session_state_json:
            index = 0
        else:
            try:
                index = int(json.loads(session_state_json).get("index", 0))
            except (ValueError, TypeError, AttributeError):
                index = 0
            if event == EVENT_MESSAGE:
                index += 1

        conv = conversation_id or f"mock-{abs(hash(user)) % 100000}"
        if event == EVENT_END or index >= self._TOTAL:
            return ExternalTurn(
                conversation_id=conv,
                state_blob=json.dumps({"index": self._TOTAL, "status": "completed"}),
                speech_text="Thank you, this concludes the interview.",
                display_text="Interview complete.",
                session_complete=True,
            )
        return ExternalTurn(
            conversation_id=conv,
            state_blob=json.dumps({"index": index}),
            speech_text=f"Question {index + 1}: please describe your relevant experience.",
            display_text=f"Question {index + 1}: please describe your relevant experience.",
            session_complete=False,
        )


_PROVIDERS: dict[str, ExternalInterviewProvider] = {
    "mock": MockExternalInterviewProvider(),
    "http": HttpExternalInterviewProvider(),
}


def get_external_provider(name: str | None) -> ExternalInterviewProvider:
    """Return the named provider, falling back to the mock (CI-safe default) for unknown/empty."""
    return _PROVIDERS.get((name or "").lower(), _PROVIDERS["mock"])
