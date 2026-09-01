#!/usr/bin/env bash
# Container start-up for the AI-interview backend.
#
# The app runs on EPHEMERAL SQLite: the DB file lives on the replica's own disk and is thrown away
# on every restart (no DB PaaS by design). So schema + all data must be (re)built on each boot:
#
#   1. alembic upgrade head        — create the schema on the fresh empty SQLite.
#   2. (optional) client bundle    — if CLIENT_BUNDLE_BLOB is set, fetch the gitignored client
#                                    interview material from the private blob container (managed
#                                    identity, no keys), then run the importer to seed the rf-CSM
#                                    bank + its SOP docs into the local DB and local SOP store.
#   3. exec uvicorn                — the FastAPI lifespan then idempotently seeds the generic demo
#                                    bank + admin and overlays the saved master config. It also
#                                    imports any client bank bundles the bundle carried under
#                                    ``_client_bundle/extra_banks/*.json`` (CLIENT_BANKS_DIR) — e.g.
#                                    the rf-CSM demo01 bank — alongside the rf-CSM default.
#
# Steps 1 and 3 always run. Step 2 is best-effort: a missing/failed bundle logs a warning and boot
# continues with the generic demo bank only (public-demo mode). This keeps the security model
# intact — the client importer + source docs never enter the public repo or the CI image; they are
# delivered out-of-band through the private storage channel and pulled at boot.
set -euo pipefail

echo "[entrypoint] applying database migrations (alembic upgrade head)..."
alembic upgrade head

if [[ -n "${CLIENT_BUNDLE_BLOB:-}" ]]; then
  echo "[entrypoint] CLIENT_BUNDLE_BLOB set — fetching private client interview bundle..."
  BUNDLE_DIR="/app/_client_bundle"
  : "${AZURE_STORAGE_ACCOUNT_URL:?CLIENT_BUNDLE_BLOB set but AZURE_STORAGE_ACCOUNT_URL is empty}"
  : "${CLIENT_BUNDLE_CONTAINER:=client-bundle}"

  if python scripts/fetch_client_bundle.py \
      --account-url "${AZURE_STORAGE_ACCOUNT_URL}" \
      --container "${CLIENT_BUNDLE_CONTAINER}" \
      --blob "${CLIENT_BUNDLE_BLOB}" \
      --dest "${BUNDLE_DIR}"; then
    # The importer is gitignored, so it ships inside the bundle, not the image. Copy it next to the
    # other scripts so its intra-package imports resolve, then run it with an EXPLICIT --source-dir:
    # its own default (_repo_root()/EU_avatar_inspector_interview) resolves to "/EU_..." under
    # WORKDIR /app and would not find the docs.
    if [[ -f "${BUNDLE_DIR}/import_rfcsm_bank.py" ]]; then
      cp "${BUNDLE_DIR}/import_rfcsm_bank.py" scripts/import_rfcsm_bank.py
      echo "[entrypoint] running rf-CSM bank importer..."
      if python scripts/import_rfcsm_bank.py \
          --source-dir "${BUNDLE_DIR}/EU_avatar_inspector_interview"; then
        echo "[entrypoint] client bank import complete."
      else
        echo "[entrypoint] WARNING: client bank import failed; continuing with generic demo bank." >&2
      fi
    else
      echo "[entrypoint] WARNING: bundle has no import_rfcsm_bank.py; skipping client import." >&2
    fi
  else
    echo "[entrypoint] WARNING: client bundle fetch failed; continuing with generic demo bank." >&2
  fi
else
  echo "[entrypoint] CLIENT_BUNDLE_BLOB unset — public-demo mode (generic bank only)."
fi

echo "[entrypoint] starting uvicorn..."
exec uvicorn app.main:app --host 0.0.0.0 --port 8000
