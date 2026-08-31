# Runbook: sync the question bank + rubric to the deployed server

> **This is now the FALLBACK, not the norm.** The durable fix is boot-time seeding via the
> VNet + Storage private endpoint (revives `entrypoint.sh`'s bundle fetch so the real bank seeds
> automatically on every boot) — see [`../infra/azure/README.md`](../infra/azure/README.md) step 4
> and `docs/IMPLEMENTATION-STATUS.md`. Use this manual sync when boot-seeding isn't yet applied/
> verified, or as a recovery path if a boot fetch fails. Keep it until boot-seeding is proven across
> a real restart.

## Why this exists

The deployed backend runs on **ephemeral SQLite**: every boot/redeploy wipes the DB and reseeds it
with only the generic, rubric-less **demo bank** (`question_seed.seed_default_bank`, 10 questions,
**no checklists**). The private-blob channel that was meant to seed the real client bank at boot is
**unavailable** — the storage account has `publicNetworkAccess: Disabled` under the MCAPS
management-group policy, so the container cannot pull the bundle at start-up.

Two symptoms follow directly from this, and both are fixed by running the sync below:

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

## ⚠️ Re-run after every deploy/restart

The server DB is **ephemeral**. Any redeploy, scale-to-zero-and-back, or replica restart wipes it
and reseeds the demo bank — so **you must re-run this sync after every deploy/restart** for the
server to match local. `question_seed.seed_default_bank` is idempotent (no-op when an enabled
default already exists), so once synced it will not overwrite the imported bank *within a single
boot* — but the next restart starts from an empty DB again.

There is no client content in `scripts/sync_bank_to_server.py`: bank/question/rubric text is read
from the local DB at run time, and SOP files from the local `--sop-dir`. Nothing is hardcoded, so
the script is safe in the public repo. The SOP source files themselves remain gitignored client
material.
