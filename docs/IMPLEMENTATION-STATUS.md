# Implementation status

Maps each SPEC feature to what's actually built, the version it shipped in, and its live-Azure
validation state. The spec of record is [`../SPEC.md`](../SPEC.md); the planning trail is in
[`planning/`](planning/); per-release detail is in [`../CHANGELOG.md`](../CHANGELOG.md). To actually
**verify** the requirements and run the system, see [`VERIFICATION.md`](VERIFICATION.md).

Status as of **v0.31.2.0**. Backend: 445 tests, 86% coverage. Frontend: 130 unit/component tests +
Playwright E2E (real Chromium). Every merge passed CI (ruff check + ruff format + pytest;
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
| **F4** Scoring engine | ✅ Done | v0.9.0.0 | 4-state per-item judgment + anti-hallucination rails (empty→not_met, forbidden→violated, invented dropped, missing→retry); weighted score + grade; cross-language. **Classification rating + 6-dim MECE + capping (v0.31.0.0, [`planning/spec-mece-classification-scoring.md`](planning/spec-mece-classification-scoring.md)):** emits a client-facing rating — *Meets Expectations (≥70) / Needs Improvement (40–69) / Does Not Meet (<40)* — on top of the numeric score (letter grade kept internally). A confirmed critical error (`forbidden` `violated`) **caps** the rating at *Needs Improvement*; an `advisory` gate (`checklist_item.advisory`) is **disclosed but exempt** from the cap (a known-but-unvalidated source conflict surfaces without hard-failing). Questions may carry a **6-dimension MECE rubric** (6 weighted `required` dims summing to 100 + shared gates) — a rubric shape only, 4-state scoring unchanged. Per-question `weight` (`question.weight`, default 1) makes the interview total a **weight-normalised mean** (fixes the prior simple average). |
| **F5** Interviewer digital human | ✅ Done | v0.4.0.0 | Persona model + admin API + Voice Live metadata builder. Agent sync **live-validated**. Per-persona Foundry IQ knowledge (v0.24.0.0, [`planning/spec-per-persona-knowledge.md`](planning/spec-per-persona-knowledge.md)). Editor Playground — inline text + voice agent test, 3-column layout, `.env` discovery fallback for model/KB dropdowns (v0.25.0.0). Unified text+voice Playground conversation + **per-persona model/version reconciliation** with the Foundry Portal (v0.26.0.0). **Instructions Portal-parity** (v0.27.0.0): the editor shows the auto-generated default instructions when the field is empty (single source of truth `default_instructions`), and reconcile-on-open pulls Portal-edited instructions back into `prompt_fragment` — equal-to-default is never pulled (empty means default). **Avatar VIDEO now streams (v0.26.0.0):** the earlier `/calls` transport limit (`avatar: null`, no ICE) was resolved by migrating voice to a backend **Voice Live WS proxy** (`voice_live_proxy.py`) that holds the SDK connection so Azure delivers the avatar ICE/SDP on the same connection; a recvonly `RTCPeerConnection` renders the live face (frame-gated, no orb flash). See [`planning/spec-voice-live-agent-contract.md`](planning/spec-voice-live-agent-contract.md) §11. |
| **F6** Turn-by-turn state machine | ✅ Done | v0.4.1.0 | Channel-agnostic `answer_finalized`; follow-up hook; answer grouping; verbal cue. |
| **F7** Session memory surfacing | ✅ Done | v0.11.0.0 | Follow-up visibly cites the candidate's prior answer; Foundry-agent knowledge binding. |
| **F8** Interview report | ✅ Done | v0.10.0.0 | Executive view (grade gauge + narrative + SOP-source-beside-answer) + progressive per-item detail. **Classification headline (v0.31.0.0):** the exec view leads with the F4 **classification rating** badge (colour-tiered) beside an outcome-aware gauge; a **cap note** shows when a critical error capped the rating, and the pending-conflict **disclosure** renders as a neutral note (not a red warning), partitioned from hard critical-error warnings by the backend's stable warning prefix (i18n zh-CN + en-US). Per-question `outcome`/`capped`/`weight` ride in the report DTO. Report stays recompute-on-demand (no persisted table). **Clickable citation source preview (v0.31.1.0, SPEC P4a):** every report SOP citation that carries a `source_document_id` renders as a link that opens the original source file in the browser. The candidate id path is threaded through the scoring spine (`ChecklistItem.source_document_id` → `RubricItem`/`ItemJudgment` → per-question DTO, plus a `source_document_name` display label) and served by `GET /candidate/interview/{id}/sop/{document_id}` behind two 404 guards — **ownership** (interview belongs to the caller) + **citation-scope IDOR** (the doc must be cited by a default-checklist item of a question this interview answered). The frontend fetches bytes with the `X-Anon-Session` header → blob object URL → new tab (a naked `<a href>` would 401 since anon auth is a header, not a cookie; the blob URL also keeps the token out of the address bar and previews PDFs inline). A deliberate, tightly-scoped relaxation of P4/P12 per owner request ("候选人直接可点开原文件"), post-scoring only. |
| **F9** Frontend interview page | ✅ Done | v0.5.0.0 | Avatar/orb, question progress, dual text+voice channel, mic recovery, WebRTC voice broker. **Live-screen polish (v0.29.0.0):** voice status legend (four states as tip cards, live one highlighted; hidden in text mode), full-width animated question-progress rail (removes the redundant top-bar badge), and the avatar stage fills the grid height with `object-fit:cover` (no letterbox). **Voice-transcript race + explicit-submit flow (v0.30.0.0, [`planning/spec-voice-transcript-race-explicit-submit.md`](planning/spec-voice-transcript-race-explicit-submit.md)):** STT transcription is async — the user transcript arrives only via `conversation.item.input_audio_transcription.completed` on a server round-trip *after* "I'm done". `commitAnswer()` now returns a `Promise<string>` that resolves **this turn's** finalized transcript (or `""` on an 8s timeout / teardown, fail-closed, never hangs), so the page submits the awaited text instead of a stale synchronous read — fixing both the report "未作答" blank and the one-off answer/question misalignment (requirements 1 & 2). A new **`review` phase** shows every question + the candidate's own finalized answer in bank order (`GET /{id}/review` + `ReviewView`); the last answer no longer auto-scores — scoring starts only on an explicit **提交并评测 / Submit & evaluate** click (requirement 4). Empty answers are rejected at three layers — frontend voice gate (`!spoken.trim()`), frontend text gate (button `disabled`), backend Pydantic 422 + defensive state-machine 409 (which also fixed a real bug: a verbal-cue message that strips to empty was silently accepted) (requirement 3). **Server-VAD empty-answer + interviewer-persona hardening (v0.30.1.0):** under production server-VAD (`azure_semantic_vad` + `create_response=True`) Azure emits `input_audio_transcription.completed` *before* the "我答完了" click, so the v0.30.0.0 arm-on-click `commitAnswer` missed it → false "我们没有听到你的回答". Fixed with a `userSegmentsSinceCommitRef` pre-click buffer that `commitAnswer` drains first (else arm-and-wait + 8s fail-closed). Separately, `default_instructions` was expanded from a one-liner into a full interviewer contract (role boundary: pose questions TO the candidate, never answer them; never self-identify as an AI/ChatGPT/OpenAI) — only affects personas with no custom `prompt_fragment`, never overriding operator content. **Voice follow-up convergence (v0.31.2.0):** the same default contract now bounds the agent's free-form voice follow-ups — at most ONE short follow-up per question, stay strictly on the system's current question (no self-initiated new questions/topic switches), and acknowledge-and-return if it drifts. Prompt/behavior bound only (scoring unchanged; see SPEC F6/F7); applies on the persona's next Foundry sync (edit+save in `/admin/agent` or reconcile-on-open), so an already-synced live agent keeps its prior instructions until re-synced. **Avatar cancel-then-speak (数字人不说话, v0.30.2.0):** with server-VAD, Azure auto-starts a response when the candidate stops talking; the app's `speakQuestion(next)` then collided with that in-flight response (`conversation_already_has_active_response`) and the rejection was never retried, so the next question showed as transcript text but was never spoken. `useInterviewVoice` now tracks in-flight state (`activeResponseRef`, set on `response.created`/cleared on `response.done`), and `speakQuestion` sends `response.cancel` + queues the verbatim text (`pendingSpeakTextRef`, latest-wins) when a response is active, flushing on the next `response.done`; a collision error re-queues the last attempt, and both `commitAnswer` nudges are guarded by `!activeResponseRef`. **Live-verified 2026-08-19** (opt-in `audio-turn2-diagnostic` against real Azure): `response.cancel`→`response.done(cancelled)`→queued question `response.created`→`switch_to_speaking`, avatar audio energy 0.037→0.393, zero collision errors; +7 vitest cases. **Admin login-gate validity fix (v0.30.3.0):** both admin surfaces (`/admin`, `/admin/agent`) gated on token *presence* (`useState(Boolean(auth.getToken()))`), so a residual/expired token flipped the page straight to "authed" — it then fired protected requests with a dead bearer (a wall of `401 Unauthorized`) while never showing a login prompt. Now both pages start in an `authChecking` state whenever a token exists, validate it via `me()` on mount (which clears the token on 401), and fall back to the login form when invalid — no protected request fires until authenticated; +2 regression vitest cases. |

## Post-demo scope (still in SPEC)

| Feature | Status | Shipped | Notes |
|---|---|---|---|
| **F2b** Question-bank admin editor | ✅ Done | v0.12.0.0 | CRUD + reorder + set-default; admin API + `/admin` UI. |
| **F3b** Checklist admin editor | ✅ Done | v0.12.0.0 | Edit items, re-normalize weights to 100; `/admin` UI. **Mandatory-checklist invariant (v0.29.0.0, [`planning/design-B-checklist-mandatory-20260818.md`](planning/design-B-checklist-mandatory-20260818.md)):** every question is auto-drafted a **non-empty** checklist at create time — SOP-optional draft (rubric drafted from the question text when no SOP passage is retrieved) with a generic-required-item fallback so scoring never degrades to a length-based stub; auto-draft is non-blocking on AI failure. The `/admin` editor now surfaces a per-question **评分标准 / Rubric** button + status marker (✓ N items / ⚙ not configured — count only, P3-safe) and a wired editable form (add/edit/delete items, change kind/weight, save → re-normalized to 100, regenerate on demand). **Admin UI refactor (v0.29.1.0):** `/admin` moved from a single vertical stack of inline-styled cards to a **two-tab workspace** (`题库与评分标准 / Content` + `Azure 连接 / Connection`) with the scoring rubric kept as an inline panel under the selected question; migrated to the project's Fluent `makeStyles`+`tokens` baseline (matching `InterviewPage`); rubric editor gains a weight-total bar (green at 100 / amber otherwise), kind-color Badges, read-only `source_quote` display (admin-only, P3-safe), and save/generate status feedback; a top-bar link cross-navigates to the `/admin/agent` persona editor. No backend or API-contract change. |

## Digital-human avatar (F5/F9)

| Capability | Status | Shipped |
|---|---|---|
| Voice-only presence (audio orb + persona voice) | ✅ Done | v0.5.0.0 |
| **Avatar video track** (digital-human face) | ✅ Done | v0.13.0.0 — broker requests the `avatar` modality; the voice hook negotiates a recvonly video transceiver and `AvatarView` shows the video, falling back to the orb. **Media-layer self-heal (v0.29.0.0):** the avatar PC recovers from an ICE `disconnected`/`failed` or ended track on its own (3s grace window, then bounded re-handshake with backoff reusing the last ICE servers) instead of falling to the orb for the rest of the session; generation-guarded against stale recoveries. |
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
- ✅ **Voice Live agent-mode signaling contract** (v0.23.1.0, 2026-08-12): brokered URL uses the
  live-verified form (`/voice-live/realtime/calls`, api-version `2026-01-01-preview`, `agent_id` +
  `agent_project_name`, `ai.azure.com`-scoped token, bare agent id). Verified with a real browser
  (Playwright fake-mic) that this clears the prior rejections ("Missing required agent project name",
  "Classic foundry agent is not supported", "Unauthorized to AI Agent service") and reaches Azure's
  agent-initialization step with an authenticated request + real SDP.

- ✅ **RBAC + audio-only offer shape** (v0.23.1.0): after granting the identity **Foundry User** on
  the project, agent-init succeeds for a synthetic audio-only SDP (verified live — advances to the
  media-allocation stage). Also verified that agent-init rejects any offer carrying a video or
  datachannel m-line, so the hook now sends an audio-only offer (no video transceiver; accepts
  Azure's `ondatachannel`) with the session config inline in `rtc.call.sdp.create`.

- ✅ **Agent voice-mode metadata** (v0.23.1.0): fixed the config-chunking bug — the agent's
  `microsoft.voice-live.configuration` was split across two metadata keys (config >512 chars) and
  Voice Live can't reassemble a split value, failing agent-init. The agent metadata now carries a
  compact single-key config (voice/turn_detection/avatar/proactive_engagement); verbose knobs apply
  at runtime via `session.update`. Live-verified: a real browser offer now clears agent-init.

- ✅ **Agent voice fully working end-to-end** (v0.23.1.0, live-verified against real Azure): the
  final fix was the signaling query-key casing — Azure agent mode needs **hyphenated**
  `agent-name` / `agent-project-name` / `agent-version` (not the underscore forms). With those, a
  standard Chromium offer (BUNDLE + datachannel + full codecs) completes
  `session.created → session.updated → rtc.call.sdp.created`. Clicking 语音作答 connects the Foundry
  agent, streams the Lisa digital-human avatar, and the agent speaks. Also required: drop
  voice/proactive/interim from the runtime `session.update` when an avatar is configured, and stop
  overriding `instructions` in `response.create`. Confirmed via Playwright fake-mic against the real
  `avarda-demo-prj` project (`sdpCreated=true`, `avatarConnected=true`, audio-transcript deltas
  streaming). Contract cross-checked with the sibling AI-Coach project's proven implementation.

- ✅ **Voice full path re-validated on the WS-proxy transport** (v0.28.1.1, 2026-08-18, against
  `ai-foundary-hu-sweden-central2`): after the v0.26 migration to the backend Voice Live WS proxy
  (`voice_live_proxy.py`), the full turn was re-verified live via the opt-in Playwright fake-mic E2E
  (`frontend/e2e/voice-live-azure.spec.ts`, `LIVE_VOICE=1`). Clicking 语音作答 opens
  `/api/voice-live/ws`; the backend brokers the Azure agent session and relays frames: the browser
  observes `proxy.connected` → `session.updated` carrying `avatar.ice_servers` →
  `response.audio_transcript.delta` streaming, with **no** `error` frame and **no** "语音不可用 /
  voice unavailable" fallback. A diagnostic probe additionally confirmed the 1080p avatar video
  renders (`1920x1080`), the KB `mcp_list_tools` tool is called, and the avatar transitions
  speaking↔idle. The spec self-skips unless `LIVE_VOICE=1`, so CI stays zero-Azure.

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
