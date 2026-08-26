# Plan: CI/CD + Azure deployment for AI-interview (Container Apps, Sweden Central)

## Context

The app is validated locally and needs a full CI/CD pipeline that deploys to Azure, mirroring the
sibling project `AI-Coach-vibe-coding` but **simpler**. Decisions locked with the user:

1. Deploy to **Sweden Central** (co-located with the existing AI Foundry resource).
2. **Managed identity** for all cloud auth (the backend's Entra-first path already exists in
   `backend/app/services/azure_auth.py`).
3. **Keep SQLite** — no database PaaS. DB is **ephemeral + reseeded on every boot**.
4. Initial data is **seeded automatically at boot**: the generic demo bank + admin (already in
   `main.py` lifespan) **and** the client rf-CSM bank.
5. Single **public** environment.
6. **Reuse** the existing Foundry resource; Bicep does not create AI resources — a post-deploy
   RBAC grant gives the backend MI access.

### The central design tension (and its resolution)

Ephemeral SQLite lives on the **app replica's own disk**, so the reference's separate
"bootstrap Job" pattern cannot seed it (the job's disk isn't shared with the app). Therefore
**migrations + all seeding run in the app container's own boot path**. And the client bank's
importer (`backend/scripts/import_rfcsm_bank.py`) plus its 12 MB source docs
(`EU_avatar_inspector_interview/`) are **gitignored** — absent from the public repo AND the
CI-built image — so they must be delivered through a **private channel** and pulled at boot.

**Resolution:**
- A new `backend/entrypoint.sh` runs on container start:
  1. `alembic upgrade head` (creates schema on the fresh empty SQLite each boot).
  2. If a client bundle is configured, download it from a **private blob** (managed identity,
     no keys), extract, and run the importer against the local DB + local SOP store.
  3. `exec uvicorn app.main:app` — its lifespan then idempotently seeds the generic demo bank
     (no-op behavior preserved) + admin, and overlays saved config.
- The client bundle (importer script + source docs, zipped) is uploaded **once, manually**, from
  a local checkout to the Storage Account's private `client-bundle` container. This preserves the
  repo's security model: client content never enters the public repo or the image.

## Backend changes

- **`backend/entrypoint.sh`** (new): migrate → optional client-bundle fetch+import → exec uvicorn.
  Bundle fetch is best-effort/idempotent (importer already skips an existing bank). Gated on env
  var `CLIENT_BUNDLE_BLOB` (blob name) being set; absent → skip, generic demo only.
- **`backend/scripts/fetch_client_bundle.py`** (new): download+extract the bundle from
  `AZURE_STORAGE_ACCOUNT_URL` + container using `azure.identity.DefaultAzureCredential` +
  `azure-storage-blob` (already an `[azure]` extra dep). Writes importer to `scripts/` and source
  docs to the expected `--source-dir`, then the entrypoint invokes the importer.
- **`backend/Dockerfile`** (new): `python:3.11-slim`, `pip install -e ".[azure]"`, copy app,
  `chmod +x entrypoint.sh`, `HEALTHCHECK` on `/health`, `CMD ["./entrypoint.sh"]`. Add ffmpeg only
  if voice scoring transcode is needed (confirm during impl).
- No CORS work: frontend nginx reverse-proxies `/api` same-origin (backend has no CORS middleware
  today, by design).

## Frontend changes

- **`frontend/Dockerfile`** (new): node-20 build stage (`npm ci && npm run build`) → nginx serve
  stage. **Drop** the reference's `rt-client-0.5.2.tgz` COPY line (this project has no such dep).
- **`frontend/nginx.conf`** (new): SPA fallback (`try_files $uri /index.html` — needed for deep
  links like `/admin/agent/:id`), `/api/` reverse-proxy to `${BACKEND_URL}` with WebSocket upgrade
  headers (for `/api/voice-live/ws`), and a `/health` 200 endpoint. `client.ts` uses relative
  `/api`, so no build-time API base needed beyond same-origin.

## Infrastructure (Bicep) — simplified from reference

Reuse the reference module *shapes* but drop everything not needed. `infra/azure/main.bicep`
(subscription scope, creates RG in Sweden Central) wires these modules:

| Module | Purpose | Source |
|---|---|---|
| `managed-identity` | user-assigned MI for both apps | copy as-is |
| `container-registry` | Basic ACR | copy as-is |
| `monitoring` | Log Analytics + App Insights | copy as-is |
| `storage` | one private `client-bundle` blob container (+ `materials` optional) | trim reference |
| `key-vault` | secrets: `secret-key`, `encryption-key`, `seed-admin-password`, `admin-api-token` | trim reference |
| `container-apps` | backend + frontend only (no PO/PG) | heavily trim reference |
| `github-oidc` | federated deploy identity | copy as-is |
| `role-assignments` | ACR pull (both), Storage Blob Data Reader (backend MI), Key Vault Secrets User (backend MI), + GitHub deploy Contributor/ACR push | trim reference |

**Dropped modules:** postgresql, postgresql-entra-admin, ai-foundry, ai-openai, ai-search,
content-understanding, speech-avatar, network/VNet, prompt-optimizer.

