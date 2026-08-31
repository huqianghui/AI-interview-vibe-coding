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
| Storage account | private `client-bundle` container (client interview material) + `materials`; reached only via a blob **private endpoint** (no public access) |
| VNet + private endpoint | `vnet-…` with a subnet delegated to the ACA env + a PE subnet; `privatelink.blob.core.windows.net` private DNS zone; blob private endpoint (`modules/network.bicep`) |
| Container Apps (backend + frontend) | **single replica each** (ephemeral SQLite; WS affinity); **VNet-integrated** env (external ingress, private egress to storage); the four runtime secrets are Container App **native secrets** (see note below) |
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
- AI Search / Content Understanding / Speech-Avatar, prompt-optimizer sidecar.

> **A VNet IS created** (`modules/network.bicep`). The storage account is policy-locked private (the
> MCAPS policy force-disables its `publicNetworkAccess`), so the backend reaches the client bundle
> only through a blob **private endpoint** from inside a **VNet-integrated** Container Apps
> environment. This is what makes boot-time client-bank seeding work — see step 4.

## The boot-time data story (why there's no bootstrap Job)

Because SQLite is ephemeral and per-replica, the reference project's separate "bootstrap Job" can't
seed it (its disk isn't the app's). Instead the backend container seeds itself on every start
(`backend/entrypoint.sh`):

1. `alembic upgrade head` — create the schema on the fresh empty SQLite.
2. If `CLIENT_BUNDLE_BLOB` is set — download the private client bundle from the `client-bundle` blob
   container (managed identity, no keys), then run the client-bank importer against the local DB.
3. `uvicorn` starts — the FastAPI lifespan idempotently seeds the generic demo bank + admin.

The client importer + its source docs are **gitignored** (absent from the public repo and the CI
image). They reach the container only through the private blob you upload in step 4 below. With
`CLIENT_BUNDLE_BLOB` unset, the app boots in public-demo mode (generic bank only). Because the
storage account is private (blob private endpoint only), the container resolves
`<account>.blob.core.windows.net` to the endpoint's private IP via the linked private DNS zone — the
fetch needs no keys (the backend MI has Storage Blob Data Reader) and no public network path.

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

### 4. (Optional) Upload the private client bundle — auto-seeds the real bank on every boot

With the VNet + blob private endpoint in place (this infra), the backend's boot-time fetch reaches
the private container, so seeding the real rf-CSM bank is **durable**: it re-runs on every
boot/restart/redeploy with **no manual step**. You upload the bundle **once**.

> **⚠️ The upload must originate inside the VNet.** The storage account is policy-locked private
> (`publicNetworkAccess: Disabled`, forced by the MCAPS policy), so an `az storage blob upload` from
> a laptop over the public internet **fails**. The temporary-IP-allowlist trick does **not** work
> either — the Modify policy overrides `networkAcls.ipRules`. Run the upload from **Azure Cloud
> Shell with VNet integration into `vnet-<prefix>-<env>`**, or from a jumpbox/VM in (or peered to)
> that VNet.

```bash
# from a local checkout that HAS the gitignored client material:
( cd backend && zip -r /tmp/rfcsm-bundle.zip \
    scripts/import_rfcsm_bank.py \
    ../EU_avatar_inspector_interview )

# then, from a shell INSIDE the VNet (Cloud Shell VNet-integrated, or a jumpbox in the VNet):
az storage blob upload \
  --account-name <storageAccountName> \
  --container-name client-bundle \
  --name rfcsm-bundle.zip \
  --file /tmp/rfcsm-bundle.zip \
  --auth-mode login          # AAD/MI auth — the account has shared-key access disabled

# Point the backend at it — set the param in main.parameters.json and re-apply (idempotent), or
# for a quick change set the env var directly on the backend app:
az containerapp update -g <rg> -n <backendAppName> \
  --set-env-vars CLIENT_BUNDLE_BLOB=rfcsm-bundle.zip
```

The zip layout must be `import_rfcsm_bank.py` + `EU_avatar_inspector_interview/…` at the root (see
`backend/scripts/fetch_client_bundle.py`).

> **Fallback:** if boot-seeding ever fails (e.g. a bundle-content or DNS issue), the admin-API sync
> in [`docs/RUNBOOK-bank-sync.md`](../../docs/RUNBOOK-bank-sync.md) reconciles the server to local
> without touching infra. Keep it until boot-seeding is proven across a real restart.

