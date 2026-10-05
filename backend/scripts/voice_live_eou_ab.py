"""A/B the two Voice Live end-of-utterance detectors on the SAME real audio.

Why this exists
---------------
Voice Live offers two end-of-utterance (EoU) detectors and they are NOT interchangeable at the
protocol level:

* ``AzureSemanticDetection{,En,Multilingual}`` -> ``semantic_detection_v1*`` — **text-based**: it
  reads the recognised transcript, so it needs a Voice Live speech recognizer and is refused
  outright on a speech-to-speech (realtime) pipeline.
* ``SmartEndOfTurnDetection`` -> ``smart_end_of_turn_detection`` — **audio-based**: it works on the
  input audio stream, and is accepted on every pipeline measured (native realtime, native chat, BYOM
  realtime, BYOM chat).

That makes the audio one a strict superset for *acceptance*. Whether it behaves the same is a
different question, and the answer decides whether the product can keep ONE code path. The text
detector's thresholds were tuned for the transcript buffer and the judge's silence trigger, so the
comparison has to be on real audio rather than on reasoning. Hence this script.

What it measures, per variant: when ``speech_started`` / ``speech_stopped`` fire, how many
``input_audio_transcription.completed`` segments come back, and the transcript text.

Making a test WAV (macOS, no cloud dependency; 24 kHz mono 16-bit is what the session declares):

    say -o /tmp/a.aiff "I always double check the runbook"
    say -o /tmp/b.aiff "and then I verify the rollback plan with my teammate"
    afconvert -f WAVE -d LEI16@24000 -c 1 /tmp/a.aiff /tmp/a.wav     # repeat for b
    # then concatenate with a silence gap to exercise a mid-sentence pause (--make-pause below)

A gotcha that cost a run: the detector decides "they stopped" from **silence frames**, not from the
absence of frames. Streaming the speech and then simply waiting produces NO ``speech_stopped`` at
all. This script always streams trailing silence (``--trailing-silence``).

Run (from backend/):

    .venv/bin/python scripts/voice_live_eou_ab.py --wav /tmp/eou_pause.wav --reps 2
    .venv/bin/python scripts/voice_live_eou_ab.py --wav /tmp/x.wav \
        --variants text:1500,audio:1000,audio:1500 --locale zh-CN
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
import wave
from pathlib import Path
from typing import Any

FRAME_MS = 20


def _bootstrap_app_path() -> None:
    backend_dir = Path(__file__).resolve().parent.parent
    if str(backend_dir) not in sys.path:
        sys.path.insert(0, str(backend_dir))


class _Persona:
    """The minimal persona surface build_avatar_session reads (a real row is not needed)."""

    id = "probe"
    name = "Probe"
    character = (
        ""  # no avatar: avatar creation is rate-limited (~3/60s measured) and irrelevant here
    )
    style = ""
    interview_brain = "bank"
    bank_turn_mode = "linear"
    agent_id = ""
    voice_map = "{}"
    greeting_map = "{}"
    prompt_fragment = ""
    external_reader_prompt = ""
    default_locale = "en-US"
    agent_version = ""
    model = ""
    eou_detection = True


def _frames(wav_path: str, trailing_silence_s: float):
    w = wave.open(wav_path)
    if w.getframerate() != 24000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
        print(
            f"[warn] {wav_path} is {w.getframerate()}Hz/{w.getnchannels()}ch/"
            f"{w.getsampwidth() * 8}bit; the session declares 24kHz mono 16-bit",
            file=sys.stderr,
        )
    n = int(w.getframerate() * FRAME_MS / 1000)
    while True:
        b = w.readframes(n)
        if not b:
            break
        yield b
    w.close()
    silence = b"\x00\x00" * n
    for _ in range(int(trailing_silence_s * 1000 / FRAME_MS)):
        yield silence


async def _one_run(
    *,
    endpoint: str,
    credential: Any,
    api_version: str,
    model: str,
    locale: str,
    audio_eou: bool,
    timeout_ms: int,
    wav: str,
    trailing_silence_s: float,
) -> dict[str, Any]:
    from azure.ai.voicelive.aio import connect
    from azure.ai.voicelive.models import (
        AzureSemanticDetectionMultilingual,
        RequestSession,
        SmartEndOfTurnDetection,
    )

    from app.services.voice_live_proxy import (
        MOUTH_EOU_AUDIO_TIMEOUT_MS,
        MOUTH_EOU_THRESHOLD_LEVEL,
        MOUTH_EOU_TIMEOUT_MS,
        _certifi_ssl_context,
        build_audio_append,
        build_avatar_session,
    )

    # The product picks the detector by PIPELINE (cascaded -> text, realtime -> audio). This script
    # compares the two detectors on ONE pipeline, so it overrides that choice directly — the only
    # way the comparison is apples-to-apples.
    session = build_avatar_session(_Persona(), locale=locale, playground=False, background=None)
    shape = dict(session)
    shape.pop("avatar", None)
    detector = (
        SmartEndOfTurnDetection(
            threshold_level=MOUTH_EOU_THRESHOLD_LEVEL,
            timeout_ms=timeout_ms or MOUTH_EOU_AUDIO_TIMEOUT_MS,
        )
        if audio_eou
        else AzureSemanticDetectionMultilingual(
            threshold_level=MOUTH_EOU_THRESHOLD_LEVEL,
            timeout_ms=timeout_ms
            or MOUTH_EOU_TIMEOUT_MS,  # the cascaded default, for a fair baseline
        )
    )
    td = dict(shape["turn_detection"])
    td["end_of_utterance_detection"] = detector
    shape["turn_detection"] = td

    events: list[tuple[float, str, str]] = []
    kwargs = {
        "endpoint": endpoint,
        "credential": credential,
        "api_version": api_version,
        "model": model,
        "connection_options": {"vendor_options": {"ssl": _certifi_ssl_context()}},
    }
    async with connect(**kwargs) as conn:
        await conn.session.update(session=RequestSession(**shape))
        t0 = time.monotonic()

        async def reader() -> None:
            try:
                async with asyncio.timeout(60):
                    async for ev in conn:
                        e = ev.as_dict() if hasattr(ev, "as_dict") else dict(ev)
                        etype = str(e.get("type", ""))
                        detail = ""
                        if "transcription.completed" in etype:
                            detail = str(e.get("transcript", ""))
                        elif etype.endswith("error"):
                            detail = json.dumps(e.get("error", e))[:160]
                        events.append((round(time.monotonic() - t0, 2), etype, detail))
            except (TimeoutError, asyncio.CancelledError):
                pass

        task = asyncio.create_task(reader())
        for frame in _frames(wav, trailing_silence_s):
            await conn.send(build_audio_append(frame))
            await asyncio.sleep(FRAME_MS / 1000)
        await asyncio.sleep(4)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    segments = [d for _, t, d in events if "transcription.completed" in t]
    return {
        "starts": [off for off, t, _ in events if "speech_started" in t],
        "stops": [off for off, t, _ in events if "speech_stopped" in t],
        "segments": segments,
        "errors": [d for _, t, d in events if t.endswith("error")],
    }


def _parse_variants(spec: str) -> list[tuple[bool, int]]:
    out = []
    for part in spec.split(","):
        kind, _, tmo = part.strip().partition(":")
        kind = kind.strip().lower()
        if kind not in ("text", "audio"):
            raise SystemExit(f"variant must be text:<ms> or audio:<ms>, got {part!r}")
        out.append((kind == "audio", int(tmo) if tmo else 0))
    return out


async def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--wav", required=True, help="24kHz mono 16-bit WAV to stream")
    ap.add_argument(
        "--variants",
        default="text:1500,audio:1000",
        help="comma list of <text|audio>:<eou timeout ms>; 0 keeps the code default",
    )
    ap.add_argument("--reps", type=int, default=1, help="repeats per variant (timing is noisy)")
    ap.add_argument(
        "--model",
        default="gpt-5-mini",
        help="a CASCADED model: the only pipeline where "
        "BOTH detectors are legal, so the comparison is fair",
    )
    ap.add_argument("--locale", default="en-US")
    ap.add_argument("--trailing-silence", type=float, default=3.0)
    ap.add_argument("--out", default=None, help="write full JSON results here")
    args = ap.parse_args()

    _bootstrap_app_path()
    from app.config import get_settings
    from app.db import get_session_factory
    from app.services.config_overlay import apply_master_config_to_settings
    from app.services.voice_live_proxy import _resolve_voice_live_credential

    factory = get_session_factory()
    try:
        async with factory() as db:
            await apply_master_config_to_settings(db)
    except Exception as exc:  # pragma: no cover - DB optional for a pure-.env run
        print(f"[eou-ab] master overlay skipped ({exc!r}); using .env", file=sys.stderr)

    s = get_settings()
    endpoint = s.azure_foundry_endpoint or s.foundry_project_endpoint
    if not endpoint:
        raise SystemExit("No Voice Live endpoint (admin config or AZURE_FOUNDRY_ENDPOINT).")
    credential, is_entra = await _resolve_voice_live_credential(
        s.azure_foundry_api_key or s.foundry_api_key
    )
    api_version = s.voice_live_api_version
    w = wave.open(args.wav)
    dur = round(w.getnframes() / w.getframerate(), 2)
    w.close()
    print(
        f"[eou-ab] model={args.model} api={api_version} auth={'entra' if is_entra else 'key'} "
        f"wav={args.wav} ({dur}s) locale={args.locale} reps={args.reps}"
    )

    results: list[dict[str, Any]] = []
    try:
        for audio_eou, tmo in _parse_variants(args.variants):
            label = f"{'audio' if audio_eou else 'text'}@{tmo or 'default'}"
            for rep in range(1, args.reps + 1):
                r = await _one_run(
                    endpoint=endpoint,
                    credential=credential,
                    api_version=api_version,
                    model=args.model,
                    locale=args.locale,
                    audio_eou=audio_eou,
                    timeout_ms=tmo,
                    wav=args.wav,
                    trailing_silence_s=args.trailing_silence,
                )
                r.update({"variant": label, "rep": rep})
                results.append(r)
                segs = len(r["segments"])
                print(
                    f"  {label:16s} rep{rep}  segments={segs}  starts={r['starts']}  "
                    f"stops={r['stops']}" + (f"  ERR={r['errors'][0][:70]}" if r["errors"] else "")
                )
    finally:
        close = getattr(credential, "close", None)
        if close is not None:
            maybe = close()
            if asyncio.iscoroutine(maybe):
                await maybe

    print("\n=== summary (median across reps) ===")
    by = {}
    for r in results:
        by.setdefault(r["variant"], []).append(r)
    for label, rows in by.items():
        segs = [len(r["segments"]) for r in rows]
        last_stop = [r["stops"][-1] for r in rows if r["stops"]]
        print(
            f"  {label:16s} segments={segs}  last_stop_median="
            f"{round(statistics.median(last_stop), 2) if last_stop else 'n/a'}"
        )
    texts = {tuple(r["segments"]) for r in results}
    print(f"  transcript text identical across every run: {len(texts) == 1}")
    if len(texts) != 1:
        for t in texts:
            print(f"    - {list(t)}")

    if args.out:
        Path(args.out).write_text(  # noqa: ASYNC240 — one-shot CLI
            json.dumps(
                {"wav": args.wav, "model": args.model, "results": results},
                indent=2,
                ensure_ascii=False,
            )
        )
        print(f"\nwrote {args.out}")


if __name__ == "__main__":
    asyncio.run(main())