**Backend Container App env** (fresh boot goes live on real Foundry via MI, no saved DB config):
- Plain env: `DATABASE_URL=sqlite+aiosqlite:///./data/ai_interview.db`, `DEBUG=false`,
  `DEFAULT_LLM_PROVIDER=azure`, `DEFAULT_VOICE_PROVIDER=azure`,
  `DEFAULT_RETRIEVAL_PROVIDER=azure`, `DEFAULT_AGENT_SYNC_PROVIDER=azure`,
  `AZURE_FOUNDRY_ENDPOINT`, `FOUNDRY_PROJECT_ENDPOINT`, `AZURE_FOUNDRY_DEFAULT_PROJECT`,
  `FOUNDRY_AGENT_MODEL`, `VOICE_LIVE_DEFAULT_MODEL`, `VOICE_LIVE_API_VERSION`,
  `AZURE_CLIENT_ID` (= backend MI client id, so DefaultAzureCredential picks the right identity),
  `AZURE_STORAGE_ACCOUNT_URL`, `CLIENT_BUNDLE_BLOB`, `APPLICATIONINSIGHTS_CONNECTION_STRING`.
- Key Vault secretRefs: `SECRET_KEY`, `ENCRYPTION_KEY`, `SEED_ADMIN_PASSWORD`, `ADMIN_API_TOKEN`.
- **Single replica** `min=max=1` (ephemeral + per-replica DB divergence; also keeps Voice Live WS
  affinity trivial).

**Grant on the EXISTING Foundry resource** (cross-RG, out of this Bicep's scope): a separate
`az role assignment create` step (in the deploy workflow or a documented one-time script) grants
the backend MI **Cognitive Services User** + **Azure AI Developer** (and Search roles if KB is
used) on the existing Foundry account — same pattern as the reference
`infra/azure/scripts/grant-search-rbac.sh`.

## CI/CD workflows (`.github/workflows/`)

- **Keep** existing `ci.yml` (lint/test/e2e gate) unchanged.
- **`infra-main.yml`** (new): on `infra/**` changes — `az bicep build` validation.
- **`deploy-app.yml`** (new): on push to `main` touching `backend/**`/`frontend/**` or manual
  dispatch. OIDC login → `az acr build` backend + frontend images → `az containerapp update` both
  → get backend FQDN → rebuild frontend with `BACKEND_URL` → health-check. Single `public`
  environment profile in `infra/azure/environments/public.json` (client id / tenant / sub / RG /
  ACR / app names). **No** bootstrap-job step (seeding is in-app now).

## One-time setup (documented in `infra/azure/README.md`)

1. `az deployment sub create` with `main.bicep` → provisions RG + all resources in Sweden Central,
   outputs the GitHub OIDC values.
2. Add outputs to `infra/azure/environments/public.json`.
3. Set Key Vault secrets (or pass as Bicep secure params): jwt/encryption/seed-admin/admin-token.
4. Run the Foundry RBAC grant script (MI → existing Foundry account).
5. Upload the client bundle once: zip importer + `EU_avatar_inspector_interview/`, `az storage blob
   upload` to the private `client-bundle` container (MI/AAD auth).
6. Push to `main` → `deploy-app.yml` builds+deploys.

## Known gotchas (confirmed by reading the code)

- **Importer `--source-dir` must be explicit.** `import_rfcsm_bank.py:_repo_root()` returns
  `Path(__file__).resolve().parents[2]`; inside the image (WORKDIR `/app`) that resolves to `/`,
  so the default source dir is wrong. `entrypoint.sh` must pass `--source-dir` pointing at where
  `fetch_client_bundle.py` extracted the docs (e.g. `/app/_client_bundle/EU_avatar_inspector_interview`).
- **Writable ephemeral paths.** SQLite file and the local SOP store must live under a writable dir
  (e.g. `/app/data/...`). Set `DATABASE_URL=sqlite+aiosqlite:///./data/ai_interview.db` and
  `MATERIAL_STORAGE_PATH=/app/data/_sop_storage`; `Dockerfile` creates `/app/data`.
- **`AZURE_CLIENT_ID` is required** so `DefaultAzureCredential` selects the user-assigned MI (the
  Container App can have multiple identities). Already read by `azure_auth.py`.
- **Importer + source docs never enter the repo/image** — they are fetched at boot from the private
  blob. If `CLIENT_BUNDLE_BLOB` is unset (e.g. a fresh public demo), boot proceeds with the generic
  demo bank only.

## Verification

- **Local**: `docker build` backend + frontend; `docker compose`-style run with SQLite ephemeral,
  confirm `entrypoint.sh` migrates + (with bundle) imports; hit `/health` and the interview flow.
- **Bicep**: `az bicep build --file infra/azure/main.bicep` (also gated by `infra-main.yml`).
- **CI**: existing `ci.yml` still green (ruff format/check, pytest 85% gate, frontend build, e2e).
- **Live**: after deploy, frontend URL loads, `/api/health` 200, admin login with seeded password,
  interview runs against real Foundry via MI, client rf-CSM bank present as the enabled default.

_(Boot-sequence ordering, private-channel mechanism, and Bicep module list to be reconciled with
the Plan agent's pressure-test findings before finalizing.)_
