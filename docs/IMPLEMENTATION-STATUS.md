# Implementation status

Maps each SPEC feature to what's actually built, the version it shipped in, and its live-Azure
validation state. The spec of record is [`../SPEC.md`](../SPEC.md); the planning trail is in
[`planning/`](planning/); per-release detail is in [`../CHANGELOG.md`](../CHANGELOG.md). To actually
**verify** the requirements and run the system, see [`VERIFICATION.md`](VERIFICATION.md).

Status as of **v0.21.0.0**. Backend: ~350 tests, ~88% coverage. Frontend: 48 unit/component tests +
5 Playwright E2E tests (real Chromium). Every merge passed CI (ruff check + ruff format + pytest;
tsc + vitest + eslint + Playwright E2E). Local dev / CI run entirely on mock providers — zero Azure
needed to build or test.

## Foundry-agent interviewer refactor (epic #26)

Rebuilding the interviewer as a real Azure AI Foundry prompt agent + a portal-faithful editor +
a fused text/voice interview flow, in phases (branch-per-phase, independently revertable).

| Phase | Status | Shipped | Notes |
|---|---|---|---|
| **Phase 1** User/admin login | ✅ Done | v0.17.0.0 | JWT auth (`require_role`), admin user CRUD, login UI. |
| **Phase 2** Azure-integration base | ✅ Done | v0.18.0.0 | Centralized `azure_auth`; Foundry IQ connection discovery + RemoteTool creation; agent chat via Responses API; restored DB config; agent-create retry. |
| **Phase 3** Foundry Agent editor UI | ✅ Done | v0.19.0.0 | `/admin/agent` — Fluent v9 editor: persona nav + agent-definition + config drawer + avatar grid + preview. |
| **Phase 4** Fuse the interview flow | ✅ Done | v0.20.0.0 | Audit confirmed F6/F7/F9 flow built; added: interview resume after reload (GET endpoint + client persistence), voice speaks the backend-authoritative question (not agent-autonomous), multi-segment voice content-loss fix, empty-bank terminal state, voice-off mid-interview continuation. |
| **Phase 5** Scoring/report to real Foundry | ✅ Done | v0.21.0.0 | Real Foundry LLM scoring adapter (Responses API, registered `azure`, flipped on by the config overlay) so a saved config scores against a real model; checklist-draft SOP citations gated (`shape_citations` on quote/page) so no half-attributed quote ships. Voice/pronunciation scoring + true citation-grounding deferred to follow-ups. |

## Core features (F1–F9)

| Feature | Status | Shipped | Notes |
|---|---|---|---|
| **F1** Knowledge base + traceability | ✅ Done | v0.6.0.0 | SOP upload → segment-aware extract → chunk with page/section labels → pluggable blob store; retrieval reuses the live-validated strict citation gate. |
| **F2** Question bank | ✅ Done | v0.7.0.0 | DB-backed banks + questions, one-enabled-default, 10-question seed on boot, candidate read API (no rubric leak, P3). |
| **F3** Checklist (rubric) | ✅ Done | v0.8.0.0 | AI-drafted required/recommended/forbidden items with SOP source quotes; weights normalized to 100. |
| **F4** Scoring engine | ✅ Done | v0.9.0.0 | 4-state per-item judgment + anti-hallucination rails (empty→not_met, forbidden→violated, invented dropped, missing→retry); weighted score + grade; cross-language. |
| **F5** Interviewer digital human | ✅ Done | v0.4.0.0 | Persona model + admin API + Voice Live metadata builder. Agent sync **live-validated** (see below). |
| **F6** Turn-by-turn state machine | ✅ Done | v0.4.1.0 | Channel-agnostic `answer_finalized`; follow-up hook; answer grouping; verbal cue. |
| **F7** Session memory surfacing | ✅ Done | v0.11.0.0 | Follow-up visibly cites the candidate's prior answer; Foundry-agent knowledge binding. |
| **F8** Interview report | ✅ Done | v0.10.0.0 | Executive view (grade gauge + narrative + SOP-source-beside-answer) + progressive per-item detail. |
| **F9** Frontend interview page | ✅ Done | v0.5.0.0 | Avatar/orb, question progress, dual text+voice channel, mic recovery, WebRTC voice broker. |

## Post-demo scope (still in SPEC)

| Feature | Status | Shipped | Notes |
|---|---|---|---|
| **F2b** Question-bank admin editor | ✅ Done | v0.12.0.0 | CRUD + reorder + set-default; admin API + `/admin` UI. |
| **F3b** Checklist admin editor | ✅ Done | v0.12.0.0 | Edit items, re-normalize weights to 100; `/admin` UI. |

## Digital-human avatar (F5/F9)

