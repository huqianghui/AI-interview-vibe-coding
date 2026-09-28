"""External-brain per-turn RTT probe (single concurrency).

Measures the HTTP round trips the voice-turn latency test (voice_turn_latency.py) deliberately
modeled as zero: interview creation (/candidate/interview/start — first question from the
external gateway) and each answer turn (/candidate/interview/{id}/answer — submit answer, get
the next question). Together with the WS-level voice metrics these complete the end-to-end
"candidate stops speaking -> avatar speaks the next question" chain.

Auth (since the candidate login gate, v0.38.0.0): ``/public/candidate/session`` requires a
candidate JWT, so the probe logs in first (``/auth/login``) with a ``user``-role account — pass
``--username/--password`` or set ``PROBE_USERNAME`` / ``PROBE_PASSWORD``. Use a DEDICATED probe
account: each run starts a FRESH interview (``/restart`` when the account already has one in
progress — ``/start`` would otherwise resume it and every "run" would continue the previous one)
and, unless ``--no-finish``, answers the remaining questions untimed so the account is not left
mid-interview for a real person to resume.

Usage:
    PROBE_USERNAME=probe PROBE_PASSWORD=... python scripts/brain_turn_rtt.py \
        --server https://<backend>.azurecontainerapps.io --runs 5 --out /tmp/brain-rtt
"""

from __future__ import annotations

import argparse
import json
import os
import ssl
import statistics
import time
from pathlib import Path
from typing import Any

import certifi
import httpx

SSL_CTX = ssl.create_default_context(cafile=certifi.where())

ANSWERS = [
    "Hello, my name is Alex. I am a software engineer with five years of experience in cloud "
    "infrastructure. I have designed and operated Kubernetes clusters on Azure and built CI/CD "
    "pipelines for a team of twenty engineers.",
    "I recently built a real time voice application using WebRTC and worked on latency "
    "optimization. We cut the avatar startup time from sixteen seconds to under ten by fixing "
    "an ICE gathering issue and prewarming the connection.",
    "My biggest strength is debugging complex distributed systems under pressure. I stay calm, "
    "form hypotheses from logs and metrics, and verify each one with targeted experiments "
    "instead of guessing.",
    "I would like to know more about the team structure and what a typical project looks like. "
    "Thank you for the conversation, I enjoyed it.",
]


