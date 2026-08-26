# AI-interview — Azure infrastructure & deployment

Infrastructure-as-code (Bicep) + the one-time setup for deploying AI-interview to Azure Container
Apps in **Sweden Central** (co-located with the reused Azure AI Foundry resource).

## What gets deployed

A deliberately small footprint (subscription-scope `main.bicep` creates the resource group + all of):

| Resource | Purpose |
|---|---|
| Log Analytics + App Insights | logs/traces for both apps |
| User-assigned managed identity | backend auth to Foundry / Storage (keyless) |
| Container Registry (Basic) | holds backend + frontend images |
| Storage account | private `client-bundle` container (client interview material) + `materials` |
| Container Apps (backend + frontend) | **single replica each** (ephemeral SQLite; WS affinity); the four runtime secrets are Container App **native secrets** (see note below) |
| GitHub OIDC identity | keyless deploy from GitHub Actions |
| Role assignments | AcrPull / Storage Blob Data Reader (backend MI); Contributor / AcrPush (deploy MI) |

> **No Key Vault.** The target MCAPS subscription's Azure Policy force-disables Key Vault public
> network access (reverts `publicNetworkAccess`→`Disabled` within seconds of any write), which a
> VNet-less Container App cannot reach. The four secrets (`secret-key`, `encryption-key`,
> `seed-admin-password`, `admin-api-token`) are therefore delivered as Container App **native
> secrets** (encrypted at rest by the platform), passed as `@secure()` Bicep params from the
> gitignored `main.parameters.json`. They still never enter the repo.

**Not created here (by design):**
- **Azure AI Foundry / Voice Live** — an *existing* resource is reused. The backend MI is granted
  access separately by [`scripts/grant-foundry-rbac.sh`](scripts/grant-foundry-rbac.sh).
- **No database PaaS** — the app runs on **ephemeral SQLite** on the replica's own disk, reseeded on
  every boot (see the backend `entrypoint.sh`). No Postgres.
- AI Search / Content Understanding / Speech-Avatar, VNet, prompt-optimizer sidecar.

## The boot-time data story (why there's no bootstrap Job)

Because SQLite is ephemeral and per-replica, the reference project's separate "bootstrap Job" can't
seed it (its disk isn't the app's). Instead the backend container seeds itself on every start
(`backend/entrypoint.sh`):

1. `alembic upgrade head` — create the schema on the fresh empty SQLite.
2. If `CLIENT_BUNDLE_BLOB` is set — download the private client bundle from the `client-bundle` blob
   container (managed identity, no keys), then run the client-bank importer against the local DB.
3. `uvicorn` starts — the FastAPI lifespan idempotently seeds the generic demo bank + admin.

The client importer + its source docs are **gitignored** (absent from the public repo and the CI
image). They reach the container only through the private blob you upload in step 5 below. With
`CLIENT_BUNDLE_BLOB` unset, the app boots in public-demo mode (generic bank only).

## One-time setup

Prerequisites: `az login` as an account with **Owner** (or User Access Administrator + Contributor)
on the target subscription, and Owner/UAA on the existing Foundry account's resource group.

### 1. Provision infra

```bash
cp infra/azure/main.parameters.example.json infra/azure/main.parameters.json
# Edit main.parameters.json: set globally-unique containerRegistryName/storageAccountName,
# generate the four secrets, and paste the EXISTING Foundry endpoints/model/project.

az deployment sub create \
  --name aiinterview-public \
  --location swedencentral \
  --template-file infra/azure/main.bicep \
  --parameters @infra/azure/main.parameters.json
```

Secret generation helpers:
```bash
openssl rand -hex 32                                   # secret-key / admin-api-token
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"  # encryption-key
```

### 2. Record the deploy profile

The deployment prints a `githubActions` output object. Copy its values into
[`environments/public.json`](environments/public.json) (client id / tenant / sub / RG / ACR / app
names). None of these are secrets — the OIDC login is keyless.

### 3. Grant the backend MI access to the existing Foundry resource

```bash
# backendIdentityPrincipalId is a deployment output.
infra/azure/scripts/grant-foundry-rbac.sh \
  --mi-principal-id <backendIdentityPrincipalId> \
  --foundry-subscription <sub-id> \
  --foundry-rg <foundry-rg> \
  --foundry-account <foundry-account-name>
```

RBAC propagation takes 5–10 minutes.

### 4. (Optional) Upload the private client bundle

> **⚠️ Blocked on subscriptions that disable Storage public network access.** The same MCAPS Azure
> Policy that disables Key Vault public access also force-disables the Storage account's
> `publicNetworkAccess`. When that policy applies, **both** the `az storage blob upload` below (from
> a laptop) **and** the backend's boot-time fetch (from a VNet-less Container App) are unreachable —
> leave `CLIENT_BUNDLE_BLOB` unset and run in public-demo mode. Seeding the real client bank then
> requires a **Storage private endpoint + a VNet-integrated Container Apps environment** (a separate
> infra change). The steps below apply only where Storage public access is permitted.

To auto-seed the client rf-CSM interview bank, zip the gitignored importer + source docs from a
local checkout and upload to the private container, then point the backend at it:

```bash
# from a local checkout that HAS the gitignored client material:
( cd backend && zip -r /tmp/rfcsm-bundle.zip \
    scripts/import_rfcsm_bank.py \
    ../EU_avatar_inspector_interview )

az storage blob upload \
  --account-name <storageAccountName> \
  --container-name client-bundle \
  --name rfcsm-bundle.zip \
  --file /tmp/rfcsm-bundle.zip \
  --auth-mode login          # AAD/MI auth — the account has shared-key access disabled

# Then set CLIENT_BUNDLE_BLOB on the backend Container App (or redeploy infra with the param):
az containerapp update -g <rg> -n <backendAppName> \
  --set-env-vars CLIENT_BUNDLE_BLOB=rfcsm-bundle.zip
```

The zip layout must be `import_rfcsm_bank.py` + `EU_avatar_inspector_interview/…` at the root (see
`backend/scripts/fetch_client_bundle.py`).

### 5. Deploy the app

Push to `main` (touching `backend/**` or `frontend/**`) or run the **Deploy App** workflow manually.
It builds both images with `az acr build`, updates both Container Apps, and health-checks the
backend. See [`.github/workflows/deploy-app.yml`](../../.github/workflows/deploy-app.yml).

## Local validation

```bash
az bicep build --file infra/azure/main.bicep --stdout >/dev/null   # compile check (also gated by infra CI)
docker build -t ai-interview-backend backend
docker build -t ai-interview-frontend frontend
```
