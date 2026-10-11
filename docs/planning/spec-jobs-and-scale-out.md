# Spec: a jobs table, a separate job process, and scale-out

Status: approved direction (owner, 2026-10-11), implementation in four PRs.

## Why

The backend assumes ONE process. In-flight work and its guards live in memory:

| Process-local state | Where | What breaks with >1 process |
|---|---|---|
| `_JUDGE_IN_FLIGHT` | `interview/judge_flow.py:32` | two judge calls for one session run at once |
| `_SCORING`, `_TASKS` | `api/admin_interviews.py:28` | double scoring; "scoring" flag only true on one process |
| `_BUILDS`, `_BUILD_LOCK`, `_CONVERTING` | `api/admin_sop.py`, `services/sop_section_service.py` | one document converted twice; "converting" flag wrong |
| `_SUMMARY_LOCK`, `_DRAFTING` | `services/sop_summary_service.py` | summaries drafted twice; "summarizing" flag wrong |
| `RUNS`, `_LIVE` | `services/sop_citation_service.py` | already DB-guarded (one running `CitationRun` per bank); `_LIVE` only speeds the liveness check |
| settings `lru_cache` + overlay | `config.py`, `services/config_overlay.py` | an admin config save reaches only the process that served it |
| boot steps + startup tasks | `entrypoint.sh`, `main.py` lifespan | migrations, seeds, persona sync, `build_missing` run once per process, concurrently |

And heavy work shares an event loop with live voice: a uvicorn worker that holds a candidate's
voice WebSocket also runs whatever scoring / SOP build lands on it, and any synchronous CPU in
that work (BM25 index rebuild, large JSON parse, PDF text splitting) freezes every socket on that
worker. More workers only shrink the share of interviews affected; a separate process removes it.

## Decisions (owner, 2026-10-11)

