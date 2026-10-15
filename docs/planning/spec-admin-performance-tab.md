# Spec: admin Performance tab, per-interview Operation ids

Status: APPROVED (2026-10-15). Owner answers so far: the backend managed identity gets a
Log Analytics read role; the tab's "network info" is a probe from the admin's own browser (option a);
cross-session aggregates stay in a workbook, not in the app; the Operation id is recorded on the
interview and shown in the admin Results (with Open in Performance), instead of the candidate having
to report it; the candidate's interview page shows NO Operation id.

## Context

Voice interviews are network-sensitive, and every interview is already traced end to end in
Application Insights (browser → backend → Azure, one operation per page view). Finding one
interview's trace today means guessing it by time in the workbook: nothing in the app records which
operation an interview ran in. README lines 42-44 carry three portal links, hardcoded to our tenant
and to one example operation.

## Current State (verified 2026-10-15, main @ 409ff4c)

| Concern | Today | Where |
|---|---|---|
| Browser operation id | the SDK's trace id; a NEW one per route (`enableAutoRouteTracking`) | `frontend/src/telemetry/appInsights.ts:287` |
| Voice WS → backend | `traceparent` in the WS query string, parents the `voice.session` span | `backend/app/api/voice_live_ws.py:276`, `telemetry.parent_context` |
| `/api` calls → backend | W3C `traceparent` header (SDK fetch patching) | `appInsights.ts` |
| Operation id on the interview | not stored | `backend/app/models/interview.py:41` |
| Admin Results table | candidate, started, completed, interviewer, bank, version, status, score, outcome | `frontend/src/pages/admin/InterviewsTab.tsx:104` |
| Portal links | static README links, our tenant/subscription | `README.md:42-44` |
| Backend MI roles | AcrPull, Storage Blob Data Reader (+ storage writers) | `infra/azure/modules/role-assignments.bicep`, `storage.bicep` |

One interview spans SEVERAL operations: a reload, a reconnect after a network drop, or a Restart each
open a new page view / WS with a new trace id. Those are exactly the interviews with performance
problems, so one id per interview is not enough.

## Proposed Change

```
#1 Record operation ids on the session ─> #2 Results column + per-interview links ─> #3 Performance tab
                                          (#4 MI role + link config, needed by #3's lookup links)
```

### 1. Record operation ids (backend)

- New table `interview_operations`: `interview_id` FK (cascade delete), `operation_id CHAR(32)`,
  `first_seen_at`, `last_seen_at`, `source` (`voice_ws` | `api`); unique `(interview_id, operation_id)`.
- Written when the voice WS opens (trace id parsed from its `traceparent`, same validation as
  `parent_context`) and on interview `/start`, `/answer`, `/complete` (from the request's
  `traceparent` header). Upsert = insert or bump `last_seen_at`. Best effort: a missing or malformed
  `traceparent` (telemetry off, SDK not loaded yet) writes nothing and never fails the request.
- A table, not a JSON column: a reconnect storm must not rewrite one growing row, and the Results query
  can count ids without parsing.
- Ids only. No text, same rule as the rest of the telemetry.

### 2. Results: Operation id column

- Results table gains an **Operation id** column: the most recent id (short form, 8 chars), "+N" when
  the interview had more, a copy button, and an **Open in Performance** action. The row carries no
  portal links itself (table design rule: rows stay clean); the lookup lives in one place, #3.
- Open in Performance switches to the Performance tab with the id filled into its lookup and run
  (`/admin?tab=performance&op=<id>`, so the URL is shareable between admins). For an interview with
  several ids, the lookup shows all of them (see #3).
- Admin only. The candidate history view does not show it.

### 3. Performance tab (admin)

Three cards:

- **Network check (this browser)**, on demand ("Run check"), nothing stored:
  - API round trip: 10 × `GET /api/health`, median + p95 + failures.
  - Voice WS reachability: open + close a WS to the backend proxy without starting a Voice Live
    session (needs a cheap ping path on the WS endpoint; no avatar, no Azure cost, no rate-limit hit).
  - `navigator.connection` (effective type, RTT, downlink) where the browser exposes it (Chromium only;
    shown as "not available" elsewhere).
  - Out of scope: TURN/ICE. The avatar's ICE servers come from Azure per session, so testing them means
    opening a real avatar session (rate-limited to ~3 per minute, measured). The workbook already
    reports ICE/STUN/TURN for real interviews.
- **Look up an Operation id**: paste an id, or arrive from Results (#2). Shows which interview it
  belongs to (from #1, link back to its result), that interview's other ids with times, and for the
  chosen id three links, built by the backend from config (#4), never hardcoded:
  1. **Logs**: the raw-trace query of README line 43 with this id. The `q/` segment is the query
     gzipped + base64; built in the backend with `gzip` + `base64`.
  2. **End-to-end transaction**: needs `eventId` + `timestamp`, not the operation id. The backend
     looks them up (first `AppPageViews`/`AppRequests` row of the operation, `_ItemId` +
     `TimeGenerated`) through the Logs query API with the MI, on demand per lookup. Telemetry has
     ingestion lag (~minutes): "not found yet" is a normal answer, shown as such.
  3. **Workbook**: UNVERIFIED whether a portal URL can pre-fill a workbook parameter (Microsoft
     documents parameter passing only between workbooks). Verify live during implementation; if it
     cannot, the link opens the workbook and the copy button supplies the id to paste.
  An id not recorded on any interview (e.g. an admin page view) still gets the three links.
- **Workbooks**: links to the Voice performance workbook and to a cross-session aggregates view (the
  existing workbook's cross-session sections, or a new workbook if those are not enough; the workbook is
  not part of this PR).

### 4. Infra + config

- Role: **Log Analytics Data Reader** (`3b03c2da-16b3-4a49-8834-0f8130efdd3b`, minimal: query + table
  read) for the backend MI, scoped to the Log Analytics workspace (workspace-based App Insights stores
  its data there). There is no built-in "Application Insights Reader" role.
- New env vars on the backend container app (bicep): `AZURE_TENANT_ID` (if not already present),
  `MONITOR_SUBSCRIPTION_ID`, `MONITOR_RESOURCE_GROUP`, `APP_INSIGHTS_NAME`,
  `LOG_ANALYTICS_WORKSPACE_ID` (the customer id, for the query API), `PERF_WORKBOOK_ID` (optional).
  Any missing → the links that need it are hidden, the rest still works (client deliveries run in their
  own tenant).
- Live: the full bicep re-apply is blocked (apps-module circular dependency), so the live role +
  env vars are applied with `az` once; the bicep carries them for fresh deploys. `delivery/` (gitignored)
  needs the same role in its trimmed bicep.

## Testing

- Backend: traceparent parse/upsert (valid, malformed, absent, repeat bumps `last_seen_at`), link
  building (Logs `q/` round-trips through gunzip), query client mocked in CI, REAL Logs query locally
  (owner rule: real provider locally).
- Frontend: Results column (one id, many ids, none) + Open in Performance (tab + `op` param), lookup
  card (recorded id, unrecorded id, link missing for absent config), network check with a mocked fetch.
- Live: run one interview with a reconnect on Azure, confirm two ids recorded and all three links open
  the right operation.

## Decided

- The candidate's interview page shows no Operation id (owner, 2026-10-15): #1 records every id, so
  nobody has to quote one.

## Ship

One feature PR (new table + migration + route + tab), full `/ship` flow.
