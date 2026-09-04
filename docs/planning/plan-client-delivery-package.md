# Plan — Client Delivery Package (bicep + images + Chinese manual)

Promoted from the local gstack plan (`~/.claude/plans/parsed-swinging-pie.md`) per the repo's
planning-doc policy. Captures the plan **and** the as-built outcome (2026-09-01).

> **Revision (2026-09-01) — simplified bank delivery to a plain Azure Files share.**
> The owner directed dropping the VNet + private-blob + skopeo-bundle channel for the client
> package ("blob storage 和 file storage 本身有 RBAC 限制…还是保持简单的"; "不想数据和镜像绑定
> 在一起"; "不能再这个应用启动的时候自动导入这个数据吗"). The client package now delivers the
> banks as **plain JSON files** uploaded to a **public Azure Files (SMB) share** (RBAC +
> account-key protected — **no VNet, no private endpoint**), mounted read-only into the backend at
> `CLIENT_BANKS_DIR` (`/app/_client_bundle/extra_banks`); the existing `seed_client_banks()` imports
> every `*.json` on each boot. **Application/Python code is unchanged.** This supersedes the
> blob/VNet/`build-bundle.sh`/`upload-bundle.sh`/`network.bicep` design described in the original
> body below — sections updated inline, and this delivery rework is intentionally **not committed**
> (delivered as a standalone zip via `make-delivery-zip.sh`). The vendor's **own live production
> infra** still uses VNet + private blob (see `IMPLEMENTATION-STATUS.md`); only the *client hand-off*
> was simplified.

## Goal

Package the tested AI-interview app so a **client can deploy it in their own Azure tenant, with
their own AAD**, without the vendor's GitHub repo or source code. Three deliverables: organized
bicep + prebuilt images, a Chinese `.docx` operator manual, and the manual publish path.

## Why the existing deploy path can't be handed over

The live path (`.github/workflows/deploy-app.yml` + `infra/azure/main.bicep`) is built for the
vendor's subscription + **GitHub Actions OIDC**. The client has no such repo and publishes with
its own AAD, so: (1) the `github-oidc` module + its two role assignments are vendor-only noise;
(2) there's no `deploy-app.yml` path for the client — they need a pure-`az` manual flow; (3) the
client brings its **own** Foundry / Voice Live resources.

## Key decisions (owner-confirmed)

- **No source code.** Deliver prebuilt image **tars** from the vendor ACR (`aiinterviewpublicacr`).
  Those were built by `az acr build` so they're already `linux/amd64` (correct for ACA/Linux; the
  owner's Mac is arm64 with no docker and couldn't rebuild them correctly anyway). Protects IP.
- **skopeo, not docker.** Export `docker-archive` tars via skopeo (AAD → ACR `oauth2/exchange`
  refresh token); the client re-pushes with `skopeo copy`. No docker daemon needed either side.
- **Version = the tested live build**: git `8b7eed1…` = VERSION `0.36.0.4`, retagged to the stable
  `v0.36.0.4` (git sha not exposed).
- **Trimmed bicep** in `delivery/infra/`, derived from `infra/azure/main.bicep`, differing only by
  `enableGithubOidc=false`. `modules/role-assignments.bicep` gained an `enableGithubOidc` param
  (default **true** in the main repo — behavior unchanged) gating the two GitHub role assignments.
  The backend MI's **AcrPull** is always created. (The Storage Blob Data Reader grant was removed
  in the Azure Files rework — the SMB mount authenticates with the account key, not blob RBAC.)
- **All 5 question banks reproduced** (see below).

## The 5-bank reproduction (the load-bearing detail)

Established authoritatively by exporting every bank from the live server
(`GET /admin/question-banks/{id}/export`, admin JWT):

| Bank | Qs | Channel |
|------|----|---------|
| Demo interview bank | 10 | committed `app/seeds/banks/*.json` → **baked in image**, auto-seed |
| Deployment SOP Interview | 3 | committed → **baked in image** |
| test-demo01 | 3 | committed → **baked in image** |
| rf-CSM GCO Inspection Interview | 9 | live export JSON → **Azure Files share** (`upload-banks.sh`) |
| rf-CSM GCO Inspection Interview-demo01 | 1 | live export JSON → **Azure Files share** (`upload-banks.sh`) |