- Jobs run in a **separate process**, never in a web worker (the owner chose this over "inside the
  workers" to keep heavy work off the voice path entirely).
- Backend: **maxReplicas 2, minReplicas 1** (demo); uvicorn **3 workers**.
- Container sizes one tier up; PostgreSQL B1ms → **B2s**.
- **Out of scope:** a deploy cutting live voice sockets; recordings lost on a restart (accepted).
- Locks move to the **database**.

## Design

### 1. `jobs` table

```
jobs
  id              uuid pk
  kind            str    -- score_interview | sop_build | sop_summary | citation_run | persona_sync
  target_id       str    -- interview id / document id / bank id / persona id
  payload         json   -- e.g. {"sop_coverage_check": true}, {"fresh": true}, {"force": true}
  status          str    -- queued | running | succeeded | failed | cancelled
  attempts        int    -- incremented on each claim
  max_attempts    int    -- default 3
  progress        json   -- {"done": i, "total": n, ...} (scoring streams this)
  result          json   -- the handler's return value (scoring: the report dict)
  error           text
  lease_owner     str    -- "<hostname>:<pid>" of the runner holding it
  lease_until     datetime
  cancel_requested bool
  created_at / started_at / finished_at / updated_at
  created_by      str?   -- admin user id, "candidate", or "system"
```

- **One live job per target:** a partial unique index on `(kind, target_id)` where status in
  (`queued`, `running`), on both PostgreSQL and SQLite (the same `sqlite_where`/`postgresql_where`
  pattern `interview_sessions` already uses). `enqueue()` catches the `IntegrityError` and returns
  the live job, so two clicks or two processes get one job.
- **Claiming is a compare-and-set, not `SKIP LOCKED`** (portable to SQLite for dev/CI):
  pick the oldest `queued` id, then
  `UPDATE jobs SET status='running', lease_owner=?, lease_until=now+60s, attempts=attempts+1,
  started_at=now WHERE id=? AND status='queued'`; rowcount 1 = this runner owns it.
- **Lease and heartbeat:** the runner renews `lease_until` every 15 s for each job it holds. A
  `running` job whose lease has expired is reclaimed by any runner: back to `queued` if
  `attempts < max_attempts`, else `failed` with `error = "lease expired after N attempts"`.
  That is the restart recovery: no boot hook needed.
- **Cancel:** the API sets `cancel_requested`; the heartbeat sees it and cancels the asyncio task;
  status becomes `cancelled`. A queued job is cancelled directly.
- **Idempotency is a handler requirement**: a reclaimed job runs again from the start. Scoring
  overwrites the saved report; a SOP build replaces its sections in one transaction; a citation run
  creates a fresh `CitationRun`; persona sync is already a no-op when synced.
- Retention: succeeded jobs older than 30 days are deleted by the runner once a day.

### 2. The job process

- `python -m app.jobs.runner`: same image, same settings, its own event loop and its own
  connection pool. Polls for work every 1 s, runs up to `JOB_RUNNER_CONCURRENCY` (default 4) jobs
  at once; per-kind caps where the old code serialised (`sop_build`: 1, `sop_summary`: 1) are
  enforced in the claim query (`... AND NOT EXISTS (running job of that kind)` for capped kinds).
- Handlers live in `app/jobs/handlers.py`, one async function per kind, each wrapping the existing
  service function (`state_machine.score_and_finalize_events`, `sop_section_service.build`/
  `rebuild`, `sop_summary_service.redraft`/`summarize_missing`, `sop_citation_service.relocate`,
  `persona_seed.sync_default_persona`). Service code stays where it is; only the trigger moves.
- The runner configures App Insights (`telemetry.configure`) and wraps each job in a span
  `job.<kind>` with `job.id`, `job.target_id`, `job.attempt`.
- **Deployment:** a second container `jobs` in the backend Container App (sidecar: same image,
  env, identity and secrets; command overridden; no ingress). It must NOT run `entrypoint.sh`
  (migrations are the web container's job); it waits until `alembic current` equals head before
  claiming. With maxReplicas 2 there may be two runners: the CAS claim makes that safe.
- **Local dev / tests:** `JOB_RUNNER_MODE=embedded` starts the runner inside the FastAPI lifespan
  (one per process, still CAS-safe) so `uvicorn --reload` and the Playwright e2e keep working
  unchanged. Production sets `JOB_RUNNER_MODE=off` on the web container. pytest gets a
  `drain_jobs()` fixture that runs queued jobs inline.

### 3. What moves onto jobs

| Today | Becomes |
|---|---|
| candidate `POST /interview/{id}/report/stream` scores inside the request | enqueue `score_interview` (or attach to the live one), then poll the job row every 1 s and emit the SAME NDJSON lines (`progress` from `jobs.progress`, `report` from `jobs.result`, `error` from `jobs.error`). Frontend contract unchanged. |
| candidate `POST /interview/{id}/report` (batch) | enqueue + wait for the job (same polling), return the same `ReportOut` |
| admin `POST /admin/interviews/{id}/report` | enqueue `score_interview`, 202; `scoring` flag = a live job exists |
| SOP upload / "Convert again" / boot `build_missing` | enqueue `sop_build` per document; `converting` flag = a live `sop_build` job for it |
| summary redraft / `summarize_missing` | enqueue `sop_summary` per document; `summarizing` flag = a live job |
| `start_relocation` | still creates the `CitationRun` (the UI reads it), then enqueues `citation_run` with its id; `_LIVE` goes |
| boot `_sync_default_persona` | enqueue `persona_sync` once (unique index dedupes across processes) |

**Recordings stay in the web process.** The audio is in that process's memory, so a job in another
process cannot upload it; moving it would mean shipping the bytes through the database. The owner
accepted losing a recording on a restart, so `QuestionRecorder` is unchanged.

**Stays per process (correct as-is):** credential prewarm, judge adapter warm-up, `_VERIFIED`
password cache, `_QUERY_CACHE`, `_PARSED`, adapter registry, blob store cache, voice-model probe
cache. These are caches; duplicating them per process costs memory, not correctness.

### 4. Database locks

- **Judge in-flight:** `interview_sessions.judge_lease_until` (nullable datetime). Acquire:
  `UPDATE interview_sessions SET judge_lease_until = now+30s WHERE id=? AND
  (judge_lease_until IS NULL OR judge_lease_until < now)`; rowcount 0 → `JudgeInFlight` (409, the
  page treats it as "wait", unchanged). Release in `finally` by setting it NULL. A crashed process's
  lease expires in 30 s instead of wedging. Not an advisory lock: those are bound to one pooled
  connection and do not exist on SQLite.
- **Boot steps** (`main.py` lifespan seeds) and **migrations** (`alembic upgrade head` in
  `entrypoint.sh`): on PostgreSQL, run under `pg_advisory_lock(<constant>)` on one dedicated
  connection held for the duration, so the second replica waits and then finds everything done.
  No-op on SQLite. (An advisory lock is right here: one connection, held start to finish, released
  when the connection closes even if the process dies.)

### 5. Config reaches every process

`service_configs.updated_at` already changes on every save. Each process remembers the
`updated_at` it last applied; `config_overlay.ensure_current(db)` re-applies when the row is newer.
Called at Voice Live WS connect, at the start of each job, and by a 30 s background refresh in
each web worker. The save request itself still applies immediately in its own process.

### 6. Admin Jobs tab

`/admin` gains a **Jobs** tab, following the table design rule (clean rows, one hint line above,
no status prose in rows):

- Columns: kind, target (linked: interview → its report, document → SOP tab, bank → Content tab),
  status, attempts / max, created, duration, error (truncated, full text on hover).
- Filters: status, kind. Default view: queued + running + failed in the last 7 days.
- Actions: **Retry** on failed / cancelled (enqueues a new job with the same kind, target and
  payload), **Cancel** on queued / running.
- Polls every 5 s while any row is queued or running, otherwise every 30 s.
- API: `GET /admin/jobs?status=&kind=&limit=&offset=`, `POST /admin/jobs/{id}/retry`,
  `POST /admin/jobs/{id}/cancel`. OpenAPI snapshot + `schema.d.ts` regenerated.

### 7. Infra

| Item | Before | After |
|---|---|---|
| backend `web` container | 1.0 vCPU / 2 GiB | 2.0 vCPU / 4 GiB, `uvicorn --workers 3` |
| backend `jobs` container | — | 1.0 vCPU / 2 GiB (app total 3.0 / 6 GiB, an allowed Consumption combination) |
| frontend | 0.5 vCPU / 1 GiB | 1.0 vCPU / 2 GiB |
| backend replicas | 1 / 1 | min 1 / max 2 (HTTP scale rule) |
| PostgreSQL | B1ms (35 user connections) | B2s (414 user connections); `max_connections` set to 429 by hand + restart — Azure keeps the old default after a resize |
| DB pool per process | 10 + 15 overflow | web 5 + 5 per worker, jobs 5 + 5 → (3×10 + 10) × 2 replicas = 80, ×2 during a revision rollover = 160 |

The environment `cae-aiinterview-public` is a workload-profiles environment (Consumption profile),
so the 2 vCPU / 4 GiB cap of Consumption-only environments does not apply.

`deploy-app.yml` currently runs `az containerapp update --image` once; with two containers it must
update both (`--container-name web` and `--container-name jobs`, same image). The client delivery
package (`delivery/`, gitignored) needs the same sidecar later; not part of these PRs.

## PRs, in order

1. **Infra sizing** — container sizes, PostgreSQL B2s + `max_connections`, smaller pools. Still
   1 replica, 1 worker. Safe on its own.
2. **Jobs core** — `jobs` table + migration, runner (`embedded`/`off`), handlers, every trigger in
   §3 moved, DB judge lease, boot/migration advisory lock, config `ensure_current`, the `jobs`
   sidecar + deploy workflow. Still 1 replica, 1 worker: proves the job path live first.
3. **Jobs tab** — API + admin UI.
4. **Scale-out** — `--workers 3`, maxReplicas 2. Live check: two interviews in progress while an
   SOP converts and an admin rescores; no audio gap, no double job, config save seen by both.

## Tests

- Runner: claim race (two runners, one job → one claim), lease expiry → requeue → failed after
  max attempts, cancel queued and running, per-kind cap, retention purge.
- Unique live job per target (enqueue twice → same id), on SQLite and PostgreSQL.
- Report stream: NDJSON identical to today's (progress lines, final report, in-band error) with the
  job path; batch report returns the same `ReportOut`.
- Judge lease: concurrent acquire → one 409; expired lease is taken over.
- Config: a save in process A is applied in process B on `ensure_current`.
- Existing scoring / SOP / citation tests pass unmodified (handlers wrap the same functions).
