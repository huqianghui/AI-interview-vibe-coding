"""Probe which models Azure Voice Live actually accepts on THIS resource/region.

Thin CLI over ``app.services.voice_live_probe`` — the same code the admin dropdown
(``GET /admin/config/ai-foundry/voice-live-models``) uses, so what you measure here is what the
product will offer.

Why this exists
---------------
Voice Live attaches a "brain" in three ways that are NOT interchangeable, and confusing them is what
produces ``"Model <X> is not supported in this region"``:

  1. NATIVE  ``connect(model="gpt-realtime")`` — Azure-hosted, pre-deployed, **region-gated**. A
     deployment you created on your own resource does NOT count here; that is the error above.
  2. BYOM    ``connect(model="<your-deployment>", query={"profile": "byom-..."})`` — your own
     Foundry deployment. Needs a Microsoft Foundry resource (plain Speech resources cannot).
  3. AGENT   ``connect(agent_name=..., agent_version=..., project_name=...)`` — not probed here.

There is no API that lists "the native models live in region X", and the Learn table runs ahead of
rollout, so a real connection is the only trustworthy source (owner rule: always a real connection,
never a mock). Full analysis + measured evidence: ``docs/voice-live-model-support.md``.

Run from backend/ with the venv:

    .venv/bin/python scripts/voice_live_model_probe.py --out /tmp/voice-live-model-probe.json
    .venv/bin/python scripts/voice_live_model_probe.py --models gpt-5-mini,gpt-4o

BYOM check (the deployment name is what you named it at deploy time):

    .venv/bin/python scripts/voice_live_model_probe.py \
        --byom-profile byom-azure-openai-chat-completion --byom-model my-deployment

Note what BYOM mode can and cannot tell you (measured, see §4.4): the profile and a protocol
mismatch ARE rejected at connect, but a **nonexistent deployment name is ACCEPTED** — connect does
not validate it. Use the resource's deployment list for that, not this probe.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any


def _bootstrap_app_path() -> None:
    """Put backend/ on sys.path so ``import app`` works no matter the CWD."""
    backend_dir = Path(__file__).resolve().parent.parent
    if str(backend_dir) not in sys.path:
        sys.path.insert(0, str(backend_dir))


async def _resolve_connection() -> tuple[str, Any, str]:
    """Return (endpoint, credential, api_version) exactly as the live proxy would resolve them.

    ``apply_master_config_to_settings`` overlays the active master row (decrypted key) onto the
    settings singleton, then the proxy's own resolver picks the credential — Entra first, saved key
    as fallback. Using the proxy's resolver (not a key-first copy) is what makes a probe verdict
    representative of a real session.
    """
    from app.config import get_settings
    from app.db import get_session_factory
    from app.services.config_overlay import apply_master_config_to_settings
    from app.services.voice_live_proxy import _resolve_voice_live_credential

    factory = get_session_factory()
    applied = False
    try:
        async with factory() as db:
            applied = await apply_master_config_to_settings(db)
    except Exception as exc:  # pragma: no cover - DB optional for a pure-.env run
        print(f"[probe] master overlay skipped ({exc!r}); using .env", file=sys.stderr)

    settings = get_settings()
    endpoint = settings.azure_foundry_endpoint or settings.foundry_project_endpoint
    api_key = settings.azure_foundry_api_key or settings.foundry_api_key
    api_version = settings.voice_live_api_version
    if not endpoint:
        raise SystemExit(
            "No Voice Live endpoint. Seed the DB master row (admin config) or set "
            "AZURE_FOUNDRY_ENDPOINT in backend/.env."
        )

    credential, is_entra = await _resolve_voice_live_credential(api_key)
    print(
        f"[probe] endpoint={endpoint} api_version={api_version} "
        f"source={'DB-master' if applied else '.env'} auth={'entra' if is_entra else 'key'}",
        file=sys.stderr,
    )
    return endpoint, credential, api_version


async def main() -> None:
    from app.services import voice_live_probe as probe

    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--models",
        default=None,
        help="comma-separated models to probe in NATIVE mode (default: the docs catalogue)",
    )
    ap.add_argument(
        "--byom-profile",
        default=None,
        help=f"BYOM profile, one of: {', '.join(probe.BYOM_PROFILES)}",
    )
    ap.add_argument("--byom-model", default=None, help="your deployment name (BYOM mode)")
    ap.add_argument(
        "--timeout",
        type=float,
        default=probe.DEFAULT_TIMEOUT_SECONDS,
        help="seconds to wait for the first event",
    )
    ap.add_argument(
        "--concurrency",
        type=int,
        default=probe.DEFAULT_CONCURRENCY,
        help="parallel native probes (1 = serial)",
    )
    ap.add_argument("--out", default=None, help="write full JSON results here")
    args = ap.parse_args()

    _bootstrap_app_path()
    endpoint, credential, api_version = await _resolve_connection()

    try:
        await _run(args, endpoint, credential, api_version)
    finally:
        # The async Entra credential holds an aiohttp ClientSession; close it so a one-shot run
        # exits clean instead of printing "Unclosed client session" at GC.
        close = getattr(credential, "close", None)
        if close is not None:
            maybe = close()
            if asyncio.iscoroutine(maybe):
                await maybe


async def _run(args: argparse.Namespace, endpoint: str, credential: Any, api_version: str) -> None:
    from app.services import voice_live_probe as probe

    results: list[dict[str, Any]]
    if args.byom_profile or args.byom_model:
        if not (args.byom_profile and args.byom_model):
            raise SystemExit("BYOM needs BOTH --byom-profile and --byom-model")
        print(f"[probe] BYOM {args.byom_model} via profile={args.byom_profile}", file=sys.stderr)
        results = [
            await probe.probe_model(
                endpoint=endpoint,
                credential=credential,
                api_version=api_version,
                model=args.byom_model,
                byom_profile=args.byom_profile,
                timeout_s=args.timeout,
            )
        ]
    else:
        models = (
            [m.strip() for m in args.models.split(",") if m.strip()]
            if args.models
            else list(probe.NATIVE_MODEL_CANDIDATES)
        )
        started = time.monotonic()
        results = await probe.probe_models(
            endpoint=endpoint,
            credential=credential,
            api_version=api_version,
            models=models,
            timeout_s=args.timeout,
            concurrency=args.concurrency,
        )
        marks = {
            probe.ACCEPTED: "OK ",
            probe.REJECTED_REGION: "REG",
            probe.REJECTED_NOT_FOUND: "404",
            probe.REJECTED_PROFILE: "PRF",
            probe.REJECTED_BYOM: "BYO",
        }
        for res in results:
            mark = marks.get(res["verdict"], "ERR")
            print(f"  [{mark}] {res['model']:22s} {res['verdict']:18s} ({res['elapsed_s']}s)")
        print(
            f"\n[probe] {len(models)} models at concurrency {args.concurrency} "
            f"in {round(time.monotonic() - started, 1)}s wall"
        )

    accepted = sorted(r["model"] for r in results if r["verdict"] == probe.ACCEPTED)
    rejected_region = sorted(r["model"] for r in results if r["verdict"] == probe.REJECTED_REGION)
    print("\n=== SUMMARY ===")
    print(f"endpoint     : {endpoint}")
    print(f"api_version  : {api_version}")
    print(f"ACCEPTED  ({len(accepted)}): {', '.join(accepted) or '-'}")
    print(f"REJECTED  region ({len(rejected_region)}): {', '.join(rejected_region) or '-'}")
    for r in results:
        if r["verdict"] not in (probe.ACCEPTED, probe.REJECTED_REGION):
            print(f"OTHER  {r['model']}: {r['verdict']} :: {r['detail'][:200]}")

    if args.out:
        payload = {
            "endpoint": endpoint,
            "api_version": api_version,
            "probed_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "results": results,
        }
        # One-shot CLI probe: a blocking write of a small JSON file is intentional.
        Path(args.out).write_text(json.dumps(payload, indent=2, ensure_ascii=False))  # noqa: ASYNC240
        print(f"\nwrote {args.out}")


if __name__ == "__main__":
    asyncio.run(main())