### ⚠️ Applying the VNet change to an existing (VNet-less) deployment

A managed environment's `vnetConfiguration` is **immutable** — you cannot add a VNet to a running
environment in place. If the environment already exists without a VNet, the apply requires a
**delete + recreate**, which is a brief **outage** and **reassigns both apps' FQDNs** (the
env-unique domain segment changes). No tracked file hard-codes the FQDN, so the fallout is limited
to bookmarks and the Entra app's redirect URI.

> **This is a ONE-TIME manual switch, not a CI step.** Infra is never applied by a workflow
> (`infra-main.yml` only `az bicep build`-validates; `deploy-app.yml` only updates images). Once the
> VNet-integrated env exists, every later `az deployment sub create` is **idempotent** — the VNet/PE/
> DNS become no-ops and the image params **preserve the running image** (see idempotency note below),
> so a re-apply never disturbs the deployed app.

```bash
# 1. compile + dry-run: expect Create on the Network resources and Delete+Create on the env.
az bicep build --file infra/azure/main.bicep --stdout >/dev/null
az deployment sub create --name aiinterview-public --location swedencentral \
  --template-file infra/azure/main.bicep --parameters @infra/azure/main.parameters.json --what-if

# 1a. capture the CURRENTLY-running image tags BEFORE deleting (so the recreate can start straight on
#     the real images with no placeholder window). Skip if you're fine with a brief placeholder page.
BE=$(az containerapp show -n ca-<prefix>-<env>-backend  -g <rg> --query "properties.template.containers[0].image" -o tsv)
FE=$(az containerapp show -n ca-<prefix>-<env>-frontend -g <rg> --query "properties.template.containers[0].image" -o tsv)

# 2. delete the existing env (cascades → both apps). THIS is the outage window.
az containerapp env delete --name cae-<prefix>-<env> -g <rg> --yes
az containerapp list -g <rg> -o table   # confirm empty before continuing

# 3. apply for real — recreates network → VNet-integrated env → both apps. Pass the captured image
#    tags: on a fresh env the apps don't exist yet, so there is no running image to preserve and an
#    empty image param would fall back to the helloworld PLACEHOLDER. Passing the real tags here
#    avoids that window entirely.
az deployment sub create --name aiinterview-public --location swedencentral \
  --template-file infra/azure/main.bicep --parameters @infra/azure/main.parameters.json \
  --parameters backendImage="$BE" frontendImage="$FE"

# 4. read the NEW FQDNs from the deployment's backendUrl/frontendUrl outputs; update the Entra
#    redirect URI + any shared links. environments/public.json needs no change (it holds resource
#    NAMES, not FQDNs). If you skipped 1a/the image params, re-run Deploy App (step 5) now to replace
#    the placeholder with the real images.
```

`backendIdentityPrincipalId` does not change (the identity resource is untouched), so
`grant-foundry-rbac.sh` need not be re-run — confirm it matches the previous output first.

#### Idempotency: who owns the image (infra vs. app-deploy)

`deploy-app.yml` owns the running image — it `az containerapp update --image <git-sha>` on every
push to `main`. So the infra template must **not** fight it: `backendImage`/`frontendImage` default
to **empty**, which `container-apps.bicep` resolves as *"preserve whatever image is currently
running"* (it reads the live app via an `existing` reference). Consequently:

- **Steady-state re-apply** (`@main.parameters.json`, no image params) → image is a **no-op**; the
  pipeline-deployed tag is kept. Re-applying infra to tweak, say, a Foundry model name will **not**
  reset the app to a placeholder.
- **First-create / env recreate** (no running app to read) → empty param falls back to the
  `helloworld` **placeholder**, so pass the real tags (step 3) or let step 5 replace them.
- Set image params **explicitly** only when you want infra to force a specific tag; normally leave
  them unset and let `deploy-app.yml` drive images.

Likewise `clientBundleBlob` is a template **param** (flows to `CLIENT_BUNDLE_BLOB`): set it in
`main.parameters.json` once the bundle is uploaded, and it survives every re-apply — prefer that
over a one-off `az containerapp update --set-env-vars`, which a later infra apply would not know
about (though the preserve logic covers the image, env vars set out-of-band on the app are still
reconciled to the template on the next apply).

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
