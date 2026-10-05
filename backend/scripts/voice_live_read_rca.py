"""Why is a realtime session's question read sometimes SILENT? Ask Azure directly, many times.

Measured first, in the browser: with the voice model set to `gpt-5-mini` the avatar read the
question at `totalAudioEnergy` 0.27, and with `gpt-realtime-2.1` the same flow produced 0.00 three
runs in a row while video frames kept arriving. One earlier realtime run WAS audible (1135 ms to
audible) and the next was recorded as never-audible, so the fault is intermittent — which is the
shape that needs repetition rather than one careful look.

This script takes the browser out of the picture. It opens the product's real session (the same
`build_avatar_session`, so the same VAD/EoU/voice/transcription), sends the product's real read
frame (`response.create` with `pre_generated_assistant_message` — server-side TTS of exact text, no
model inference), and counts what Azure sends back: every event type, how many audio bytes arrived,
and whether the avatar was told to start speaking. Run it N times per model and the difference
between the two pipelines is either reproducible or it is not.

What the counts mean:

* ``audio_bytes > 0`` — Azure synthesised the read. If the browser is then silent, the fault is in
  the browser or the transport, not in the model choice.
* ``response.done`` with ``audio_bytes == 0`` — Azure accepted the read and produced no audio: a
  service-side answer to "can this pipeline do a pre-generated read".
* an ``error`` event — the read was refused, and the payload says why.
* ``session.avatar.switch_to_speaking`` — the avatar half was told to animate, so a silent picture
  and a silent audio track can be told apart.

Run (from backend/):

    .venv/bin/python scripts/voice_live_read_rca.py --model gpt-realtime-2.1 --reps 3
    .venv/bin/python scripts/voice_live_read_rca.py --model gpt-5-mini --reps 3 --out /tmp/chat.json

NOTE: with ``--avatar`` each rep creates an avatar connection, and that is rate-limited to roughly 3
per 60 s (measured). The default is voice-only, which is not.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

READ_TEXT = (
    "Tell me about a time you had to explain a complex requirement to a customer "
    "who disagreed with it. What did you do, and how did it end?"
)


def _bootstrap_app_path() -> None:
    backend_dir = Path(__file__).resolve().parent.parent
    if str(backend_dir) not in sys.path:
        sys.path.insert(0, str(backend_dir))


class _Persona:
    """The persona surface build_avatar_session reads; ``character`` drives the avatar block."""

    def __init__(self, *, avatar: bool, character: str = "lisa", style: str = "") -> None:
        self.id = "rca"
        self.name = "RCA"
        # The character decides which avatar KIND is declared, and that turned out to matter: a
        # photo avatar is `type=photo-avatar, model=vasa-1` with no style, a video one is a rendered
        # character. Keep it switchable so the two can be compared on the same read.
        self.character = character if avatar else ""
        self.style = style
        self.interview_brain = "bank"
        self.bank_turn_mode = "linear"
        self.agent_id = ""
        self.voice_map = "{}"
        self.greeting_map = "{}"
        self.prompt_fragment = ""
        self.external_reader_prompt = ""
        self.default_locale = "en-US"
        self.agent_version = ""
        self.model = ""
        self.eou_detection = True


def build_read_frame(text: str) -> dict[str, Any]:
    """The exact frame `useInterviewVoice.speakQuestion` sends in MOUTH mode."""
    return {
        "type": "response.create",
        "response": {
            "pre_generated_assistant_message": {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "text", "text": text}],
            }
        },
    }


async def one_read(
    *,
    endpoint: str,
    credential: Any,
    api_version: str,
    model: str,
    byom_profile: str,
    realtime_pipeline: bool,
    avatar: bool,
    character: str,
    proxy_items: bool,
    mic_wav: str,
    locale: str,
    timeout_s: float,
) -> dict[str, Any]:
    """Open a session, ask for one read, and report what came back."""
    from azure.ai.voicelive.aio import connect
    from azure.ai.voicelive.models import RequestSession

    from app.services.voice_live_proxy import (
        _certifi_ssl_context,
        build_avatar_session,
        build_language_pin_item,
        build_reader_prompt_item,
    )

    session = build_avatar_session(
        _Persona(avatar=avatar, character=character),
        locale=locale,
        playground=False,
        background=None,
        realtime_pipeline=realtime_pipeline,
    )
    kwargs: dict[str, Any] = {
        "endpoint": endpoint,
        "credential": credential,
        "api_version": api_version,
        "model": model,
        "connection_options": {"vendor_options": {"ssl": _certifi_ssl_context()}},
    }
    if byom_profile:
        kwargs["query"] = {"profile": byom_profile}

    # Streaming mic audio is the OTHER thing the browser does that this script did not. On a
    # speech-native session that audio is the model's input, so "the read came back as text because
    # audio was flowing" has to be ruled in or out separately from the avatar connection.
    mic_frames: list[bytes] = []
    if mic_wav:
        import wave

        with wave.open(mic_wav, "rb") as w:
            raw = w.readframes(w.getnframes())
        chunk = 2 * 480  # 20 ms at 24 kHz, the rate the product uplinks at
        mic_frames = [raw[i : i + chunk] for i in range(0, len(raw), chunk)]

    types: Counter[str] = Counter()
    audio_bytes = 0
    transcript = ""
    errors: list[str] = []
    read_sent = False
    feeders: list[asyncio.Task[None]] = []
    try:
        async with connect(**kwargs) as conn:
            await conn.session.update(session=RequestSession(**session))
            try:
                async with asyncio.timeout(timeout_s):
                    async for ev in conn:
                        raw = ev.as_dict() if hasattr(ev, "as_dict") else dict(ev)
                        etype = str(raw.get("type", ""))
                        types[etype] += 1
                        if etype.endswith("error"):
                            errors.append(json.dumps(raw.get("error", raw))[:300])
                        if etype.endswith("response.audio.delta"):
                            audio_bytes += len(str(raw.get("delta", "")))
                        if etype.endswith("response.audio_transcript.delta"):
                            transcript += str(raw.get("delta", ""))
                        if etype.endswith("session.updated") and not read_sent:
                            # The proxy injects two system conversation items right after
                            # session.update on a MOUTH session (language pin + reader prompt). They
                            # are the only thing the browser's session carries that this script did
                            # not, so they are switchable: "the read turned into text because of a
                            # system item" and "because of the avatar media connection" are
                            # different root causes.
                            if proxy_items:
                                await conn.send(build_language_pin_item(locale))
                                await conn.send(
                                    build_reader_prompt_item("Read the given text aloud, verbatim.")
                                )
                            if mic_frames:
                                # Push a couple of seconds of the candidate's audio BEFORE the
                                # read, then keep feeding, so the session is in the same state the
                                # browser's is when it asks for the read.
                                from app.services.voice_live_proxy import build_audio_append

                                async def feed() -> None:
                                    for frame in mic_frames:
                                        await conn.send(build_audio_append(frame))
                                        await asyncio.sleep(0.02)

                                for frame in mic_frames[:100]:
                                    await conn.send(build_audio_append(frame))
                                feeder = asyncio.create_task(feed())
                                feeders.append(feeder)
                            # Session is live: ask for the read exactly as the product does.
                            await conn.send(build_read_frame(READ_TEXT))
                            read_sent = True
                        if etype.endswith("response.done") and read_sent:
                            break
            except TimeoutError:
                pass
    except Exception as exc:  # noqa: BLE001 — a connect-time refusal belongs in the report
        errors.append(f"transport: {exc}")
    finally:
        for feeder in feeders:
            feeder.cancel()

    return {
        "model": model,
        "profile": byom_profile,
        "realtime_pipeline": realtime_pipeline,
        "avatar": avatar,
        "character": character if avatar else "",
        "proxy_items": proxy_items,
        "mic": Path(mic_wav).name if mic_wav else "",
        "read_sent": read_sent,
        "audio_bytes": audio_bytes,
        "audio_deltas": types.get("response.audio.delta", 0),
        "spoke": types.get("session.avatar.switch_to_speaking", 0),
        "response_done": types.get("response.done", 0),
        "transcript_chars": len(transcript),
        "text_deltas": types.get("response.text.delta", 0),
        "errors": errors,
        "types": dict(types),
    }


async def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--model", default="gpt-realtime-2.1")
    ap.add_argument("--byom-profile", default="")
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument(
        "--avatar", action="store_true", help="attach the avatar (rate-limited: ~3/60s)"
    )
    ap.add_argument(
        "--character", default="lisa", help="avatar character: lisa (video) vs amira (photo/vasa-1)"
    )
    ap.add_argument(
        "--proxy-items",
        action="store_true",
        help="also inject the proxy's language-pin + reader-prompt system items before the read",
    )
    ap.add_argument(
        "--mic",
        default="",
        help="stream this WAV (24kHz mono 16-bit) as the candidate's microphone during the read",
    )
    ap.add_argument("--locale", default="en-US")
    ap.add_argument("--timeout", type=float, default=25.0)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    _bootstrap_app_path()
    from app.config import get_settings
    from app.db import get_session_factory
    from app.services.config_overlay import apply_master_config_to_settings
    from app.services.voice_live_probe import uses_realtime_pipeline
    from app.services.voice_live_proxy import _resolve_voice_live_credential

    factory = get_session_factory()
    try:
        async with factory() as db:
            await apply_master_config_to_settings(db)
    except Exception as exc:  # pragma: no cover - a pure-.env run is fine
        print(f"[rca] master overlay skipped ({exc!r})", file=sys.stderr)

    s = get_settings()
    endpoint = s.azure_foundry_endpoint or s.foundry_project_endpoint
    if not endpoint:
        raise SystemExit("No Voice Live endpoint configured.")
    credential, is_entra = await _resolve_voice_live_credential(
        s.azure_foundry_api_key or s.foundry_api_key
    )
    realtime = uses_realtime_pipeline(args.model, args.byom_profile)
    print(
        f"[rca] model={args.model} profile={args.byom_profile or '-'} "
        f"realtime_pipeline={realtime} avatar={args.avatar}"
        f"{'/' + args.character if args.avatar else ''} api={s.voice_live_api_version} "
        f"auth={'entra' if is_entra else 'key'}"
    )

    rows: list[dict[str, Any]] = []
    try:
        for i in range(1, args.reps + 1):
            row = await one_read(
                endpoint=endpoint,
                credential=credential,
                api_version=s.voice_live_api_version,
                model=args.model,
                byom_profile=args.byom_profile,
                realtime_pipeline=realtime,
                avatar=args.avatar,
                character=args.character,
                proxy_items=args.proxy_items,
                mic_wav=args.mic,
                locale=args.locale,
                timeout_s=args.timeout,
            )
            rows.append(row)
            print(
                f"  rep {i}: audio_deltas={row['audio_deltas']:4d} "
                f"audio_bytes={row['audio_bytes']:7d} spoke={row['spoke']} "
                f"response.done={row['response_done']} text_deltas={row['text_deltas']} "
                f"transcript_chars={row['transcript_chars']}"
                + (f"  ERR {row['errors'][0][:120]}" if row["errors"] else "")
            )
    finally:
        close = getattr(credential, "close", None)
        if close is not None:
            maybe = close()
            if asyncio.iscoroutine(maybe):
                await maybe

    silent = [r for r in rows if r["audio_bytes"] == 0]
    print(f"\n{len(rows) - len(silent)}/{len(rows)} reps produced audio; {len(silent)} silent.")
    if silent:
        print("event types of the first silent rep:")
        for t, n in sorted(silent[0]["types"].items(), key=lambda kv: -kv[1]):
            print(f"  {n:4d}  {t}")

    if args.out:
        Path(args.out).write_text(  # noqa: ASYNC240 — one-shot CLI
            json.dumps(rows, indent=2, ensure_ascii=False)
        )
        print(f"wrote {args.out}")


if __name__ == "__main__":
    asyncio.run(main())
