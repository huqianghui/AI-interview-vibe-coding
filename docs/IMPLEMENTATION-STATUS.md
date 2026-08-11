# Implementation status

Maps each SPEC feature to what's actually built, the version it shipped in, and its live-Azure
validation state. The spec of record is [`../SPEC.md`](../SPEC.md); the planning trail is in
[`planning/`](planning/); per-release detail is in [`../CHANGELOG.md`](../CHANGELOG.md). To actually
**verify** the requirements and run the system, see [`VERIFICATION.md`](VERIFICATION.md).

Status as of **v0.18.0.0**. Backend: 320 tests, ~87% coverage. Frontend: 29 unit/component tests +
4 Playwright E2E tests (real Chromium). Every merge passed CI (ruff check + ruff format + pytest;
tsc + vitest + eslint + Playwright E2E). Local dev / CI run entirely on mock providers — zero Azure
needed to build or test.

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

## Foundry-agent interviewer refactor (epic #26)

Porting AI-avatar-vibe-coding's Foundry-agent + avatar base and fusing the interview flow on top.
Delivered in phases; each ports **only** what this repo genuinely lacked (per-module diff).

| Phase | Status | Shipped | Notes |
|---|---|---|---|
| **Phase 1** User/admin login | ✅ Done | v0.17.0.0 | User model + JWT auth (`require_role`), admin user CRUD, login UI. Candidate anonymous path untouched. |
| **Phase 2** Azure-integration base | ✅ Done | v0.18.0.0 | Centralized `azure_auth`; Foundry IQ connection discovery + RemoteTool creation (the `connection_id` gap); agent chat via Responses API; restored + reconnected DB config layer; agent-create transient retry. |
| **Phase 3** Editor UI (Fluent v9, Foundry-portal-like) | ⏳ Next | #29 | Left nav + agent-definition center + Configuration rail + digital-human preview. Reverse-sync/metadata-only update land here (they get a consumer). |
| **Phase 4** Interview flow fusion | ⏳ Planned | #30 | Read question → show/speak → text/voice answer → state-machine decides follow-up vs next → end. |
| **Phase 5** Scoring integration | ⏳ Planned | #31 | Wire the existing scoring/report layers onto the fused flow. |

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

### Still pending live validation (needs a browser/mic or deploy config, not code)

- Full **voice WebRTC audio round-trip** in a real browser (mic in, avatar audio/video out). Code +
  credentials are in place; verified through the signaling handshake, not a live human conversation.

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
