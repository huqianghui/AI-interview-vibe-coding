# Runbook: sync the question bank + rubric to the deployed server

> **This is now the FALLBACK, not the norm.** The durable fix is boot-time seeding via the
> VNet + Storage private endpoint (revives `entrypoint.sh`'s bundle fetch so the real bank seeds
> automatically on every boot) — see [`../infra/azure/README.md`](../infra/azure/README.md) step 4
> and `docs/IMPLEMENTATION-STATUS.md`. Use this manual sync when boot-seeding isn't yet applied/
> verified, or as a recovery path if a boot fetch fails. Keep it until boot-seeding is proven across
> a real restart.

## Why this exists

The deployed backend keeps its data in **Azure Database for PostgreSQL** (since v0.50.0.0;
[`database.md`](database.md)). Banks are seeded at boot **only when missing**: the private-blob
channel imports the client rf-CSM bank and its extra banks on a fresh database, and every later boot
leaves existing banks alone (bank ids, user assignments and interview pins all survive a restart).

So this sync is no longer a "re-run after every restart" step. Use it when you deliberately want to
**update a bank that already exists** on the server, e.g. corrected questions or a revised rubric in
a bundle. A re-import of a same-named bank replaces its questions and rubric **in place, keeping the
bank id**, so candidates assigned to the bank stay assigned. Note what that cannot keep: interviews
already recorded against the old questions reference question ids that no longer exist, so re-scoring
such an interview after a sync scores it against the new rubric.

(Before v0.50.0.0 the server ran ephemeral SQLite, wiped and reseeded on every boot; this runbook
was then a recovery step for a boot whose bundle fetch failed.)

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
    --server https://<frontend-app>.azurecontainerapps.io/api \
    --sop-dir ../EU_avatar_inspector_interview/Data_Sources_AI_Inspector
```

- `--server` is the FRONTEND's `/api` proxy: the backend's ingress is internal, so it has no public
  URL of its own.
- Without `--bank-id`, the local **enabled default** bank is synced.
- `--sop-dir` is optional; it points at the local SOP source files so the rubric's citations resolve
  by name. Omit it and the bank + rubric still import — only the citation links are skipped
  (reported as `unresolved_sop_names`).

The script logs in, uploads any referenced SOP documents the server is missing
(`POST /admin/sop/documents`), then POSTs the bundle. It prints what was written.

## When to re-run

The server DB is **persistent** (PostgreSQL), so a sync you run by hand stays. Boot seeding only
creates banks that do not exist yet, so it never overwrites a bank you synced. If the boot logs show
a `client bundle fetch failed` WARNING on a FRESH database, the client bank is simply missing: fix
the bundle and restart, or run this sync once.

There is no client content in `scripts/sync_bank_to_server.py`: bank/question/rubric text is read
from the local DB at run time, and SOP files from the local `--sop-dir`. Nothing is hardcoded, so
the script is safe in the public repo. The SOP source files themselves remain gitignored client
material.
