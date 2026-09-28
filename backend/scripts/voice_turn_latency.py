"""Voice Live conversation-turn latency probe (WS protocol level, single concurrency).

Measures the per-turn latency metrics that the avatar-entrance test (docs series 03 / 5.5)
did NOT cover: audio send -> VAD stop -> user transcript -> response created -> first
response text delta -> first response audio delta -> response done. Also supports pure
TEXT turns (conversation.item.create + response.create) to isolate the LLM+TTS pipeline
from the VAD+STT front half.

Runs against the deployed backend's /voice-live/ws proxy exactly like the browser does:
candidate login → session token (``/public/candidate/session`` requires a candidate JWT since
v0.38.0.0 — pass ``--username/--password`` or ``PROBE_USERNAME``/``PROBE_PASSWORD``, use a
dedicated probe account), base64 PCM16 mono 24kHz frames as input_audio_buffer.append, real-time
paced (100ms chunks), continuous silence between/after utterances like a live mic.

MOUTH sessions (every linear/judged bank persona and every external persona — ``proxy.connected``
reports ``linear_turns: true``): the Voice Live model never generates a turn, so the probe emulates
the PAGE's real chain instead of firing a bare ``response.create``: transcript → HTTP
``/candidate/interview/{id}/answer`` (the brain hop, timed as ``brain_rtt``) → read the next
question with ``response.create`` + ``pre_generated_assistant_message`` (server-side TTS, exactly
what the page sends since v0.39.2.3). Q1 is read the same way right after connect, and the
"text turn" becomes a pure TTS read of ``--text-turn``. Agent-mode sessions (editor Playground
persona) keep the original bare ``response.create`` / user-item flow.

Usage:
    PROBE_USERNAME=probe PROBE_PASSWORD=... python scripts/voice_turn_latency.py \
        --server https://<backend>.azurecontainerapps.io \
        --audio-dir /tmp/voice-latency-audio \
        --runs 5 --out /tmp/voice-turn-latency

Outputs per-run JSONL event logs + a summary.json with per-metric percentiles.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import ssl
import statistics
import time
import wave
from pathlib import Path
from typing import Any

import certifi
import httpx
import websockets

# Dev machines behind TLS-inspecting proxies fail with the interpreter's default trust
# store; certifi's bundle works (same fix as voice_live_proxy._certifi_ssl_context).
SSL_CTX = ssl.create_default_context(cafile=certifi.where())

SAMPLE_RATE = 24000
CHUNK_MS = 100
CHUNK_SAMPLES = SAMPLE_RATE * CHUNK_MS // 1000
CHUNK_BYTES = CHUNK_SAMPLES * 2  # PCM16
SILENCE_CHUNK_B64 = base64.b64encode(b"\x00" * CHUNK_BYTES).decode()

# Event types whose payload we keep verbatim in the JSONL (all others: type+ts only).
KEEP_PAYLOAD = {
    "proxy.connected",
    "error",
    "conversation.item.input_audio_transcription.completed",
    "response.audio_transcript.done",
    "response.done",
}


def now() -> float:
    return time.monotonic()


def proxy_ws_url(server: str, token: str) -> str:
    """The backend WS proxy URL for a base URL: https → wss (deployed), http → ws (local dev)."""
    base = server.rstrip("/").replace("https://", "wss://").replace("http://", "ws://")
    return f"{base}/voice-live/ws?token={token}"


def load_pcm(path: Path) -> bytes:
    with wave.open(str(path), "rb") as w:
        assert w.getframerate() == SAMPLE_RATE, f"{path}: expected {SAMPLE_RATE}Hz"
        assert w.getnchannels() == 1, f"{path}: expected mono"
        assert w.getsampwidth() == 2, f"{path}: expected 16-bit"
        return w.readframes(w.getnframes())


class TurnRecorder:
    """Collects (ts, event) pairs for one turn and derives the metric deltas."""

    def __init__(self, kind: str, label: str) -> None:
        self.kind = kind  # "voice" | "text" | "read"
        self.label = label
        self.anchor: float | None = None  # end-of-speech (voice) or text-sent (text)
        self.t_first_chunk: float | None = None
        self.marks: dict[str, float] = {}
        self.user_transcript = ""
        self.assistant_transcript = ""
        self.audio_bytes = 0
        self.audio_delta_count = 0
        self.usage: dict[str, Any] | None = None
        # True when this turn went through the MOUTH chain (transcript → HTTP /answer → TTS read
        # of the next question) instead of a model-generated turn.
        self.mouth_chain = False

    def mark(self, name: str, ts: float) -> None:
        self.marks.setdefault(name, ts)  # first occurrence wins

    def metrics(self) -> dict[str, Any]:
        a = self.anchor

        def rel(name: str) -> float | None:
            t = self.marks.get(name)
            return round(t - a, 3) if (t is not None and a is not None) else None

        out: dict[str, Any] = {
            "kind": self.kind,
            "label": self.label,
            "mouth_chain": self.mouth_chain,
            "user_transcript": self.user_transcript,
            "assistant_transcript_head": self.assistant_transcript[:120],
            "assistant_audio_seconds": round(self.audio_bytes / (SAMPLE_RATE * 2), 2),
            "audio_delta_count": self.audio_delta_count,
            "usage": self.usage,
        }
        if self.kind == "voice":
            if self.t_first_chunk is not None and "speech_started" in self.marks:
                out["vad_start_detect"] = round(
                    self.marks["speech_started"] - self.t_first_chunk, 3
                )
            out["vad_stop_detect"] = rel("speech_stopped")
            out["stt_final"] = rel("transcription_completed")
        if "brain_answer_sent" in self.marks and "brain_answer_done" in self.marks:
            # the HTTP /answer hop (mouth sessions): candidate transcript → next question text
            out["brain_rtt"] = round(
                self.marks["brain_answer_done"] - self.marks["brain_answer_sent"], 3
            )
        out["response_created"] = rel("response_created")
        out["first_text_delta"] = rel("first_text_delta")
        out["first_audio_delta"] = rel("first_audio_delta")
        out["audio_done"] = rel("audio_done")
        out["response_done"] = rel("response_done")
        # second anchor: deltas relative to the moment response.create was sent (isolates the
        # Azure generation pipeline from the VAD/STT front half and any brain wait)
        create_ts = self.marks.get("response_create_sent") or (
            self.anchor if self.kind in ("text", "read") else None
        )
        if create_ts is not None:
            for name, key in (
                ("response_created", "gen_created"),
                ("first_text_delta", "gen_first_text"),
                ("first_audio_delta", "gen_first_audio"),
                ("response_done", "gen_done"),
            ):
                t = self.marks.get(name)
                out[key] = round(t - create_ts, 3) if t is not None else None
        return out


class Probe:
    def __init__(
        self, server: str, out_dir: Path, run_idx: int, username: str = "", password: str = ""
    ) -> None:
        self.server = server.rstrip("/")
        self.run_idx = run_idx
        self.username = username
        self.password = password
        # Candidate interview driven alongside the WS (mouth sessions): the page's brain hop.
        self.http: httpx.AsyncClient | None = None
        self.anon_headers: dict[str, str] = {}
        self.interview_id = ""
        self.current_question = ""
        self.interview_status = ""
        self.events_path = out_dir / f"run{run_idx:02d}.events.jsonl"
        self.events_file = self.events_path.open("w")
        self.queue: asyncio.Queue[tuple[float, dict[str, Any]]] = asyncio.Queue()
        self.ws: Any = None
        self.session_metrics: dict[str, Any] = {}
        self.turns: list[dict[str, Any]] = []
        self.seen_event_types: set[str] = set()

    def log_event(self, ts: float, event: dict[str, Any]) -> None:
        etype = event.get("type", "?")
        self.seen_event_types.add(etype)
        if etype in KEEP_PAYLOAD:
            rec = {"ts": ts, **event}
        else:
            rec = {"ts": ts, "type": etype}
            # keep tiny useful fields without the base64 payloads
            for k in ("response_id", "item_id", "delta"):
                if k in event and etype.endswith("transcript.delta"):
                    rec[k] = event[k]
        self.events_file.write(json.dumps(rec, ensure_ascii=False) + "\n")

    async def reader(self) -> None:
        try:
            async for raw in self.ws:
                ts = now()
                event = json.loads(raw)
                self.log_event(ts, event)
                await self.queue.put((ts, event))
        except websockets.ConnectionClosed:
            await self.queue.put((now(), {"type": "_closed"}))

    async def next_event(self, timeout_s: float = 30.0) -> tuple[float, dict[str, Any]]:
        return await asyncio.wait_for(self.queue.get(), timeout_s)

    async def connect_direct(
        self, endpoint: str, api_key: str, api_version: str, model: str, voice: str, locale: str
    ) -> None:
        """Connect straight to Azure Voice Live (no backend proxy), WITHOUT avatar modality.

        Same VAD/STT/noise/echo settings as build_avatar_session, but modalities text+audio
        only and create_response=True — so response.audio.delta streams over THIS WS and the
        voice-return TTFB becomes measurable (in avatar mode assistant audio rides the WebRTC
        track and never appears on the WS)."""
        host = endpoint.replace("https://", "").strip("/")
        ws_url = f"wss://{host}/voice-live/realtime?api-version={api_version}&model={model}"
        t0 = now()
        # Entra bearer if the key looks like a JWT/az token, else the api-key header
        if api_key.startswith("ey") or api_key.startswith("Bearer "):
            headers = {
                "Authorization": api_key if api_key.startswith("Bearer ") else f"Bearer {api_key}"
            }
        else:
            headers = {"api-key": api_key}
        self.ws = await websockets.connect(
            ws_url,
            max_size=None,
            open_timeout=30,
            ssl=SSL_CTX,
            additional_headers=headers,
        )
        t1 = now()
        self.session_metrics["ws_connect"] = round(t1 - t0, 3)
        self.session_metrics["mode"] = "direct"
        self.session_metrics["model"] = model
        self.session_metrics["avatar_enabled"] = False

        asyncio.create_task(self.reader())
        await self.send_json(
            {
                "type": "session.update",
                "session": {
                    "modalities": ["text", "audio"],
                    "voice": {"name": voice, "type": "azure-standard"},
                    "turn_detection": {
                        "type": "azure_semantic_vad",
                        "create_response": True,
                        "interrupt_response": True,
                    },
                    "input_audio_transcription": {"model": "azure-speech", "language": locale},
                    "input_audio_noise_reduction": {"type": "azure_deep_noise_suppression"},
                    "input_audio_echo_cancellation": {"type": "server_echo_cancellation"},
                    "instructions": (
                        "You are a friendly job interviewer. Reply briefly (1-2 sentences) "
                        "to whatever the candidate says, then ask one short follow-up question."
                    ),
                },
            }
        )
        while True:
            ts, ev = await self.next_event()
            if ev.get("type") == "session.updated":
                self.session_metrics["session_updated"] = round(ts - t1, 3)
                break
            if ev.get("type") == "error":
                raise RuntimeError(f"azure error during setup: {json.dumps(ev)[:300]}")

    async def connect(self) -> None:
        assert self.username and self.password, "candidate login required (--username/--password)"
        self.http = httpx.AsyncClient(timeout=60, verify=SSL_CTX)
        resp = await self.http.post(
            f"{self.server}/auth/login",
            json={"username": self.username, "password": self.password},
        )
        resp.raise_for_status()
        auth = {"Authorization": f"Bearer {resp.json()['access_token']}"}
        t0 = now()
        resp = await self.http.post(f"{self.server}/public/candidate/session", headers=auth)
        resp.raise_for_status()
        token = resp.json()["token"]
        t1 = now()
        self.session_metrics["http_session_create"] = round(t1 - t0, 3)
        self.anon_headers = {"X-Anon-Session": token}
        # The interview the page would drive next to this WS: fresh per run (restart a resumed one).
        resp = await self.http.post(
            f"{self.server}/candidate/interview/start", headers=self.anon_headers
        )
        resp.raise_for_status()
        data = resp.json()
        q = data.get("current_question") or {}
        if (q.get("index") or 0) > 0:
            resp = await self.http.post(
                f"{self.server}/candidate/interview/{data['interview_session_id']}/restart",
                headers=self.anon_headers,
            )
            resp.raise_for_status()
            data = resp.json()
            q = data.get("current_question") or {}
        self.interview_id = data["interview_session_id"]
        self.interview_status = data.get("status", "")
        self.current_question = q.get("prompt") or ""
        self.session_metrics["interview_start"] = round(now() - t1, 3)
        self.session_metrics["voice_linear_turns"] = data.get("voice_linear_turns")

        ws_url = proxy_ws_url(self.server, token)
        self.ws = await websockets.connect(
            ws_url,
            max_size=None,
            open_timeout=30,
            ssl=SSL_CTX if ws_url.startswith("wss://") else None,
        )
        t2 = now()
        self.session_metrics["ws_connect"] = round(t2 - t1, 3)

        asyncio.create_task(self.reader())

        # proxy.connected then session.updated (order per proxy implementation)
        while True:
            ts, ev = await self.next_event()
            if ev.get("type") == "proxy.connected":
                self.session_metrics["proxy_connected"] = round(ts - t2, 3)
                self.session_metrics["mode"] = ev.get("mode")
                self.session_metrics["model"] = ev.get("model")
                self.session_metrics["avatar_enabled"] = ev.get("avatar_enabled")
                # MOUTH ⟺ linear_turns (every linear/judged bank persona + every external one):
                # the model never takes a turn; the page drives the brain over HTTP and reads
                # each question as pre-generated TTS. `read_directive` is only the mouth marker.
                self.session_metrics["mouth"] = bool(ev.get("linear_turns"))
            elif ev.get("type") == "session.updated":
                self.session_metrics["session_updated"] = round(ts - t2, 3)
                break
            elif ev.get("type") == "error":
                raise RuntimeError(f"server error during setup: {ev}")

    async def send_json(self, obj: dict[str, Any]) -> None:
        await self.ws.send(json.dumps(obj))

    async def stream_pcm(self, pcm: bytes, rec: TurnRecorder, stop: asyncio.Event) -> None:
        """Real-time paced upload: utterance chunks, then continuous silence until stop."""
        start = now()
        n_chunks = (len(pcm) + CHUNK_BYTES - 1) // CHUNK_BYTES
        for i in range(n_chunks):
            chunk = pcm[i * CHUNK_BYTES : (i + 1) * CHUNK_BYTES]
            if len(chunk) < CHUNK_BYTES:
                chunk = chunk + b"\x00" * (CHUNK_BYTES - len(chunk))
            if i == 0:
                rec.t_first_chunk = now()
            await self.send_json(
                {"type": "input_audio_buffer.append", "audio": base64.b64encode(chunk).decode()}
            )
            # absolute schedule keeps pace even if a send is slow
            target = start + (i + 1) * CHUNK_MS / 1000
            delay = target - now()
            if delay > 0:
                await asyncio.sleep(delay)
        rec.anchor = now()  # end of real speech content, real-time anchored
        # keep the "mic" open: stream silence until the turn is over
        i = 0
        sil_start = now()
        while not stop.is_set():
            await self.send_json({"type": "input_audio_buffer.append", "audio": SILENCE_CHUNK_B64})
            i += 1
            target = sil_start + i * CHUNK_MS / 1000
            delay = target - now()
            if delay > 0:
                try:
                    await asyncio.wait_for(stop.wait(), timeout=delay)
                except TimeoutError:
                    pass

    async def run_turn_events(
        self, rec: TurnRecorder, stop: asyncio.Event, turn_timeout: float
    ) -> None:
        """Consume events until response.done (with external-mode response.create fallback)."""
        deadline = now() + turn_timeout
        mouth = bool(self.session_metrics.get("mouth"))
        while True:
            remaining = deadline - now()
            if remaining <= 0:
                raise TimeoutError(f"turn timeout: marks so far {sorted(rec.marks)}")
            try:
                ts, ev = await self.next_event(timeout_s=min(remaining, 2.0))
            except TimeoutError:
                continue
            etype = ev.get("type", "")
            if etype == "input_audio_buffer.speech_started":
                rec.mark("speech_started", ts)
            elif etype == "input_audio_buffer.speech_stopped":
                rec.mark("speech_stopped", ts)
            elif etype == "conversation.item.input_audio_transcription.completed":
                rec.mark("transcription_completed", ts)
                rec.user_transcript = ev.get("transcript", "")
                # MOUTH session: VAD never auto-creates a response (create_response=False). Do what
                # the page does: submit the answer over HTTP (the brain hop, timed), then read the
                # next question as pre-generated TTS. A bare response.create here would ask the
                # model to improvise a turn production never allows — not a measurement of the
                # real flow.
                # NOTE: production joins every VAD segment since the last commit; the probe submits
                # on the FIRST completed segment — probe WAVs must be single continuous utterances.
                if mouth and rec.kind == "voice" and "response_created" not in rec.marks:
                    rec.mouth_chain = True
                    if not rec.user_transcript.strip():
                        # Production refuses to submit an empty transcript (no /answer call at
                        # all) — an inaudible utterance is a failed turn, not a placeholder answer.
                        stop.set()
                        raise RuntimeError("empty transcript — production would not submit")
                    rec.mark("brain_answer_sent", now())
                    next_text = await self.submit_answer(rec.user_transcript)
                    rec.mark("brain_answer_done", now())
                    if next_text is None:
                        # The interview just completed: production reads NOTHING here (the page
                        # moves to review), so there is no TTS to time — end the turn.
                        rec.mark("interview_completed", now())
                        stop.set()
                        return
                    await self.send_read(next_text)
                    rec.mark("response_create_sent", now())
            elif etype == "response.created":
                rec.mark("response_created", ts)
            elif etype == "response.audio_transcript.delta":
                rec.mark("first_text_delta", ts)
                rec.assistant_transcript += ev.get("delta", "")
            elif etype == "response.text.delta":
                rec.mark("first_text_delta", ts)
            elif etype == "response.audio.delta":
                rec.mark("first_audio_delta", ts)
                rec.audio_delta_count += 1
                rec.audio_bytes += len(base64.b64decode(ev.get("delta", "")))
            elif etype == "response.audio.done":
                rec.mark("audio_done", ts)
            elif etype == "response.done":
                rec.mark("response_done", ts)
                resp = ev.get("response") or {}
                rec.usage = resp.get("usage")
                stop.set()
                return
            elif etype == "error":
                stop.set()
                raise RuntimeError(f"server error mid-turn: {json.dumps(ev)[:400]}")
            elif etype == "_closed":
                stop.set()
                raise RuntimeError("websocket closed mid-turn")

    async def submit_answer(self, text: str) -> str | None:
        """The page's brain hop: POST the transcript, return the next question to read — or None
        when the interview just completed (production reads nothing then)."""
        assert self.http is not None
        resp = await self.http.post(
            f"{self.server}/candidate/interview/{self.interview_id}/answer",
            headers=self.anon_headers,
            json={"text": text or "(no transcript)", "source": "voice"},
        )
        resp.raise_for_status()
        data = resp.json()
        self.interview_status = data.get("status", "")
        q = data.get("current_question") or {}
        self.current_question = q.get("prompt") or ""
        return self.current_question or None

    async def send_read(self, text: str) -> None:
        """Read `text` exactly as the page does since v0.39.2.3: server-side TTS, no model turn."""
        await self.send_json(
            {
                "type": "response.create",
                "response": {
                    "pre_generated_assistant_message": {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "text", "text": text}],
                    }
                },
            }
        )

    async def read_turn(self, text: str, label: str, turn_timeout: float = 60.0) -> dict[str, Any]:
        """A pure TTS read (mouth sessions): response.create+pre_generated → audio → done."""
        rec = TurnRecorder("read", label)
        rec.assistant_transcript = ""
        stop = asyncio.Event()
        await self.send_read(text)
        rec.anchor = now()
        rec.mark("response_create_sent", rec.anchor)
        await self.run_turn_events(rec, stop, turn_timeout)
        m = rec.metrics()
        self.turns.append(m)
        return m

    async def voice_turn(
        self, pcm: bytes, label: str, turn_timeout: float = 60.0
    ) -> dict[str, Any]:
        rec = TurnRecorder("voice", label)
        stop = asyncio.Event()
        sender = asyncio.create_task(self.stream_pcm(pcm, rec, stop))
        try:
            await self.run_turn_events(rec, stop, turn_timeout)
        finally:
            stop.set()
            await sender
        m = rec.metrics()
        self.turns.append(m)
        return m

    async def text_turn(self, text: str, label: str, turn_timeout: float = 60.0) -> dict[str, Any]:
        rec = TurnRecorder("text", label)
        stop = asyncio.Event()
        await self.send_json(
            {
                "type": "conversation.item.create",
                "item": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": text}],
                },
            }
        )
        await self.send_json({"type": "response.create"})
        rec.anchor = now()
        await self.run_turn_events(rec, stop, turn_timeout)
        m = rec.metrics()
        self.turns.append(m)
        return m

    async def finish_interview(self) -> None:
        """Do not leave the probe account mid-interview: answer the rest untimed."""
        if self.http is None or not self.interview_id:
            return
        for _ in range(40):
            if self.interview_status not in ("in_progress", "active"):
                break
            try:
                await self.submit_answer("Probe run — no further answer.")
            except Exception:  # noqa: BLE001 — best effort
                break

    async def close(self) -> None:
        try:
            await self.ws.close()
        except Exception:
            pass
        if self.http is not None:
            await self.http.aclose()
        self.events_file.close()


def summarize(all_runs: list[dict[str, Any]]) -> dict[str, Any]:
    """Percentile summary per (kind, metric) across every turn of every run."""
    buckets: dict[str, list[float]] = {}
    for run in all_runs:
        for t in run["turns"]:
            for k, v in t.items():
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    buckets.setdefault(f"{t['kind']}.{k}", []).append(float(v))
    out = {}
    for key, vals in sorted(buckets.items()):
        vals.sort()
        out[key] = {
            "n": len(vals),
            "min": round(vals[0], 3),
            "median": round(statistics.median(vals), 3),
            "max": round(vals[-1], 3),
        }
    return out


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", help="backend base URL (proxy mode)")
    ap.add_argument("--direct", action="store_true", help="connect straight to Azure Voice Live")
    ap.add_argument("--endpoint", help="Azure Foundry endpoint (direct mode)")
    ap.add_argument("--api-version", default="2026-01-01-preview")
    ap.add_argument("--model", default="gpt-4.1-mini")
    ap.add_argument("--voice", default="en-US-AvaNeural")
    ap.add_argument("--locale", default="en-US")
    ap.add_argument("--audio-dir", required=True, help="dir with u*.wav (24kHz PCM16 mono)")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--text-turn", default="Could you briefly repeat the question, please?")
    ap.add_argument("--out", default="/tmp/voice-turn-latency")
    ap.add_argument("--username", default=os.environ.get("PROBE_USERNAME", ""))
    ap.add_argument("--password", default=os.environ.get("PROBE_PASSWORD", ""))
    ap.add_argument(
        "--no-finish",
        action="store_true",
        help="leave the probe interview in progress (default: finish it untimed after the run)",
    )
    args = ap.parse_args()
    if args.direct:
        api_key = os.environ.get("AZURE_FOUNDRY_API_KEY", "")
        assert args.endpoint and api_key, "--direct needs --endpoint and AZURE_FOUNDRY_API_KEY env"
    else:
        assert args.server, "--server required unless --direct"
        assert args.username and args.password, (
            "--username/--password (or PROBE_USERNAME/PROBE_PASSWORD) required in proxy mode"
        )

    out_dir = Path(args.out) / time.strftime("%Y%m%d-%H%M%S")
    out_dir.mkdir(parents=True, exist_ok=True)
    wavs = sorted(Path(args.audio_dir).glob("u*.wav"))  # noqa: ASYNC240 — one-off at startup
    assert wavs, f"no u*.wav in {args.audio_dir}"
    pcms = [(w.stem, load_pcm(w)) for w in wavs]

    all_runs: list[dict[str, Any]] = []
    for run_idx in range(1, args.runs + 1):
        probe = Probe(args.server or args.endpoint, out_dir, run_idx, args.username, args.password)
        run_rec: dict[str, Any] = {"run": run_idx}
        try:
            if args.direct:
                await probe.connect_direct(
                    args.endpoint,
                    os.environ["AZURE_FOUNDRY_API_KEY"],
                    args.api_version,
                    args.model,
                    args.voice,
                    args.locale,
                )
            else:
                await probe.connect()
            run_rec["session"] = probe.session_metrics
            print(f"[run {run_idx}] connected: {probe.session_metrics}")
            mouth = bool(probe.session_metrics.get("mouth"))
            if mouth and probe.current_question:
                # The page reads Q1 as soon as the session is live — measure that TTS read too.
                m = await probe.read_turn(probe.current_question, "read-q1")
                print(
                    f"[run {run_idx}] read Q1: created={m.get('gen_created')} "
                    f"audio={m.get('gen_first_audio')} done={m.get('gen_done')}"
                )
            # multi-turn: all voice utterances in one session, then one text/read turn
            for turn_idx, (name, pcm) in enumerate(pcms, 1):
                m = await probe.voice_turn(pcm, f"turn{turn_idx}-{name}")
                print(
                    f"[run {run_idx}] voice {m['label']}: "
                    f"stt={m.get('stt_final')} resp={m.get('response_created')} "
                    f"text={m.get('first_text_delta')} audio={m.get('first_audio_delta')} "
                    f"done={m.get('response_done')} '{m['user_transcript'][:40]}'"
                )
                await asyncio.sleep(1.0)
            if mouth:
                m = await probe.read_turn(args.text_turn, "read-turn")
            else:
                m = await probe.text_turn(args.text_turn, "text-turn")
            print(
                f"[run {run_idx}] {m['kind']}: resp={m.get('response_created')} "
                f"text={m.get('first_text_delta')} audio={m.get('first_audio_delta')} "
                f"done={m.get('response_done')}"
            )
            run_rec["turns"] = probe.turns
            run_rec["event_types_seen"] = sorted(probe.seen_event_types)
        except Exception as exc:  # noqa: BLE001 — record and continue to next run
            run_rec["error"] = f"{type(exc).__name__}: {exc}"
            run_rec["turns"] = probe.turns
            print(f"[run {run_idx}] ERROR: {run_rec['error']}")
        finally:
            if not args.direct and not args.no_finish:
                await probe.finish_interview()
            await probe.close()
        all_runs.append(run_rec)
        await asyncio.sleep(2.0)

    summary = {
        "server": args.server or args.endpoint,
        "direct": args.direct,
        "model": args.model if args.direct else None,
        "runs": all_runs,
        "percentiles": summarize(all_runs),
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    print(f"\nresults -> {out_dir}/summary.json")
    for key, s in summary["percentiles"].items():
        print(
            f"  {key:35s} n={s['n']:2d} min={s['min']:7.3f} "
            f"med={s['median']:7.3f} max={s['max']:7.3f}"
        )


if __name__ == "__main__":
    asyncio.run(main())