| Capability | Status | Shipped |
|---|---|---|
| Voice-only presence (audio orb + persona voice) | ✅ Done | v0.5.0.0 |
| **Avatar video track** (digital-human face) | ✅ Done | v0.13.0.0 — broker requests the `avatar` modality; the voice hook negotiates a recvonly video transceiver and `AvatarView` shows the video, falling back to the orb. |
| **Foundry-portal avatar editor** (real-face roster + layout parity) | ✅ Done | v0.22.0.0 — `/admin/agent` matches the AI Foundry portal Playground: full Azure roster (6 video + 27 photo) with real MS-Learn-CDN face thumbnails, top-bar persona switcher + left definition sections + center `AvatarPreview`, style slugs use Azure real names (`casual-sitting`), passed through to Voice Live. |
| **Foundry-portal agent Tools** (per-persona, real sync) | ✅ Done | v0.23.0.0 — Tools section + "Select a tool" dialog (Configured/Catalog/Custom) matching the portal. `code_interpreter` / `web_search` / public `mcp` really sync into the persona's Foundry agent (`tools_config` → gated → SDK tools); the rest are Preview cards. Connection-auth tools (OpenAPI/A2A/protected MCP/Bing/Search) + MS-hosted connectors deferred. |

## End-to-end tests (v0.14.0.0)

Real-browser Playwright coverage of the winning-demo path, on top of the unit/component tests.
Both servers (backend + frontend) boot as managed web servers against a fresh migrated SQLite DB
and mock providers, so the full candidate + admin flows run in an actual Chromium with **zero
Azure**. Run locally with `cd frontend && npm run e2e`; CI runs it on every PR (the `e2e` job).

| E2E spec | Covers | Asserts |
|---|---|---|
| Candidate text interview | F6/F7/F8/F9 | land → orientation → answer → **F7 follow-up quoting the candidate's own words** → report reveal. |
| P3 boundary | P3 | candidate page never exposes `checklist` / `rubric` / `expected_points` / `weight` / `source_quote`. |
| Admin authors bank + checklist → scored report | F2b/F3b/F3/F4/F8 | admin sign-in → default bank → question → **checklist draft (weights = 100)** → candidate reaches a **scored** exec report (grade gauge + SOP-source-beside-answer evidence) + per-item detail. |
| Voice with no mic | F9 AC#4 | voice channel with no microphone surfaces the mic-permission / voice-unavailable notice — never hangs. |

## Live-Azure validation (against `avarda-demo-prj`, 2026-08-09)

The SPEC P15/P16 exit criteria — "the agent↔knowledge-source connection is a distinct dependency
that an automatable check can pass while the live service rejects." Validated live, not just in CI:

- ✅ Interviewer agent **create → read → delete** against the real Foundry project (project-scoped
  endpoint `…/api/projects/{project}`; the bare account endpoint 404s — fixed v0.11.2.0).
- ✅ SOP knowledge base bound as an **MCPTool** (not `azure_ai_search`) — the persisted agent
  definition carries `{type:mcp, server_url:…/knowledgebases/{index}/mcp, allowed_tools:
  {tool_names:[knowledge_base_retrieve]}, require_approval:never, project_connection_id:<RemoteTool>}`
  (fixed to the live-verified MCP contract in v0.11.1.0).
- ✅ **Real retrieval turn**: a question through the KB-bound agent returned a grounded answer
  citing SOP content (`【n:n†source】`), with output items `mcp_list_tools → mcp_call → message`.
- ✅ Voice Live credential chain (Entra bearer) to the signaling WebSocket handshake.
- ✅ **Agent-mode Voice Live session init** (v0.23.1.0, 2026-08-12): live-verified that the brokered
  signaling URL (`/voice-live/realtime/calls`, api-version `2026-01-01-preview`, `agent_id` +
  `agent_project_name`) makes Azure initialize the real `avarda-demo-agent` — the WS reaches the SDP
  negotiation stage (only a hand-written fake SDP fails; a real browser offer completes). This fixed
  the "Voice unavailable" fallback: the prior contract (`/voice-live/realtime`, `2026-07-15`,
  `agent_name`/`project_name`) was rejected by Azure ("Missing required agent project name", then
  "Classic foundry agent is not supported in API version 2026-04-10 and above").

### Still pending live validation (needs a browser/mic, not code)

- Full **voice WebRTC audio round-trip** with a real human (mic in, avatar audio/video out). The
  signaling + agent-init are verified against real Azure; the remaining unverified leg is a live
  RTCPeerConnection from a real browser with a microphone through to spoken audio + avatar video.

### Deploy configuration (v0.15.0.0)

Runtime config precedence is **DB > .env > code default**:

- **DB-backed config (source of truth)** — the AI Foundry endpoint / API key / project / model are
  set in the `/admin` **Azure config** panel and saved to the `service_configs` master row (key
  Fernet-encrypted). They're overlaid onto settings at startup and after each save, so production
  reads the operator's saved config without touching `.env` and without a restart. Set
  `ENCRYPTION_KEY` in prod so the stored key survives restarts.
- **`.env` (dev fallback)** — fills gaps when no DB row exists. `backend/.env.example` (committed,
  secret-free) documents every knob. Copy to `backend/.env` (gitignored) and fill in real values.
  Leaving the providers as `mock` needs zero Azure.
- **Model deployments (gotcha)** — the model MUST be a deployment that exists on the target resource.
  `gpt-4o` (the neutral code default) is NOT deployed on the demo resource and 404s on agent-create /
  Voice Live; deployed there: `gpt-5.4-mini`, `gpt-4o-mini`, `gpt-5.4`, `gpt-5`. Set a deployed model
  in the config page (or `FOUNDRY_AGENT_MODEL` / `VOICE_LIVE_DEFAULT_MODEL` in `.env`).