def now() -> float:
    return time.monotonic()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", required=True)
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--max-turns", type=int, default=4)
    ap.add_argument("--out", default="/tmp/brain-rtt")
    ap.add_argument("--username", default=os.environ.get("PROBE_USERNAME", ""))
    ap.add_argument("--password", default=os.environ.get("PROBE_PASSWORD", ""))
    ap.add_argument(
        "--no-finish",
        action="store_true",
        help="leave the probe interview in progress after --max-turns (default: finish it untimed)",
    )
    args = ap.parse_args()
    assert args.username and args.password, (
        "--username/--password (or PROBE_USERNAME/PROBE_PASSWORD) required"
    )

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    server = args.server.rstrip("/")

    all_runs: list[dict[str, Any]] = []
    with httpx.Client(timeout=60, verify=SSL_CTX) as client:
        # One candidate login for the whole probe; the session endpoint requires the bearer.
        resp = client.post(
            f"{server}/auth/login",
            json={"username": args.username, "password": args.password},
        )
        resp.raise_for_status()
        auth = {"Authorization": f"Bearer {resp.json()['access_token']}"}
        for run_idx in range(1, args.runs + 1):
            rec: dict[str, Any] = {"run": run_idx, "turns": []}
            try:
                t0 = now()
                resp = client.post(f"{server}/public/candidate/session", headers=auth)
                resp.raise_for_status()
                token = resp.json()["token"]
                rec["session_create"] = round(now() - t0, 3)
                headers = {"X-Anon-Session": token}

                t0 = now()
                resp = client.post(f"{server}/candidate/interview/start", headers=headers)
                resp.raise_for_status()
                data = resp.json()
                rec["interview_start"] = round(now() - t0, 3)
                q = data.get("current_question") or {}
                # /start RESUMES an in-progress interview (idempotent per account). A run must
                # sample a fresh start, so an interview already past question 1 is restarted.
                if (q.get("index") or 0) > 0:
                    t0 = now()
                    resp = client.post(
                        f"{server}/candidate/interview/{data['interview_session_id']}/restart",
                        headers=headers,
                    )
                    resp.raise_for_status()
                    data = resp.json()
                    rec["interview_restart"] = round(now() - t0, 3)
                    q = data.get("current_question") or {}
                interview_id = data["interview_session_id"]
                rec["first_question"] = (q.get("prompt") or "")[:80]
                print(
                    f"[run {run_idx}] start={rec['interview_start']}s "
                    f"Q1='{rec['first_question'][:60]}'"
                )

                # Per-run: a turn that fails before setting it must not inherit the previous
                # run's value (a stale "completed" would skip the finish loop below).
                status = data.get("status", "")
                for turn in range(1, args.max_turns + 1):
                    answer = ANSWERS[(turn - 1) % len(ANSWERS)]
                    t0 = now()
                    resp = client.post(
                        f"{server}/candidate/interview/{interview_id}/answer",
                        headers=headers,
                        json={"text": answer, "source": "voice"},
                    )
                    rtt = round(now() - t0, 3)
                    if resp.status_code != 200:
                        rec["turns"].append(
                            {
                                "turn": turn,
                                "rtt": rtt,
                                "error": f"HTTP {resp.status_code}: {resp.text[:120]}",
                            }
                        )
                        print(f"[run {run_idx}] turn {turn}: HTTP {resp.status_code} after {rtt}s")
                        break
                    data = resp.json()
                    status = data.get("status", "")
                    q = data.get("current_question") or {}
                    q_text = (q.get("prompt") or "")[:80]
                    rec["turns"].append(
                        {"turn": turn, "rtt": rtt, "status": status, "next_question": q_text}
                    )
                    print(
                        f"[run {run_idx}] turn {turn}: answer→next rtt={rtt}s "
                        f"status={status} next='{q_text[:50]}'"
                    )
                    if status not in ("in_progress", "active") or not q_text:
                        break
                # Do not leave the probe account mid-interview: answer the rest untimed.
                if not args.no_finish:
                    for _ in range(40):
                        if status not in ("in_progress", "active"):
                            break
                        resp = client.post(
                            f"{server}/candidate/interview/{interview_id}/answer",
                            headers=headers,
                            json={"text": "Probe run — no further answer.", "source": "text"},
                        )
                        if resp.status_code != 200:
                            break
                        status = resp.json().get("status", "")
                    rec["finished"] = status
            except Exception as exc:  # noqa: BLE001
                rec["error"] = f"{type(exc).__name__}: {exc}"
                print(f"[run {run_idx}] ERROR: {rec['error']}")
            all_runs.append(rec)
            time.sleep(1.0)

    # summary
    starts = [r["interview_start"] for r in all_runs if "interview_start" in r]
    by_turn: dict[int, list[float]] = {}
    for r in all_runs:
        for t in r["turns"]:
            if "error" not in t:
                by_turn.setdefault(t["turn"], []).append(t["rtt"])
    summary: dict[str, Any] = {"server": server, "runs": all_runs}
    if starts:
        summary["interview_start"] = {
            "n": len(starts),
            "min": min(starts),
            "median": round(statistics.median(starts), 3),
            "max": max(starts),
        }
    summary["answer_rtt_by_turn"] = {
        str(k): {
            "n": len(v),
            "min": min(v),
            "median": round(statistics.median(v), 3),
            "max": max(v),
        }
        for k, v in sorted(by_turn.items())
    }
    all_rtts = [x for v in by_turn.values() for x in v]
    if all_rtts:
        summary["answer_rtt_all"] = {
            "n": len(all_rtts),
            "min": min(all_rtts),
            "median": round(statistics.median(all_rtts), 3),
            "max": max(all_rtts),
        }
    path = out_dir / f"summary-{time.strftime('%Y%m%d-%H%M%S')}.json"
    path.write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    print(f"\nresults -> {path}")
    if starts:
        s = summary["interview_start"]
        print(f"  interview_start   n={s['n']} min={s['min']} med={s['median']} max={s['max']}")
    for k, s in summary["answer_rtt_by_turn"].items():
        print(f"  answer turn {k}    n={s['n']} min={s['min']} med={s['median']} max={s['max']}")
    if all_rtts:
        s = summary["answer_rtt_all"]
        print(f"  answer all        n={s['n']} min={s['min']} med={s['median']} max={s['max']}")


if __name__ == "__main__":
    main()
