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

Switches worth knowing (each one retired a hypothesis — docs/voice-live-model-support.md §4.12):

* ``--avatar`` / ``--character`` — attach the avatar; photo (vasa-1) vs video character
* ``--proxy-items`` — also inject the two system items the proxy injects on a mouth session
* ``--mic <wav>`` — stream candidate audio while the read happens
* ``--session-as-dict`` — hand the SDK the raw dict, the way ``run_proxy`` does
* ``--modalities audio`` — drop ``text`` from the declared modalities
* ``--no-voice`` — omit ``session.voice`` so the model owns the audio (its own voice)
* ``--read-mode model_turn`` — let the model generate a turn instead of reading given text
* ``--agent name:version`` — AGENT mode (brain path ③): no ``model=`` is sent at all

The per-rep line prints **the voice Azure says it applied** — the field that finally located the bug
this script was written for.

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
    .venv/bin/python scripts/voice_live_read_rca.py --agent my-agent:12 --no-voice
    .venv/bin/python scripts/voice_live_read_rca.py --model gpt-realtime-2.1 --read-mode model_turn

NOTE: with ``--avatar`` each rep creates an avatar connection, and that is rate-limited to roughly 3
per 60 s (measured). The default is voice-only, which is not.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
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
    project: str,
    avatar: bool,
    character: str,
    proxy_items: bool,
    mic_wav: str,
    modalities: str,
    persona: Any,
    background: str,
    session_as_dict: bool,
    read_mode: str,
    drop_voice: bool,
    agent: tuple[str, str] | None,
    voice_override: str,
    auto_response: bool,
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
        default_external_reader_prompt,
    )

    # `persona` lets the caller hand in the REAL default persona from the DB, and `background` the
    # real `avatar_bg` the browser passes. Those were the last two differences between this script
    # (which gets audio) and the browser (which gets text) once the handshake was ruled out, so they
    # have to be reachable from here or the comparison is not a comparison.
    session = build_avatar_session(
        persona if persona is not None else _Persona(avatar=avatar, character=character),
        locale=locale,
        playground=False,
        background=background or None,
        realtime_pipeline=realtime_pipeline,
    )
    if auto_response:
        # A REAL speech-in -> speech-out turn: let server VAD open the model's turn when the
        # candidate stops talking, instead of the product's linear contract (create_response=False).
        # Without this the session never answers the audio on its own and the input side cannot be
        # timed at all.
        session = dict(session)
        td = dict(session["turn_detection"])
        td["create_response"] = True
        session["turn_detection"] = td
    if voice_override:
        # Send a voice DIFFERENT from the one configured on the agent, so the echo says whose
        # setting wins in agent mode — "both were en-US-AvaNeural" cannot answer that.
        from azure.ai.voicelive.models import AzureStandardVoice

        session = dict(session)
        session["voice"] = AzureStandardVoice(name=voice_override, type="azure-standard")
    if drop_voice:
        # Ask "can the MODEL's own voice drive this session?" — with no session.voice a realtime
        # model answers in its own voice (measured: openai/marin) instead of Azure TTS. The product
        # never sends this shape; it is the shape a future speech-to-speech scenario would use.
        session = dict(session)
        session.pop("voice", None)
    if modalities:
        # Hypothesis: with `text` among the declared modalities a realtime session answers a
        # pre-generated read with `response.text.delta` instead of synthesising it. Drop `text` and
        # it has nothing to answer with but audio. Comma-separated, e.g. "audio,avatar".
        session = dict(session)
        session["modalities"] = [m.strip() for m in modalities.split(",") if m.strip()]

    if agent is not None:
        # AGENT mode (brain path ③): Voice Live gets agent_name/agent_version/project_name and NO
        # `model=`. Measured 2026-10-05: in this mode the voice is ALWAYS Azure TTS — even with no
        # `session.voice` of ours Azure applied `azure-standard/en-US-AvaNeural`, never the model's
        # own voice. So "use the realtime model's own voice" is unreachable through an agent.
        from app.services.voice_live_proxy import build_connect_kwargs

        kwargs = build_connect_kwargs(
            endpoint=endpoint,
            credential=credential,
            api_version=api_version,
            ssl_ctx=_certifi_ssl_context(),
            is_agent=True,
            agent_name=agent[0],
            agent_version=agent[1],
            project=project,
            default_model="",
        )
    else:
        kwargs = {
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

    applied_session: dict[str, Any] = {}
    applied_session: dict[str, Any] = {}
    # Time from asking for speech to the FIRST audio byte: the number that says whether routing the
    # output through Azure TTS costs anything against the model speaking in its own voice. Only
    # meaningful WITHOUT --auto-response: there the clock starts at session.updated while the mic
    # WAV may still be in its leading silence, so read `stop_to_audio_ms` instead.
    asked_at = 0.0
    first_audio_ms = -1
    # The input side: from "the candidate stopped talking" to "the interviewer is heard" — the hop a
    # speech-to-speech model is supposed to shorten, since no STT runs before the brain.
    stopped_at = 0.0
    stop_to_audio_ms = -1
    types: Counter[str] = Counter()
    audio_bytes = 0
    transcript = ""
    errors: list[str] = []
    read_sent = False
    feeders: list[asyncio.Task[None]] = []
    try:
        async with connect(**kwargs) as conn:
            # The proxy hands the SDK the raw dict; this script wrapped it in RequestSession. Those
            # are two different wire payloads if the model class normalises or defaults anything,
            # and "same session" has to mean same BYTES — so make the choice switchable.
            await conn.session.update(
                session=session if session_as_dict else RequestSession(**session)
            )
            try:
                async with asyncio.timeout(timeout_s):
                    async for ev in conn:
                        raw = ev.as_dict() if hasattr(ev, "as_dict") else dict(ev)
                        etype = str(raw.get("type", ""))
                        types[etype] += 1
                        if etype.endswith("error"):
                            errors.append(json.dumps(raw.get("error", raw))[:300])
                        if etype.endswith("input_audio_buffer.speech_stopped"):
                            stopped_at = time.monotonic()
                        if etype.endswith("response.audio.delta"):
                            if stop_to_audio_ms < 0 and stopped_at:
                                stop_to_audio_ms = int((time.monotonic() - stopped_at) * 1000)
                            if first_audio_ms < 0 and asked_at:
                                first_audio_ms = int((time.monotonic() - asked_at) * 1000)
                            audio_bytes += len(str(raw.get("delta", "")))
                        if etype.endswith("response.audio_transcript.delta"):
                            transcript += str(raw.get("delta", ""))
                        if etype.endswith("session.updated"):
                            # What Azure says it actually APPLIED. Comparing this across two code
                            # paths is the only way to check "the same session" without trusting
                            # either path's intent.
                            applied_session = raw.get("session", raw)
                        if etype.endswith("session.updated") and not read_sent:
                            # The proxy injects two system conversation items right after
                            # session.update on a MOUTH session (language pin + reader prompt). They
                            # are the only thing the browser's session carries that this script did
                            # not, so they are switchable: "the read turned into text because of a
                            # system item" and "because of the avatar media connection" are
                            # different root causes.
                            if proxy_items:
                                await conn.send(build_language_pin_item(locale))
                                # The REAL reader prompt (1375 chars), not a one-line stub — the
                                # stub produced audio, and the real one was the last thing the proxy
                                # sends that this script did not.
                                await conn.send(
                                    build_reader_prompt_item(
                                        default_external_reader_prompt("Interviewer")
                                    )
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
                            if auto_response:
                                # Nothing to send: the mic audio drives it. Just start the clock.
                                read_sent = True
                                asked_at = time.monotonic()
                            elif read_mode == "model_turn":
                                # The OTHER way to make it talk: give the model something to answer
                                # and let it generate the turn itself (no pre-generated text, so no
                                # server-side TTS shortcut). Answers "does a realtime model's OWN
                                # response drive the avatar the same way a read does?"
                                await conn.send(
                                    {
                                        "type": "conversation.item.create",
                                        "item": {
                                            "type": "message",
                                            "role": "user",
                                            "content": [
                                                {
                                                    "type": "input_text",
                                                    "text": "Please introduce yourself in one "
                                                    "short sentence.",
                                                }
                                            ],
                                        },
                                    }
                                )
                                await conn.send({"type": "response.create"})
                            else:
                                # Session is live: ask for the read exactly as the product does.
                                await conn.send(build_read_frame(READ_TEXT))
                            read_sent = True
                            asked_at = time.monotonic()
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
        "modalities": modalities or "(session default)",
        "persona": getattr(persona, "name", "(synthetic)"),
        "background": background,
        "session_as_dict": session_as_dict,
        "read_mode": read_mode,
        "drop_voice": drop_voice,
        "read_sent": read_sent,
        "audio_bytes": audio_bytes,
        "audio_deltas": types.get("response.audio.delta", 0),
        "first_audio_ms": first_audio_ms,
        "stop_to_audio_ms": stop_to_audio_ms,
        "spoke": types.get("session.avatar.switch_to_speaking", 0),
        "response_done": types.get("response.done", 0),
        "transcript_chars": len(transcript),
        "text_deltas": types.get("response.text.delta", 0),
        "errors": errors,
        "types": dict(types),
        # What Azure says it actually applied — the only way to compare "the same session" across
        # two code paths without trusting either one's intent.
        "applied_session": applied_session,
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
    ap.add_argument(
        "--modalities",
        default="",
        help='override session.modalities, e.g. "audio,avatar" to drop text',
    )
    ap.add_argument(
        "--persona-from-db",
        action="store_true",
        help="use the real DEFAULT persona instead of the synthetic one (matches the browser)",
    )
    ap.add_argument("--background", default="", help="avatar_bg the browser passes, e.g. f5f1ea")
    ap.add_argument(
        "--session-as-dict",
        action="store_true",
        help="hand the SDK the raw session dict, exactly as run_proxy does",
    )
    ap.add_argument(
        "--read-mode",
        choices=("pre_generated", "model_turn"),
        default="pre_generated",
        help="pre_generated = the product's verbatim read; model_turn = let the model answer",
    )
    ap.add_argument(
        "--no-voice",
        action="store_true",
        help="omit session.voice so the model owns the audio (its own voice)",
    )
    ap.add_argument(
        "--agent",
        default="",
        help='AGENT mode: "name:version" — drive that Foundry agent; no model= is sent',
    )
    ap.add_argument(
        "--voice",
        default="",
        help="send this Azure voice name instead of the persona's (agent-mode precedence test)",
    )
    ap.add_argument(
        "--auto-response",
        action="store_true",
        help="let server VAD open the model's turn (real speech-in -> speech-out timing)",
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
    # In AGENT mode no `model=` is sent at all, so printing the resolved voice model there would
    # suggest it is in play when it is not (measured: the agent's own model drives the brain, and
    # the voice is Azure TTS either way).
    brain = f"agent={args.agent}" if args.agent else f"model={args.model}"
    print(
        f"[rca] {brain} profile={args.byom_profile or '-'} "
        f"realtime_pipeline={'n/a (agent)' if args.agent else realtime} avatar={args.avatar}"
        f"{'/' + args.character if args.avatar else ''} api={s.voice_live_api_version} "
        f"auth={'entra' if is_entra else 'key'}"
    )

    db_persona = None
    if args.persona_from_db:
        from sqlalchemy import select

        from app.models.persona import InterviewerPersona

        async with factory() as db:
            rows_p = (await db.execute(select(InterviewerPersona))).scalars().all()
        db_persona = next((r for r in rows_p if getattr(r, "is_default", False)), None) or next(
            (r for r in rows_p if getattr(r, "enabled", False)), None
        )
        print(
            f"[rca] persona={getattr(db_persona, 'name', None)!r} "
            f"character={getattr(db_persona, 'character', None)!r} "
            f"agent={getattr(db_persona, 'agent_id', None)!r}"
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
                modalities=args.modalities,
                persona=db_persona,
                background=args.background,
                session_as_dict=args.session_as_dict,
                read_mode=args.read_mode,
                drop_voice=args.no_voice,
                agent=(
                    (args.agent.rsplit(":", 1)[0], args.agent.rsplit(":", 1)[-1])
                    if args.agent
                    else None
                ),
                voice_override=args.voice,
                auto_response=args.auto_response,
                project=s.azure_foundry_default_project or "",
                locale=args.locale,
                timeout_s=args.timeout,
            )
            rows.append(row)
            print(
                f"  rep {i}: stop→audio={row['stop_to_audio_ms']:5d}ms "
                f"first_audio={row['first_audio_ms']:5d}ms "
                f"audio_deltas={row['audio_deltas']:4d} "
                f"audio_bytes={row['audio_bytes']:7d} spoke={row['spoke']} "
                f"response.done={row['response_done']} text_deltas={row['text_deltas']} "
                f"voice={(row['applied_session'].get('voice') or {}).get('type', '?')}/"
                f"{(row['applied_session'].get('voice') or {}).get('name', '?')} "
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
