# Spec: admin Performance tab, per-interview Operation ids

Status: APPROVED (2026-10-15). Owner answers so far: the backend managed identity gets a
Log Analytics read role; the tab's "network info" is a probe from the admin's own browser (option a);
cross-session aggregates stay in a workbook, not in the app; the Operation id is recorded on the
interview and shown in the admin Results (with Open in Performance), instead of the candidate having
to report it; the candidate's interview page shows NO Operation id. Revised the same day: ONE fixed
Operation id per interview, derived from the interview id (no table, no backfill: no interview
predates it that matters).

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

Left alone, one interview spans SEVERAL operations: a reload or a route change starts a new trace id.
Those are exactly the interviews with performance problems, so the page pins one id per interview.

## Proposed Change

```
#1 Fixed operation id per interview ─> #2 Results column + Open in Performance ─> #3 Performance tab
                                       (#4 MI role + link config, needed by #3's lookup links)
```

### 1. One fixed Operation id per interview

- Operation id = the interview id without its dashes (32 hex, a valid W3C trace id).
- A fresh interview ADOPTS the page's operation id as its own id (owner, 2026-10-15): the backend
  reads the trace id from the `/start` (or `/restart`) call's `traceparent` and creates the interview
  with it, formatted as a UUID. So sign-in, `/start` and the whole interview are one operation.
  Falls back to a random UUID when there is no usable trace id (telemetry off, malformed) or the id
  is already an interview's; a collision at insert time retries with a random one.
- The interview page then pins that id as the SDK's trace id (`getTraceCtx().setTraceId`), again
  after every route change (the route tracker resets it), so reloads, reconnects and WS rebuilds stay
  in it. A voice WS opened before the SDK loads (a reload) still carries the pinned id.
- Restart: the page starts a new operation BEFORE calling `/restart`, the new interview adopts it;
  the old id stays with the abandoned interview. A failed restart re-pins the old interview.
- No table, no backfill (owner, 2026-10-15).

### 2. Results: Operation id column

- Results table gains an **Operation id** column: the id (short form, 8 chars), a copy button (full
  id) and an **Open in Performance** action. The row carries no portal links itself (table design
  rule: rows stay clean); the lookup lives in one place, #3.
- Open in Performance switches to the Performance tab with the id filled into its lookup and run
  (`/admin?tab=performance&op=<id>`, so the URL is shareable between admins).
- Admin only. The candidate history view does not show it.

### 3. Performance tab (admin)

Three cards:

- **Network check (this browser)**, on demand ("Run check"), nothing stored:
  - API round trip: 10 × `GET /api/health`, median + p95 + failures.
  - Voice WS reachability (admin only; a candidate's probe is refused): open + close a WS to the
    backend proxy without starting a Voice Live
    session (needs a cheap ping path on the WS endpoint; no avatar, no Azure cost, no rate-limit hit).
  - `navigator.connection` (effective type, RTT, downlink) where the browser exposes it (Chromium only;
    shown as "not available" elsewhere).
  - Out of scope: TURN/ICE. The avatar's ICE servers come from Azure per session, so testing them means
    opening a real avatar session (rate-limited to ~3 per minute, measured). The workbook already
    reports ICE/STUN/TURN for real interviews.
- **Look up an Operation id**: paste an id, or arrive from Results (#2). Shows which interview it
  belongs to (the id with its dashes put back, when that interview exists) and three links, built by the backend from config (#4), never hardcoded:
  1. **Logs**: the raw-trace query of README line 43 with this id. The `q/` segment is the query
     gzipped + base64; built in the backend with `gzip` + `base64`.
  2. **End-to-end transaction**: needs `eventId` + `timestamp`, not the operation id. The backend
     looks them up (first `AppPageViews`/`AppRequests` row of the operation, `_ItemId` +
     `TimeGenerated`) through the Logs query API with the MI, on demand per lookup. Telemetry has
     ingestion lag (~minutes): "not found yet" is a normal answer, shown as such.
  3. **Workbook**: UNVERIFIED whether a portal URL can pre-fill a workbook parameter (Microsoft
     documents parameter passing only between workbooks). Verify live during implementation; if it
     cannot, the link opens the workbook and the copy button supplies the id to paste.
  An id that is no interview's (e.g. an admin page view) still gets the three links.
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

- Backend: id ↔ interview mapping (valid, malformed, unknown), link building (Logs `q/` round-trips through gunzip), query client mocked in CI, REAL Logs query locally
  (owner rule: real provider locally).
- Frontend: pinning (set after the interview id is known, re-set after a route change, unchanged
  without the SDK), Results column + Open in Performance (tab + `op` param), lookup
  card (recorded id, unrecorded id, link missing for absent config), network check with a mocked fetch.
- Live: run one interview with a reload and a reconnect on Azure; confirm everything after `/start`
  is under the one id and all three links open it (incl. that the end-to-end view copes with a whole
  interview in one operation).

## Decided

- The candidate's interview page shows no Operation id (owner, 2026-10-15): #1 records every id, so
  nobody has to quote one.

## Ship

One feature PR (new admin route + tab + infra role), full `/ship` flow.

## Revision 2 (owner feedback after testing, 2026-10-15)

1. **Live network check.** Starts when the tab opens and keeps sampling while it is open and the
   page visible: API round trip every 2 s (a one-minute line chart with median and p95), voice WS
   probe every 15 s, a 512 KiB download every 30 s, a STUN Binding to Azure's relay every 60 s.
2. **The workbook once.** The per-interview workbook row is gone (the portal cannot pre-fill it, so
   it was the same generic link twice); one Workbook card says how to use it for one interview and
   across interviews.
3. **Old interviews.** An interview from before the fixed id has no telemetry under its own id; the
   lookup finds the operations it ran under through its `voice.*` events (`interview_id`) and links
   each one.
4. **Grade A to E with settings.** [`docs/network-grades.md`](../network-grades.md): per interview from
   its `voice.media` (RTT p95, audio loss mean, downlink p50; downlink graded only for a video
   avatar, owner decision) and `voice.avatar` (the UDP gate); for this browser as an estimate.
   New routes: `GET /admin/performance/operations/{id}/network`, `GET /admin/performance/download`.
