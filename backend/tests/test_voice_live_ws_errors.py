"""The voice WS's error frame: shape and close code, with no Azure and no real socket.

A browser only learns about a rejected voice session through the close handshake and this one
typed frame, so its shape is load-bearing for the interview page (it is what turns into the visible
message instead of a silent dead connection). ``_send_error_and_close`` is pure enough to test with
a stand-in socket, and it is the only part of the WS route that can be checked without a live Azure
connection on the other end.
"""

import asyncio
import json

from app.api.voice_live_ws import _send_error_and_close


class _FakeWs:
    def __init__(self):
        self.sent: list[str] = []
        self.closed: tuple[int, str] | None = None

    async def send_text(self, text: str) -> None:
        self.sent.append(text)

    async def close(self, code: int, reason: str) -> None:
        self.closed = (code, reason)


def test_error_frame_is_typed_and_carries_the_code_and_message():
    ws = _FakeWs()
    asyncio.run(_send_error_and_close(ws, "Interviewer agent not ready", "AGENT_SYNC_REQUIRED"))
    assert len(ws.sent) == 1
    payload = json.loads(ws.sent[0])
    assert payload["type"] == "error"
    assert payload["error"]["code"] == "AGENT_SYNC_REQUIRED"
    assert payload["error"]["message"] == "Interviewer agent not ready"


def test_the_frame_is_sent_before_the_close_and_closes_with_1008():
    # Order matters: closing first would drop the frame, leaving the page with a bare disconnect.
    ws = _FakeWs()
    asyncio.run(_send_error_and_close(ws, "nope"))
    assert ws.sent, "the frame must be sent before the socket closes"
    assert ws.closed == (1008, "VOICE_LIVE_ERROR")  # policy violation = a deliberate rejection
