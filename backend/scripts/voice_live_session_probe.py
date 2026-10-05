"""Will Voice Live ACCEPT this session shape? Ask the real service, and keep its exact words.

Why this exists
---------------
The questions this answers kept being answered by inference, and inference kept being wrong:

* "realtime models cannot be used here"  -> false; only the TEXT end-of-utterance detector is
  cascaded-only, and switching to the audio-based one makes realtime work.
* "the avatar requires an Azure TTS voice" -> not confirmed; a session with the model's own
  voice is accepted and still gets ICE servers.
* "azure-speech transcription is incompatible with passthrough" -> false; that error came from a
  malformed request of mine (turn_detection removed entirely), not from azure-speech.

Each of those took one connection to settle. So: a probe that takes a session SHAPE, opens a real
session, and prints the verdict plus Azure's verbatim message. Every matrix in
``docs/voice-live-model-support.md`` §4.7 came out of this.

What it varies: the model, the BYOM profile, the EoU variant (text vs audio), whether the avatar
block is present, and whether an Azure TTS voice is set. It sends no audio — it only asks whether
the ``session.update`` is accepted, which is what decides whether a session can exist at all.

Run (from backend/):

    .venv/bin/python scripts/voice_live_session_probe.py --matrix
    .venv/bin/python scripts/voice_live_session_probe.py --model gpt-realtime-2.1 --audio-eou
    .venv/bin/python scripts/voice_live_session_probe.py --model my-deployment \
        --byom-profile byom-azure-openai-chat-completion

NOTE on --avatar: avatar creation is rate-limited to roughly 3 per 60 s (measured), so leave it off
unless the avatar is what you are asking about — and expect `rate_limit_exceeded` if you loop.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any


def _bootstrap_app_path() -> None:
    backend_dir = Path(__file__).resolve().parent.parent
    if str(backend_dir) not in sys.path:
        sys.path.insert(0, str(backend_dir))


class _Persona:
    """The persona surface build_avatar_session reads. ``character`` drives the avatar block."""

    def __init__(self, *, avatar: bool) -> None:
        self.id = "probe"
        self.name = "Probe"
        self.character = "lisa" if avatar else ""
        self.style = ""
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


async def probe_shape(
    *,
    endpoint: str,
    credential: Any,
    api_version: str,
    model: str,
    byom_profile: str,
    audio_eou: bool,
    avatar: bool,
    voice: bool,
    locale: str,
    timeout_s: float,
) -> dict[str, Any]:
    """Open one session with the given shape; return the verdict and what Azure said."""
    from azure.ai.voicelive.aio import connect
    from azure.ai.voicelive.models import RequestSession

    from app.services.voice_live_probe import classify_probe_result
    from app.services.voice_live_proxy import _certifi_ssl_context, build_avatar_session

    # audio_eou maps straight onto the product's own pipeline switch, so the probe exercises exactly
    # the shape a real session of that kind would send — no shape built by the tool itself.
    session = build_avatar_session(
        _Persona(avatar=avatar),
        locale=locale,
        playground=False,
        background=None,
        realtime_pipeline=audio_eou,
    )
    shape = dict(session)
    if not voice:
        # Dropping `voice` is how you ask "can the MODEL own the audio?" — a realtime model then
        # answers with its own voice (measured: openai/marin) while a cascaded one has Azure fill in
        # a TTS voice.
        shape.pop("voice", None)

    kwargs: dict[str, Any] = {
        "endpoint": endpoint,
        "credential": credential,
        "api_version": api_version,
        "model": model,
        "connection_options": {"vendor_options": {"ssl": _certifi_ssl_context()}},
    }
    if byom_profile:
        kwargs["query"] = {"profile": byom_profile}

    observed: dict[str, Any] = {"avatar_ice": 0, "voice_type": "", "voice_name": ""}
    try:
        async with connect(**kwargs) as conn:
            await conn.session.update(session=RequestSession(**shape))
            first: dict[str, Any] | None = None
            try:
                async with asyncio.timeout(timeout_s):
                    async for ev in conn:
                        first = ev.as_dict() if hasattr(ev, "as_dict") else dict(ev)
                        etype = str(first.get("type", ""))
                        if etype.endswith("session.updated") or etype.endswith("error"):
                            break
            except TimeoutError:
                first = None
            verdict, detail = classify_probe_result(first, None)
            if verdict == "ACCEPTED" and first:
                sess = first.get("session", {}) or {}
                av = sess.get("avatar") or {}
                vo = sess.get("voice") or {}
                observed = {
                    "avatar_ice": len(av.get("ice_servers") or []),
                    "voice_type": vo.get("type", ""),
                    "voice_name": vo.get("name", ""),
                }
    except Exception as exc:  # noqa: BLE001 — a 4xx on the WS upgrade surfaces here
        verdict, detail = classify_probe_result(None, str(exc))

    msg = detail
    try:
        if detail.strip().startswith("{"):
            payload = json.loads(detail)
            inner = payload.get("error", payload)
            msg = f"{inner.get('param') or inner.get('code') or ''}: {inner.get('message', '')}"
    except (TypeError, ValueError):
        pass
    return {
        "model": model,
        "profile": byom_profile,
        "audio_eou": audio_eou,
        "avatar": avatar,
        "voice": voice,
        "verdict": verdict,
        "detail": msg.strip(": "),
        **observed,
    }


def _print(row: dict[str, Any], label: str) -> None:
    ok = row["verdict"] == "ACCEPTED"
    extra = ""
    if ok:
        extra = (
            f"ice={row['avatar_ice']} voice={row['voice_type'] or '-'}/{row['voice_name'] or '-'}"
        )
    print(f"  {label:48s} -> {'OK ' if ok else 'ERR'}  {extra or row['detail'][:95]}")


async def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--model", default="gpt-5-mini")
    ap.add_argument("--byom-profile", default="", help="e.g. byom-azure-openai-chat-completion")
    ap.add_argument(
        "--audio-eou", action="store_true", help="audio-based EoU instead of text-based"
    )
    ap.add_argument(
        "--avatar", action="store_true", help="include the avatar block (rate-limited!)"
    )
    ap.add_argument("--no-voice", action="store_true", help="omit session.voice (model owns audio)")
    ap.add_argument("--locale", default="en-US")
    ap.add_argument("--timeout", type=float, default=18.0)
    ap.add_argument(
        "--matrix",
        action="store_true",
        help="run the combinations behind docs/voice-live-model-support.md §4.7 instead",
    )
    ap.add_argument(
        "--realtime-model", default="gpt-realtime-2.1", help="matrix: realtime deployment"
    )
    ap.add_argument("--chat-model", default="gpt-5-mini", help="matrix: chat deployment")
    ap.add_argument("--out", default=None)
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
        print(f"[probe] master overlay skipped ({exc!r}); using .env", file=sys.stderr)

    s = get_settings()
    endpoint = s.azure_foundry_endpoint or s.foundry_project_endpoint
    if not endpoint:
        raise SystemExit("No Voice Live endpoint (admin config or AZURE_FOUNDRY_ENDPOINT).")
    credential, is_entra = await _resolve_voice_live_credential(
        s.azure_foundry_api_key or s.foundry_api_key
    )
    api_version = s.voice_live_api_version
    print(f"[probe] api={api_version} auth={'entra' if is_entra else 'key'}")

    rows: list[dict[str, Any]] = []
    common = {
        "endpoint": endpoint,
        "credential": credential,
        "api_version": api_version,
        "locale": args.locale,
        "timeout_s": args.timeout,
    }
    try:
        if args.matrix:
            rt, ch = args.realtime_model, args.chat_model
            print("\n=== EoU variant x pipeline (no avatar: creation is rate-limited) ===")
            for model, prof, plabel in (
                (rt, "", "native realtime"),
                (ch, "", "native chat"),
                (rt, "byom-azure-openai-realtime", "BYOM realtime"),
                (ch, "byom-azure-openai-chat-completion", "BYOM chat"),
            ):
                for audio in (False, True):
                    row = await probe_shape(
                        **common,
                        model=model,
                        byom_profile=prof,
                        audio_eou=audio,
                        avatar=False,
                        voice=True,
                    )
                    rows.append(row)
                    _print(row, f"{plabel} / {'audio' if audio else 'text'} EoU")
            print("\n=== avatar x voice ownership (audio EoU; 3 avatar connects max per 60s) ===")
            for model, mlabel in ((rt, "realtime"), (ch, "chat")):
                for voice in (True, False):
                    row = await probe_shape(
                        **common,
                        model=model,
                        byom_profile="",
                        audio_eou=True,
                        avatar=True,
                        voice=voice,
                    )
                    rows.append(row)
                    _print(row, f"{mlabel} + avatar + {'Azure voice' if voice else 'NO voice'}")
        else:
            row = await probe_shape(
                **common,
                model=args.model,
                byom_profile=args.byom_profile,
                audio_eou=args.audio_eou,
                avatar=args.avatar,
                voice=not args.no_voice,
            )
            rows.append(row)
            _print(row, f"{args.model}{' + ' + args.byom_profile if args.byom_profile else ''}")
    finally:
        close = getattr(credential, "close", None)
        if close is not None:
            maybe = close()
            if asyncio.iscoroutine(maybe):
                await maybe

    if args.out:
        Path(args.out).write_text(  # noqa: ASYNC240 — one-shot CLI
            json.dumps(rows, indent=2, ensure_ascii=False)
        )
        print(f"\nwrote {args.out}")


if __name__ == "__main__":
    asyncio.run(main())
