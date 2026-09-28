"""Pure helpers of the operator latency probes (backend/scripts/voice_turn_latency.py).

The probes themselves run by hand against a live backend + Azure (see backend/scripts/README.md);
their metric math, WAV validation and URL mapping are pure and are pinned here so a refactor cannot
silently skew the numbers operators read off the summary. `scripts/` is not a package, so the module
is loaded from its path.
"""

from __future__ import annotations

import importlib.util
import wave
from pathlib import Path

import pytest

pytest.importorskip("websockets")

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "voice_turn_latency.py"
_spec = importlib.util.spec_from_file_location("voice_turn_latency", _SCRIPT)
assert _spec and _spec.loader
vtl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vtl)


def test_proxy_ws_url_maps_https_to_wss_and_http_to_ws():
    assert (
        vtl.proxy_ws_url("https://app.example.azurecontainerapps.io/", "tok")
        == "wss://app.example.azurecontainerapps.io/voice-live/ws?token=tok"
    )
    assert (
        vtl.proxy_ws_url("http://127.0.0.1:8000", "t")
        == "ws://127.0.0.1:8000/voice-live/ws?token=t"
    )


def test_voice_turn_metrics_are_relative_to_end_of_speech_and_to_the_read_request():
    rec = vtl.TurnRecorder("voice", "turn1")
    rec.t_first_chunk = 100.0
    rec.anchor = 102.0  # end of real speech
    for name, ts in (
        ("speech_started", 100.6),
        ("speech_stopped", 103.0),
        ("transcription_completed", 103.65),
        ("brain_answer_sent", 103.66),
        ("brain_answer_done", 103.671),
        ("response_create_sent", 103.68),
        ("response_created", 103.94),
        ("first_text_delta", 103.95),
        ("response_done", 104.1),
    ):
        rec.mark(name, ts)
    rec.mark("response_created", 999.0)  # first occurrence wins
    m = rec.metrics()
    assert m["kind"] == "voice" and m["label"] == "turn1"
    assert m["vad_start_detect"] == 0.6
    assert m["vad_stop_detect"] == 1.0
    assert m["stt_final"] == 1.65
    assert m["brain_rtt"] == 0.011
    assert m["response_created"] == 1.94 and m["response_done"] == 2.1
    # gen_* isolate Azure's generation from the front half: relative to response.create.
    assert m["gen_created"] == 0.26 and m["gen_first_text"] == 0.27 and m["gen_done"] == 0.42
    assert m["first_audio_delta"] is None and m["gen_first_audio"] is None


def test_read_turn_metrics_anchor_on_the_read_request():
    rec = vtl.TurnRecorder("read", "read-q1")
    rec.anchor = 10.0
    rec.mark("response_create_sent", 10.0)
    rec.mark("response_created", 10.26)
    rec.mark("response_done", 10.52)
    m = rec.metrics()
    assert "vad_stop_detect" not in m and "stt_final" not in m and "brain_rtt" not in m
    assert m["response_created"] == 0.26 == m["gen_created"]
    assert m["response_done"] == 0.52 == m["gen_done"]


def test_summarize_percentiles_per_kind_and_metric_skip_non_numeric():
    runs = [
        {"turns": [{"kind": "voice", "stt_final": 1.6, "label": "a", "mouth_chain": True}]},
        {"turns": [{"kind": "voice", "stt_final": 2.0}, {"kind": "read", "gen_done": 0.5}]},
    ]
    out = vtl.summarize(runs)
    assert out["voice.stt_final"] == {"n": 2, "min": 1.6, "median": 1.8, "max": 2.0}
    assert out["read.gen_done"] == {"n": 1, "min": 0.5, "median": 0.5, "max": 0.5}
    assert not any(k.endswith("label") or k.endswith("mouth_chain") for k in out)
    assert vtl.summarize([]) == {}


def _wav(path: Path, *, rate=24000, channels=1, width=2) -> Path:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        w.writeframes(b"\x01\x02" * 240 * channels * (width // 2 or 1))
    return path


def test_load_pcm_accepts_24k_mono_16bit_and_rejects_anything_else(tmp_path):
    good = _wav(tmp_path / "u1.wav")
    assert len(vtl.load_pcm(good)) == 480
    with pytest.raises(AssertionError, match="24000Hz"):
        vtl.load_pcm(_wav(tmp_path / "rate.wav", rate=16000))
    with pytest.raises(AssertionError, match="mono"):
        vtl.load_pcm(_wav(tmp_path / "stereo.wav", channels=2))
    with pytest.raises(AssertionError, match="16-bit"):
        vtl.load_pcm(_wav(tmp_path / "w8.wav", width=1))
