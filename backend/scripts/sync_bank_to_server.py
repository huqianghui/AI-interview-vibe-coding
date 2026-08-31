"""Push the local default question bank (bank + questions + full rubric) to a deployed server.

The deployed backend runs on **ephemeral SQLite** — every boot/redeploy reseeds it with only the
generic, rubric-less demo bank, so a fresh server scores every answer as a length stub (coverage 0,
no final result) and its questions differ from local. The private-blob seeding channel that would
fix this at boot is unavailable under the storage policy (public network access disabled). This
script closes the gap over the admin API instead, so local and server are identical:

  1. read the local DB directly and serialize the chosen bank to a portable bundle
     (:func:`app.services.bank_bundle_service.export_bank_bundle`);
  2. log in to the server as admin (``POST /auth/login``);
  3. upload each referenced SOP document to the server (``POST /admin/sop/documents``) so the
     rubric's citations resolve by name — best-effort, skipped for names already present;
  4. POST the bundle to ``/admin/question-banks/import`` (idempotent by bank name — replaces).

Run it after every deploy/restart of the server (the server's DB does not persist). It carries NO
client content: bank/question/rubric text is read from the local DB at run time, and SOP files from
the local source dir — nothing is hardcoded, so this is safe in the public repo.

Usage (from ``backend/``, venv active)::

    ADMIN_USERNAME=admin ADMIN_PASSWORD=... \\
      .venv/bin/python scripts/sync_bank_to_server.py \\
        --server https://ca-...azurecontainerapps.io \\
        [--bank-id <id>] [--sop-dir ../EU_avatar_inspector_interview/Data_Sources_AI_Inspector]

Without ``--bank-id`` the local enabled default bank is used. Credentials come from the environment
(never a flag) so they stay out of shell history and the repo.
"""

from __future__ import annotations

import argparse
import asyncio
import mimetypes
import os
import sys
from pathlib import Path

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.db import async_session_factory  # noqa: E402
from app.services import bank_bundle_service, question_service  # noqa: E402


async def _build_bundle(bank_id: str | None) -> dict:
    """Export the target bank from the local DB. Defaults to the enabled default bank."""
    async with async_session_factory() as session:
        if bank_id is None:
            bank = await question_service.get_default_bank(session)
            if bank is None:
                raise SystemExit("No enabled default bank in the local DB — pass --bank-id.")
            bank_id = bank.id
        return await bank_bundle_service.export_bank_bundle(session, bank_id)


def _referenced_sop_names(bundle: dict) -> list[str]:
    """Every distinct SOP document name a rubric item cites (needs uploading to the server)."""
    names: set[str] = set()
    for q in bundle.get("questions", []):
        for it in (q.get("checklist") or {}).get("items", []):
            n = it.get("source_document_name")
            if n:
                names.add(str(n))
    return sorted(names)


def _login(client: httpx.Client, server: str) -> str:
    username = os.environ.get("ADMIN_USERNAME", "admin")
    password = os.environ.get("ADMIN_PASSWORD")
    if not password:
        raise SystemExit("Set ADMIN_PASSWORD (and optionally ADMIN_USERNAME) in the environment.")
    resp = client.post(
        f"{server}/auth/login", json={"username": username, "password": password}, timeout=30
    )
    if resp.status_code != 200:
        raise SystemExit(f"Login failed ({resp.status_code}): {resp.text}")
    return resp.json()["access_token"]


def _upload_sops(
    client: httpx.Client, server: str, headers: dict, names: list[str], sop_dir: Path | None
) -> None:
    """Upload each referenced SOP file to the server so rubric citations resolve by name.

    Best-effort: a missing local file or a failed upload is warned about, not fatal — the rubric
    still imports, only its citation link for that document is omitted (scoring is unaffected).
    Documents already present on the server (matched by name) are skipped.
    """
    if not names:
        return
    if sop_dir is None or not sop_dir.is_dir():
        print(f"  · SOP dir not provided/found; skipping {len(names)} citation upload(s).")
        return
    existing = {
        d["name"] for d in client.get(f"{server}/admin/sop/documents", headers=headers).json()
    }
    for name in names:
        if name in existing:
            print(f"  · SOP already on server: {name}")
            continue
        path = sop_dir / name
        if not path.is_file():
            print(f"  · SOP file not found locally, skipping: {name}")
            continue
        ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
        with path.open("rb") as fh:
            resp = client.post(
                f"{server}/admin/sop/documents",
                headers=headers,
                files={"file": (name, fh, ctype)},
                timeout=120,
            )
        if resp.status_code == 201:
            print(f"  ✓ uploaded SOP: {name} ({resp.json().get('status')})")
        else:
            print(f"  · SOP upload failed ({resp.status_code}) for {name}: {resp.text[:120]}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Sync the local default bank to a deployed server."
    )
    parser.add_argument("--server", required=True, help="Server base URL (https://...).")
    parser.add_argument("--bank-id", default=None, help="Local bank id (default: enabled default).")
    parser.add_argument(
        "--sop-dir",
        default=None,
        help="Directory holding the SOP source files referenced by the rubric (for citations).",
    )
    args = parser.parse_args()
    server = args.server.rstrip("/")

    bundle = asyncio.run(_build_bundle(args.bank_id))
    n_q = len(bundle.get("questions", []))
    n_items = sum(len((q.get("checklist") or {}).get("items", [])) for q in bundle["questions"])
    sop_names = _referenced_sop_names(bundle)
    print(
        f"Exported local bank {bundle['bank']['name']!r}: {n_q} questions, {n_items} rubric items, "
        f"{len(sop_names)} SOP document(s) referenced."
    )

    with httpx.Client() as client:
        token = _login(client, server)
        headers = {"Authorization": f"Bearer {token}"}
        print("Uploading referenced SOP documents…")
        _upload_sops(
            client, server, headers, sop_names, Path(args.sop_dir) if args.sop_dir else None
        )
        print("Importing bank bundle…")
        resp = client.post(
            f"{server}/admin/question-banks/import", headers=headers, json=bundle, timeout=120
        )
    if resp.status_code != 201:
        print(f"Import failed ({resp.status_code}): {resp.text}", file=sys.stderr)
        return 1
    r = resp.json()
    print(
        f"Done. Bank {r['bank_name']!r} {'replaced' if r['replaced'] else 'created'} on server: "
        f"{r['question_count']} questions, {r['checklist_item_count']} rubric items."
    )
    if r.get("unresolved_sop_names"):
        print(
            "  Note: these SOP citations could not be resolved on the server (upload them, then "
            f"re-run): {', '.join(r['unresolved_sop_names'])}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