The 3 generic banks were verified to match live and ship as committed seeds baked into the image.
The 2 rf-CSM banks carry **real SOP citation text + document names** → client-confidential, same
class as the gitignored `EU_avatar_inspector_interview/` and `import_rfcsm_bank.py`. In the
Azure Files rework they ride as **plain JSON files** delivered out-of-band (`delivery/banks/*.json`,
gitignored) and uploaded to the share with `upload-banks.sh`; the export bundle carries the full
rubric verbatim (weights, gates, `source_quote`, `source_page`, `source_document_name`), so the
banks reproduce with no importer and no SOP-doc corpus. The vendor assembles all 5 JSONs with
`export-banks.sh` (3 generic seeds + the 2 rf-CSM live exports). The live `default=test-demo01`
state is transient (ephemeral-SQLite reseeds every boot) and intentionally **not** chased — we
reproduce content, not the default flag.

## Security boundary (red lines)

The public repo may contain only trimmed bicep templates, scripts, manual **source**, and
`*.example` files. Gitignored / out-of-band only: the rf-CSM bank JSONs (real SOP text — `banks/`),
image tars, filled `deploy.env` / `main.parameters.json`, generated `.docx`, packaged dist zip.
Enforced by `delivery/.gitignore` and verified with a `git add -n` dry-run (18 safe files staged;
zero confidential artifacts). This delivery rework is delivered as a standalone zip
(`make-delivery-zip.sh`) and is **not committed**.

## As-built

```
delivery/
├── README.md
├── infra/{main.bicep, modules/*, main.parameters.example.json, scripts/grant-foundry-rbac.sh}
├── images/*.tar                       # gitignored, out-of-band
├── banks/*.json                       # 5 exported banks; gitignored (2 carry client SOP text)
├── scripts/{deploy-client.sh, deploy.env.example, upload-banks.sh, export-banks.sh, make-delivery-zip.sh}
├── docs/{手册.md, 客户发布操作手册.docx}   # .docx gitignored (regenerate from .md via pandoc)
└── .gitignore
```

- `deploy-client.sh`: login → infra (first-create passes real image tags) → skopeo push to client
  ACR → `containerapp update` (frontend gets `BACKEND_URL`) → `grant-foundry-rbac.sh` → `/health`
  poll (15×). Idempotent; `--infra-only` / `--skip-infra` for partial reruns. **No `az acr build`.**
- `export-banks.sh` (vendor-side): assembles all 5 bank JSONs into `.bundle-staging/banks/` — the
  3 committed generic seeds + the 2 rf-CSM live exports. Validates each is a `bank`+`questions`
  bundle. Excluded from the client zip.
- `upload-banks.sh` (client-side): `az storage file upload` of `banks/*.json` to the Azure Files
  share (`client-banks`) using the account key (`az storage account keys list`). **No VNet** — runs
  from the client's laptop. **One step**: given `BACKEND_APP` + `RESOURCE_GROUP` it also restarts
  the backend's active revision so `seed_client_banks()` imports on the next boot (omit `BACKEND_APP`
  to upload only; `NO_RESTART=1` to skip the restart).
- `make-delivery-zip.sh`: packages the client zip (templates + scripts + `banks/` + images + `.docx`);
  `--no-banks` / `--no-images` flags. Excludes secrets and the vendor-side `export-banks.sh`.

## Verification performed

- `az bicep build` on `delivery/infra/main.bicep` → 0 warnings (BCP318 on the conditional
  `githubOidc` module suppressed with documented `#disable-next-line`). `network.bicep` removed.
- Azure Files wiring confirmed in bicep: `fileServices/shares` (`client-banks`), a
  `managedEnvironments/storages` (`azureFile` with `listKeys()` account key, `ReadOnly`),
  `volumes`/`volumeMounts` at `CLIENT_BANKS_DIR`. No dangling `clientBundle`/`network.bicep`/
  `infrastructureSubnetId`/`blobEndpoint`/`storageBlobDataReader` references remain.
- `bash -n` on all 5 scripts; `export-banks.sh` staged 4 banks (9Q needs a live backend export).
- `pandoc 手册.md -o 客户发布操作手册.docx` → valid OOXML, CJK intact.
- `git add -n delivery/` dry-run: only 18 templates/scripts/manual-source staged; no
  tar/zip/docx/env/parameters/banks; no real secrets (only public Azure role-definition GUIDs).

## Live validation in a real client tenant (2026-09-01)

Ran the full `deploy-client.sh` chain against a genuine second tenant (subscription
`11b83efa…`, RG `demo-rg` — an **existing** RG, no new group), separate Foundry
`qiah-hu-demo-prj-resource` with `gpt-4.1-mini`. End-to-end confirmed:

