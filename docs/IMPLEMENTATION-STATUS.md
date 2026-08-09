# Implementation status

Maps each SPEC feature to what's actually built, the version it shipped in, and its live-Azure
validation state. The spec of record is [`../SPEC.md`](../SPEC.md); the planning trail is in
[`planning/`](planning/); per-release detail is in [`../CHANGELOG.md`](../CHANGELOG.md).

Status as of **v0.13.0.0**. Backend: 230 tests, ~91% coverage. Frontend: 21 tests. Every merge
passed CI (ruff check + ruff format + pytest; tsc + vitest + eslint). Local dev / CI run entirely
on mock providers — zero Azure needed to build or test.

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
- **Deploy note:** `FOUNDRY_AGENT_MODEL` / `VOICE_LIVE_DEFAULT_MODEL` default to `gpt-4o`, which is
  NOT deployed on the demo resource. Set them to a deployed model (e.g. `gpt-5.4-mini`,
  `gpt-4o-mini`) for a real run.
