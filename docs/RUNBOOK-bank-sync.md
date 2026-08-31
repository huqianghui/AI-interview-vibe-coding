# Runbook: sync the question bank + rubric to the deployed server

> **This is now the FALLBACK, not the norm.** The durable fix is boot-time seeding via the
> VNet + Storage private endpoint (revives `entrypoint.sh`'s bundle fetch so the real bank seeds
> automatically on every boot) — see [`../infra/azure/README.md`](../infra/azure/README.md) step 4
> and `docs/IMPLEMENTATION-STATUS.md`. Use this manual sync when boot-seeding isn't yet applied/
> verified, or as a recovery path if a boot fetch fails. Keep it until boot-seeding is proven across
> a real restart.

## Why this exists

The deployed backend runs on **ephemeral SQLite**: every boot/redeploy wipes the DB and reseeds it
with the generic, rubric-less **demo bank** (`question_seed.seed_default_bank`, 10 questions, **no
checklists**). Since 2026-08-31 the private-blob channel that seeds the real client bank at boot is
**live and durable** — the storage account's `publicNetworkAccess: Disabled` (MCAPS policy) is
satisfied by a blob **private endpoint** reachable from the VNet-integrated Container Apps env, so the
container pulls the bundle at start-up on every boot (see the header note). This runbook is the
**recovery path** for when that boot fetch fails.

If boot-seeding is not applied/verified, or a boot fetch fails, two symptoms follow directly, and both
are fixed by running the sync below:

1. **Server questions differ from local.** The server shows the demo bank; local shows the real
   default bank.
2. **The report shows coverage 0 / no final result.** Scoring needs rubric (checklist) items to
   score against. The demo bank has none, so every answer falls to a length **stub**
   (`any_graded=False` → `total_score=0.0`, no grade/outcome). This is not a scoring bug — it is
   missing rubric data.

## The sync channel (admin API)

A **bank bundle** — the bank + its ordered questions + each question's full checklist (item
weights, `advisory` gates, and SOP source attribution **by document name**) — is exported from the
local DB and imported over the admin API. Endpoints (both gated by the admin bearer token):

- `GET /admin/question-banks/{bank_id}/export` → the bundle JSON.
- `POST /admin/question-banks/import` → create-or-replace by bank name; returns a summary
  (`question_count`, `checklist_item_count`, `unresolved_sop_names`).

Rubric items are written **verbatim**, including `advisory` gates and SOP citations — unlike
`PUT /admin/checklists/{id}/items`, which drops both. SOP source links travel as document **names**
(a checklist item's `source_document_id` is a per-DB uuid); on import each name is resolved to the
server's own `SopDocument.id`. An unresolved name degrades gracefully to no citation link and is
reported in `unresolved_sop_names` — scoring is unaffected (`source_document_id` is nullable and
never enters the weighted score).

## Run the sync

From `backend/` with the venv active. Credentials come from the environment (never a flag), so they
stay out of shell history and the repo:

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD='<server-admin-password>' \
  .venv/bin/python scripts/sync_bank_to_server.py \
    --server https://<backend-app>.azurecontainerapps.io \
    --sop-dir ../EU_avatar_inspector_interview/Data_Sources_AI_Inspector
```

- Without `--bank-id`, the local **enabled default** bank is synced.
- `--sop-dir` is optional; it points at the local SOP source files so the rubric's citations resolve
  by name. Omit it and the bank + rubric still import — only the citation links are skipped
  (reported as `unresolved_sop_names`).

The script logs in, uploads any referenced SOP documents the server is missing
(`POST /admin/sop/documents`), then POSTs the bundle. It prints what was written.

## When to re-run

With boot-time auto-seeding live (2026-08-31), the server self-seeds the real rf-CSM bank on **every**
boot/restart/redeploy — you no longer need to re-run this sync routinely. Run it only as a **recovery
step** when boot-seeding hasn't been applied to a given environment, or when the boot logs show a
`client bundle fetch failed` WARNING (bundle-content or DNS issue). The server DB is **ephemeral**, so
a sync you run by hand is itself wiped on the next restart — the durable seed comes from the boot
channel, not this script. `question_seed.seed_default_bank` is idempotent (no-op when an enabled
default already exists), so it never overwrites the imported bank *within a single boot*.

There is no client content in `scripts/sync_bank_to_server.py`: bank/question/rubric text is read
from the local DB at run time, and SOP files from the local `--sop-dir`. Nothing is hardcoded, so
the script is safe in the public repo. The SOP source files themselves remain gitignored client
material.