- **Deploy chain**: infra (placeholder image) → skopeo push `v0.36.0.4` → `containerapp update`
  to the real image → `grant-foundry-rbac.sh` (both roles created) → frontend + backend
  `/health` = 200.
- **All 5 banks visible** in `/admin` after `upload-banks.sh` (3 generic baked in + 2 rf-CSM
  from the Files share).
- **Keyless MI → Foundry**: model-deployment list returned `gpt-4.1-mini` via MI; default
  persona `agent_sync_status=synced` (`agent_id: interviewer-…`, character lisa) — MI created a
  Voice Live agent on the client Foundry with **no API key**.
- **Digital-human path verified live**: a raw WS client to the backend proxy `/voice-live/ws`
  (NOT `/api/…` — the `/api` prefix is a *frontend nginx* rewrite; the backend serves at root)
  completed the handshake `proxy.connected → session.created → session.updated →
  conversation.item.created`. That is the Azure Voice Live session (avatar "lisa") established
  over the backend Managed Identity — the keyless avatar/interview path works in the client's
  own tenant.

### Two bug fixes made during validation (scripts + app)

1. **`deploy-client.sh` circular-dependency fix**: passing *empty* image params triggered
   bicep's "preserve running image" branch, which reads the app's own same-named `existing`
   resource → ARM `InvalidTemplate: Circular dependency`. Fixed to **always pass a concrete
   image** (placeholder on first-create; the app's current image on re-run) — never touches the
   self-reference branch. Mirrors the proven `deploy-app.yml` pattern.
2. **Locale/multibyte fix** across `deploy-client.sh` / `export-banks.sh` / `make-delivery-zip.sh`:
   a full-width `）` immediately after `$VAR` in a non-UTF-8 locale absorbed the char's first byte
   into the variable name → `set -u` unbound-variable death. Fixed with `${VAR}` braces at every
   such site + a `LC_ALL/LANG=C.UTF-8` fallback at the top of `deploy-client.sh`.
3. **App bug (`backend/app/services/voice_providers.py`)**: `_register_azure()` required an
   API key to register the Azure voice provider, so a keyless deployment silently fell back to
   the mock provider on the **WebRTC-broker** credential path. Changed the guard to endpoint-only
   (the provider is Entra-first; key is an optional STS fallback). NOTE: the *actual* avatar path
   is the WS proxy, which already resolved MI credentials independently — so this fix is correct
   but not the digital-human blocker; taking it live needs an image rebuild (not required for the
   validated avatar path).

Docs updated to match: manual §2.3/§5/§6 + README now state the keyless-MI behavior explicitly
("no API key saved" is expected, not an error) and add a digital-human troubleshooting row.

## Revision v2 (2026-09-02) — RG-Owner deployable + banks always-loaded + secrets helper

After the owner reviewed the Word manual, three client-landing issues were fixed (scripts **and**
docs both updated, per standing directive):

1. **Subscription scope → resource-group scope.** The client only has **Owner on one resource
   group**, not subscription-level rights. `delivery/infra/main.bicep` changed
   `targetScope='subscription'` → `'resourceGroup'`; removed `resourceGroupName` /
   `createResourceGroup` params + the `effectiveResourceGroupName` var + the conditional
   `deploymentResourceGroup` resource; dropped `scope:` from all modules; `output resourceGroupName`
   → `resourceGroup().name`. `deploy-client.sh` step 2 `az deployment sub create --location` →
   `az deployment group create -g "$RESOURCE_GROUP"` (location passed as a param); step 3
   `deployment group show -g`. Added a **RG-exists precheck** (`az group show`, hard-fail with a
   "ask your subscription admin to pre-create + grant Owner" message) and a **best-effort RP probe**
   (6 providers; prints the one-time `az provider register` command an admin must run, never
   hard-fails). `deploy.env.example` gained `RESOURCE_GROUP`; the param file dropped the two RG
   params. Manual §2.1 rewritten: **RG-Owner is enough**; two subscription-admin one-time
   prerequisites (pre-create RG, register RPs).
2. **Banks folded into the main deploy (no longer "optional §4").** All 5 banks are treated
   identically: 3 generic baked in the image + 2 rf-CSM auto-uploaded. `deploy-client.sh` gained
   **step 5b** — if `delivery/banks/*.json` exists, it calls `upload-banks.sh` with the storage
   account (read from deploy output) + backend app + RG, uploading + restarting so
   `seed_client_banks()` imports on boot; if `banks/` is absent it warns (3 generic still load) and
   does not fail. Manual's standalone optional §4 deleted, folded into a new §1.4 ("all 5 auto-load,
   zero client action"); §5 verify → §4, §6 troubleshooting → §5, with a manual-reupload
   troubleshooting row retained.
3. **`gen-secrets.sh` (openssl-only secrets helper).** New `delivery/scripts/gen-secrets.sh`
   generates all 4 secrets with **openssl only** (no Python/cryptography): `secretKey` /
   `adminApiToken` = `openssl rand -hex 32`; `encryptionKey` = `openssl rand 32 | base64 | tr '+/'
   '-_'` (**Fernet urlsafe-base64** — avoids the standard-base64 `+`/`/` runtime-reject trap,
   verified `Fernet()` accepts it); `seedAdminPassword` = suggested strong value. Manual §2.2 drops
   the Python dependency and documents openssl per-platform (built-in on macOS/Linux; Git Bash/WSL2
   on Windows); §3.1 replaces the two-command block with `./gen-secrets.sh`. Added to
   `make-delivery-zip.sh` whitelist.

Verification (all passed): `az bicep build` on RG-scope `main.bicep` (0 error); `bash -n` on all 6
scripts; `gen-secrets.sh` real-run + `Fernet()` accepts the generated `encryptionKey`; `pandoc`
regenerated `客户发布操作手册.docx` and 8 new key phrases asserted present (RG-Owner,
`az deployment group create`, `gen-secrets.sh`, 全部 5 套题库, `az provider register`, Fernet
urlsafe-base64, `RESOURCE_GROUP`) + the optional-§4 title confirmed removed; `git add -n delivery/`
dry-run = 19 safe files (incl. `gen-secrets.sh`), zero banks/images/env/params/docx/dist. Delivery
rework remains **uncommitted** (standalone zip only). NOT live-re-validated end-to-end in a tenant
yet (bicep+scripts statically verified; the demo-rg live run was on the pre-v2 subscription-scope
package).

## Revision v2.1 (2026-09-02) — bank docs: uniform framing, folded into the one-click step

After the owner reviewed the v2 manual, the bank documentation was reworked once more — a
**documentation-representation change only** (the deploy script already auto-loads all 5 banks in
the one-click flow; no script-behavior change). Two owner requests:

1. **Do not distinguish "3 generic vs 2 rf-CSM" — treat all 5 uniformly, all deployed by default.**
   Removed the split framing everywhere client-facing: manual §1.4's "3 套通用 + 2 套 rf-CSM"
   wording, the verify-step "(3 套通用 + 2 套 rf-CSM)" parenthetical (→ "全部 5 套"), the
   troubleshooting row "只看到 3 套题库" (→ "题库数量不足 / 少于 5 套"), `deploy-client.sh`'s
   success echo, and README's bank section. The rf-CSM confidentiality red line is unchanged (those
   2 banks still ride as out-of-band `banks/` JSON, never committed) — it's just no longer surfaced
   as a separate "optional" *category* in the client-facing narrative.
2. **Not "optional", not a separate chapter, not two steps — fold into §3.2 一键发布 + a brief
   manual-data note.** Deleted the standalone §1.4 bank chapter; added a "题库(随一键发布自动全量
   加载,贵方零操作)" subsection *inside* §3.2 stating the banks import automatically as part of the
   single one-click run (no ordering, nothing optional), plus a "**手动数据说明**" paragraph
   (JSON in `banks/` → account-key upload to the Files share, no VNet → re-imported on every boot;
   how to re-run if `banks/` was absent). §1.2's pointer updated `(详见 §1.4)` → `(详见 §3.2)`.

Verification: `pandoc` regenerated `客户发布操作手册.docx`; 7 asserts passed (new §3.2 bank
subhead present, 手动数据说明 present, uniform "随交付包一并提供" phrasing present; old §1.4
chapter title / "题库(全部 5 套自动加载…)" / body "3 套通用题库" / "3 套通用 + 2 套 rf-CSM" all
confirmed **absent**; §3.2 一键发布 still present). `bash -n deploy-client.sh` OK. Still
**uncommitted** (standalone zip only); still not live-re-validated end-to-end.

## Out of scope

Unchanged: `deploy-app.yml` / `infra-main.yml` (the vendor's auto-deploy). No portal
screenshot tutorial (manual uses prerequisite checklist + command granularity).
