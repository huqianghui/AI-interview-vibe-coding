# Implementation status

Maps each SPEC feature to what's actually built, the version it shipped in, and its live-Azure
validation state. The spec of record is [`../SPEC.md`](../SPEC.md); the planning trail is in
[`planning/`](planning/); per-release detail is in [`../CHANGELOG.md`](../CHANGELOG.md). To actually
**verify** the requirements and run the system, see [`VERIFICATION.md`](VERIFICATION.md).

Status as of **v0.34.0.0**. Backend: 464 tests, 86% coverage. Frontend: 138 unit/component tests +
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
| **F2** Question bank | ✅ Done | v0.7.0.0 | DB-backed banks + questions, one-enabled-default, 10-question seed on boot, candidate read API (no rubric leak, P3). **Multi-bank catalogue matches local (v0.36.0.4, PR #74):** `seed_bundled_banks` imports the committed generic bundles (`app/seeds/banks/*.json` — Demo / Deployment SOP / test), and `seed_client_banks` imports client-derived bundles from `CLIENT_BANKS_DIR` (default `/app/_client_bundle/extra_banks/*.json`) — both non-default so the boot importer's rf-CSM bank keeps the enabled-default slot; idempotent by name. The client `rf-CSM GCO Inspection Interview-demo01` bank (carries SOP `source_quote`s → never committed) rides in the private `rfcsm-bundle.zip` under `extra_banks/`. **Live-validated (2026-09-01):** after rebuilding the private bundle to include `extra_banks/rfcsm-demo01.bank.json` and re-uploading it to the `client-bundle` blob, a forced backend restart re-seeds all **5 banks** (4 boot-channel + demo01) with no manual step — server catalogue now equals local across restarts. |
| **F3** Checklist (rubric) | ✅ Done | v0.8.0.0 | AI-drafted required/recommended/forbidden items with SOP source quotes; weights normalized to 100. |
| **F4** Scoring engine | ✅ Done | v0.9.0.0 | 4-state per-item judgment + anti-hallucination rails (empty→not_met, forbidden→violated, invented dropped, missing→retry); weighted score + grade; cross-language. **Classification rating + 6-dim MECE + capping (v0.31.0.0, [`planning/spec-mece-classification-scoring.md`](planning/spec-mece-classification-scoring.md)):** emits a client-facing rating — *Meets Expectations (≥70) / Needs Improvement (40–69) / Does Not Meet (<40)* — on top of the numeric score (letter grade kept internally). A confirmed critical error (`forbidden` `violated`) **caps** the rating at *Needs Improvement*; an `advisory` gate (`checklist_item.advisory`) is **disclosed but exempt** from the cap (a known-but-unvalidated source conflict surfaces without hard-failing). Questions may carry a **6-dimension MECE rubric** (6 weighted `required` dims summing to 100 + shared gates) — a rubric shape only, 4-state scoring unchanged. Per-question `weight` (`question.weight`, default 1) makes the interview total a **weight-normalised mean** (fixes the prior simple average). |
| **F5** Interviewer digital human | ✅ Done | v0.4.0.0 | Persona model + admin API + Voice Live metadata builder. Agent sync **live-validated**. Per-persona Foundry IQ knowledge (v0.24.0.0, [`planning/spec-per-persona-knowledge.md`](planning/spec-per-persona-knowledge.md)). Editor Playground — inline text + voice agent test, 3-column layout, `.env` discovery fallback for model/KB dropdowns (v0.25.0.0). Unified text+voice Playground conversation + **per-persona model/version reconciliation** with the Foundry Portal (v0.26.0.0). **Instructions Portal-parity** (v0.27.0.0): the editor shows the auto-generated default instructions when the field is empty (single source of truth `default_instructions`), and reconcile-on-open pulls Portal-edited instructions back into `prompt_fragment` — equal-to-default is never pulled (empty means default). **Avatar VIDEO now streams (v0.26.0.0):** the earlier `/calls` transport limit (`avatar: null`, no ICE) was resolved by migrating voice to a backend **Voice Live WS proxy** (`voice_live_proxy.py`) that holds the SDK connection so Azure delivers the avatar ICE/SDP on the same connection; a recvonly `RTCPeerConnection` renders the live face (frame-gated, no orb flash). See [`planning/spec-voice-live-agent-contract.md`](planning/spec-voice-live-agent-contract.md) §11. **Boot-seeded default persona (v0.34.0.0):** the ephemeral-SQLite public demo reseeds every boot, so `persona_seed.py` recreates the enabled default "Interviewer" (generic multilingual contract; **fixed persona id** = the operator's local id so the boot sync is a create-or-update against the *same* `interviewer-<id>` Foundry agent, never a fresh orphan per reboot; `model=None` → deployment's `FOUNDRY_AGENT_MODEL`). Best-effort seed in the lifespan (never blocks boot) + background Foundry sync (voice P5 gate needs `synced`; failure degrades to text-only). The editor auto-selects the enabled default on entry. See [`planning/spec-default-persona-boot-seed.md`](planning/spec-default-persona-boot-seed.md). **Editor "Language" selector now persists (v0.35.0.1):** the selector was backed by ephemeral React `activeLocale` state (not any persisted field), so it snapped back to the hardcoded `zh-CN` default on every reload even after Save. Added a persisted scalar `default_locale` on the persona (migration `c3d4e5f6a7b8`, `server_default="zh-CN"` backfills existing rows) threaded through all four layers (ORM → Pydantic create/update/out → TS `PersonaOut` → form mapper), and made `form.defaultLocale` the single source of truth for the selector. Reconcile-on-open is unaffected (it never touches `default_locale`/voice/greeting maps). A four-layer field-parity audit confirmed no other config field had the same saved-but-not-restored defect. **App-wide default language flipped to English (v0.36.0.0):** every "default language" that fell back to `zh-CN` now defaults to `en-US` across four layers — persona editor selector + `default_locale` column (B), auto-seeded default persona `_VOICE_MAP`/`_GREETING_MAP`/`default_locale` (C), new user `preferred_language` (D), and question-bank/question/session language incl. `seed_default_bank`/`create_bank`/`add_question`/admin schemas/bundle-import fallback (E); also `voice_live_metadata.FALLBACK_LOCALE` and `build_follow_up_prompt`'s default. Corrects the pre-existing demo-bank content/tag mismatch (English questions were tagged `zh-CN`). **Includes existing stored data:** migration `d4e5f6a7b8c9` moves the persona `default_locale` `server_default` to `en-US` (SQLite batch mode) and backfills persona/user/bank/question rows still `= 'zh-CN'` → `en-US` (a deliberately-set non-Chinese locale is preserved). `zh-CN` stays fully supported; only the default moved. |
| **F6** Turn-by-turn state machine | ✅ Done | v0.4.1.0 | Channel-agnostic `answer_finalized`; follow-up hook; answer grouping; verbal cue. |
| **F7** Session memory surfacing | ✅ Done | v0.11.0.0 | Follow-up visibly cites the candidate's prior answer; Foundry-agent knowledge binding. |
| **F8** Interview report | ✅ Done | v0.10.0.0 | Executive view (grade gauge + narrative + SOP-source-beside-answer) + progressive per-item detail. **Classification headline (v0.31.0.0):** the exec view leads with the F4 **classification rating** badge (colour-tiered) beside an outcome-aware gauge; a **cap note** shows when a critical error capped the rating, and the pending-conflict **disclosure** renders as a neutral note (not a red warning), partitioned from hard critical-error warnings by the backend's stable warning prefix (i18n zh-CN + en-US). Per-question `outcome`/`capped`/`weight` ride in the report DTO. Report stays recompute-on-demand (no persisted table). **Clickable citation source preview (v0.31.1.0, SPEC P4a):** every report SOP citation that carries a `source_document_id` renders as a link that opens the original source file in the browser. The candidate id path is threaded through the scoring spine (`ChecklistItem.source_document_id` → `RubricItem`/`ItemJudgment` → per-question DTO, plus a `source_document_name` display label) and served by `GET /candidate/interview/{id}/sop/{document_id}` behind two 404 guards — **ownership** (interview belongs to the caller) + **citation-scope IDOR** (the doc must be cited by a default-checklist item of a question this interview answered). The frontend fetches bytes with the `X-Anon-Session` header → blob object URL → new tab (a naked `<a href>` would 401 since anon auth is a header, not a cookie; the blob URL also keeps the token out of the address bar and previews PDFs inline). A deliberate, tightly-scoped relaxation of P4/P12 per owner request ("候选人直接可点开原文件"), post-scoring only. |
| **F9** Frontend interview page | ✅ Done | v0.5.0.0 | Avatar/orb, question progress, dual text+voice channel, mic recovery, WebRTC voice broker. **Live-screen polish (v0.29.0.0):** voice status legend (four states as tip cards, live one highlighted; hidden in text mode), full-width animated question-progress rail (removes the redundant top-bar badge), and the avatar stage fills the grid height with `object-fit:cover` (no letterbox). **Voice-transcript race + explicit-submit flow (v0.30.0.0, [`planning/spec-voice-transcript-race-explicit-submit.md`](planning/spec-voice-transcript-race-explicit-submit.md)):** STT transcription is async — the user transcript arrives only via `conversation.item.input_audio_transcription.completed` on a server round-trip *after* "I'm done". `commitAnswer()` now returns a `Promise<string>` that resolves **this turn's** finalized transcript (or `""` on an 8s timeout / teardown, fail-closed, never hangs), so the page submits the awaited text instead of a stale synchronous read — fixing both the report "未作答" blank and the one-off answer/question misalignment (requirements 1 & 2). A new **`review` phase** shows every question + the candidate's own finalized answer in bank order (`GET /{id}/review` + `ReviewView`); the last answer no longer auto-scores — scoring starts only on an explicit **提交并评测 / Submit & evaluate** click (requirement 4). Empty answers are rejected at three layers — frontend voice gate (`!spoken.trim()`), frontend text gate (button `disabled`), backend Pydantic 422 + defensive state-machine 409 (which also fixed a real bug: a verbal-cue message that strips to empty was silently accepted) (requirement 3). **Server-VAD empty-answer + interviewer-persona hardening (v0.30.1.0):** under production server-VAD (`azure_semantic_vad` + `create_response=True`) Azure emits `input_audio_transcription.completed` *before* the "我答完了" click, so the v0.30.0.0 arm-on-click `commitAnswer` missed it → false "我们没有听到你的回答". Fixed with a `userSegmentsSinceCommitRef` pre-click buffer that `commitAnswer` drains first (else arm-and-wait + 8s fail-closed). Separately, `default_instructions` was expanded from a one-liner into a full interviewer contract (role boundary: pose questions TO the candidate, never answer them; never self-identify as an AI/ChatGPT/OpenAI) — only affects personas with no custom `prompt_fragment`, never overriding operator content. **Voice follow-up convergence (v0.31.2.0):** the same default contract now bounds the agent's free-form voice follow-ups — at most ONE short follow-up per question, stay strictly on the system's current question (no self-initiated new questions/topic switches), and acknowledge-and-return if it drifts. Prompt/behavior bound only (scoring unchanged; see SPEC F6/F7); applies on the persona's next Foundry sync (edit+save in `/admin/agent` or reconcile-on-open), so an already-synced live agent keeps its prior instructions until re-synced. **Avatar cancel-then-speak (数字人不说话, v0.30.2.0):** with server-VAD, Azure auto-starts a response when the candidate stops talking; the app's `speakQuestion(next)` then collided with that in-flight response (`conversation_already_has_active_response`) and the rejection was never retried, so the next question showed as transcript text but was never spoken. `useInterviewVoice` now tracks in-flight state (`activeResponseRef`, set on `response.created`/cleared on `response.done`), and `speakQuestion` sends `response.cancel` + queues the verbatim text (`pendingSpeakTextRef`, latest-wins) when a response is active, flushing on the next `response.done`; a collision error re-queues the last attempt, and both `commitAnswer` nudges are guarded by `!activeResponseRef`. **Live-verified 2026-08-19** (opt-in `audio-turn2-diagnostic` against real Azure): `response.cancel`→`response.done(cancelled)`→queued question `response.created`→`switch_to_speaking`, avatar audio energy 0.037→0.393, zero collision errors; +7 vitest cases. **Admin login-gate validity fix (v0.30.3.0):** both admin surfaces (`/admin`, `/admin/agent`) gated on token *presence* (`useState(Boolean(auth.getToken()))`), so a residual/expired token flipped the page straight to "authed" — it then fired protected requests with a dead bearer (a wall of `401 Unauthorized`) while never showing a login prompt. Now both pages start in an `authChecking` state whenever a token exists, validate it via `me()` on mount (which clears the token on 401), and fall back to the login form when invalid — no protected request fires until authenticated; +2 regression vitest cases. |

## Post-demo scope (still in SPEC)

| Feature | Status | Shipped | Notes |
|---|---|---|---|
| **F2b** Question-bank admin editor | ✅ Done | v0.12.0.0 | CRUD + reorder + set-default; admin API + `/admin` UI. |
| **F3b** Checklist admin editor | ✅ Done | v0.12.0.0 | Edit items, re-normalize weights to 100; `/admin` UI. **Mandatory-checklist invariant (v0.29.0.0, [`planning/design-B-checklist-mandatory-20260818.md`](planning/design-B-checklist-mandatory-20260818.md)):** every question is auto-drafted a **non-empty** checklist at create time — SOP-optional draft (rubric drafted from the question text when no SOP passage is retrieved) with a generic-required-item fallback so scoring never degrades to a length-based stub; auto-draft is non-blocking on AI failure. The `/admin` editor now surfaces a per-question **评分标准 / Rubric** button + status marker (✓ N items / ⚙ not configured — count only, P3-safe) and a wired editable form (add/edit/delete items, change kind/weight, save → re-normalized to 100, regenerate on demand). **Admin UI refactor (v0.29.1.0):** `/admin` moved from a single vertical stack of inline-styled cards to a **two-tab workspace** (`题库与评分标准 / Content` + `Azure 连接 / Connection`) with the scoring rubric kept as an inline panel under the selected question; migrated to the project's Fluent `makeStyles`+`tokens` baseline (matching `InterviewPage`); rubric editor gains a weight-total bar (green at 100 / amber otherwise), kind-color Badges, read-only `source_quote` display (admin-only, P3-safe), and save/generate status feedback; a top-bar link cross-navigates to the `/admin/agent` persona editor. No backend or API-contract change. |

## External interview brain (Phase 2, [`planning/design-external-interview-brain-integration.md`](planning/design-external-interview-brain-integration.md))

A second, per-persona interview mode that hands every turn to the client's **external interview
API/server** instead of the built-in bank — vendor-neutral (`interview_brain = "bank" | "external"`,
never a product name). Approach B: a parallel `external_runner` + `external_interview_client`
beside the untouched bank `state_machine`; the backend acts as the API client, snapshotting
`brain_mode` onto the session at start. The external state blob never reaches the browser or any
LLM (SPEC P3/P12), and external scoring is owned by that server — the candidate sees a completion
acknowledgement, never a local report.

| Slice | Status | Shipped | Notes |
|---|---|---|---|
| **Backend runner + client + config** | ✅ Built (branch `feat/external-interview-brain-backend`, pending `/ship`) | — | `external_runner` (synchronous `answer` → next-Q `idle` / resumable `recovery_required` / `completed`; `recover` re-drives the committed state idempotently), `external_interview_client` (http + deterministic in-process mock providers; empty endpoint → mock), and `external_config_service` (separate `service_configs` row; Fernet-encrypted key; https + SSRF-guarded endpoint; DB-over-`.env` live resolution). Admin config router (`/admin/external-interviewer`: save / masked-GET / explicit reveal / no-row-creating test-probe). `interview_brain` threaded through persona ORM/schemas/API. Config + runner + privacy invariants under pytest. |
| **Frontend UI + i18n** | ✅ Built (same branch) | — | Persona editor **Interview brain** selector (`bank` / `external`); admin **External interview API** config card (endpoint / user-tag / write-only key + reveal + test-connection) on the Connection tab; `InterviewPage` external phases — awaiting ("interviewer thinking") overlay driven by the in-flight turn, resumable-recovery affordance, mic auto-pause during awaiting/stalled, `speech_text` TTS wiring, hidden question-progress (external exposes no count), and a dedicated completion acknowledgement card (no local report — P12). Candidate-facing copy bilingual (zh-CN + en-US `external` block); operator surfaces stay English. |
| **Playwright E2E** | ✅ Built (same branch) | — | `external-config.spec.ts` (admin saves/reveals/probes the external-API config, then resets the endpoint) + `external-interview.spec.ts` (external-brain default persona → mock-driven 3-question run → completion acknowledgement; asserts P12 no-local-report + P3 no-rubric-leak). Both green on mock providers. |

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

### Azure CI/CD deployment (v0.33.0.0)

Full deploy pipeline to **Azure Container Apps** in **Sweden Central** (co-located with the reused
Foundry resource). Plan: [`planning/spec-azure-cicd-deploy.md`](planning/spec-azure-cicd-deploy.md);
one-time setup + IaC: [`../infra/azure/README.md`](../infra/azure/README.md).

- **Compute** — backend + frontend Container Apps, **single replica each** (`min=max=1`): ephemeral
  SQLite is per-replica, and Voice Live WS affinity stays trivial. Frontend nginx serves the SPA and
  reverse-proxies `/api` (incl. the `/api/voice-live/ws` upgrade) to the backend same-origin (no
  CORS). Backend containerized `python:3.11-slim`, `pip install -e ".[azure]"`.
- **Auth = managed identity, keyless** — a user-assigned MI runs both apps; `AZURE_CLIENT_ID` selects
  it for `DefaultAzureCredential` (backend `azure_auth.py` is already Entra-first). Granted AcrPull +
  Storage Blob Data Reader by Bicep; **Cognitive Services User + Azure AI
  Developer on the EXISTING Foundry account** by `infra/azure/scripts/grant-foundry-rbac.sh` (cross-RG,
  out of Bicep scope). GitHub Actions deploys via **OIDC federated identity** (no stored cloud creds).
- **Data = ephemeral SQLite, reseeded every boot** (no DB PaaS). `backend/entrypoint.sh`:
  `alembic upgrade head` → (if `CLIENT_BUNDLE_BLOB` set) fetch the private client bundle from the
  `client-bundle` blob via MI + run the importer → `exec uvicorn`, whose lifespan idempotently seeds
  the generic demo bank + admin. This **replaces the reference's separate bootstrap Job** (a Job's
  disk can't seed the app replica's own SQLite).
- **Client-content security preserved** — the gitignored importer + source docs never enter the
  public repo or the CI image (enforced by `backend/.dockerignore`); they are designed to arrive only
  through the private `client-bundle` blob uploaded once out-of-band. `CLIENT_BUNDLE_BLOB` unset →
  public-demo mode (generic bank only). Secrets (`SECRET_KEY`/`ENCRYPTION_KEY`/`SEED_ADMIN_PASSWORD`/
  `ADMIN_API_TOKEN`) are **Container App native secrets** (encrypted at rest by the platform),
  passed as `@secure()` Bicep params from the gitignored `main.parameters.json`, never in the repo.
- **IaC** — subscription-scope `infra/azure/main.bicep` creates the RG + Log Analytics/App Insights,
  MI, Basic ACR, keyless Storage (private `client-bundle` + `materials`), Container
  Apps env + both apps, GitHub OIDC identity, and role assignments.
  **No AI-resource creation** (Foundry/Voice Live reused). Workflows:
  [`.github/workflows/infra-main.yml`](../.github/workflows/infra-main.yml)
  (`az bicep build` + `bash -n`) and [`.github/workflows/deploy-app.yml`](../.github/workflows/deploy-app.yml)
  (OIDC login → `az acr build` both images → `az containerapp update` → health check). Single
  `public` env profile in `infra/azure/environments/public.json`.
- **Validation state** — Bicep compiles clean (`az bicep build`, no warnings); shell scripts pass
  `bash -n`; `fetch_client_bundle.py` passes ruff check + format. **Live infra provisioned on Azure
  (Sweden Central, 2026-08-26):** `az deployment sub create` succeeded (RG
  `rg-aiinterview-public-swedencentral`); backend MI granted Foundry RBAC; deploy profile backfilled.
  App images are built + rolled out by `deploy-app.yml`. Originally shipped in **public-demo mode**
  (real rf-CSM bank deferred — the Storage public-access policy blocked the boot-time bundle fetch);
  the follow-up below adds the Storage private endpoint + VNet-integrated env that revives it.

### Boot-time client-bank seeding via VNet + Storage private endpoint

**The durable fix** for the ephemeral-SQLite reseed problem: put the Container Apps managed
environment inside a **VNet** and give the storage account a **blob private endpoint** +
`privatelink.blob.core.windows.net` private DNS zone, so the backend MI reaches the private
`client-bundle` blob at boot. This **revives the existing `entrypoint.sh` fetch→import channel** with
**zero app/Python change** — the same `<account>.blob.core.windows.net` hostname now resolves to the
endpoint's private IP from inside the env. Result: the real rf-CSM bank + rubric + SOP docs seed
**automatically on every boot/restart/redeploy**, no manual step.

- **IaC** — new `infra/azure/modules/network.bicep` (VNet `10.10.0.0/16`; infra subnet `/23`
  delegated to `Microsoft.App/environments`; PE subnet `/27`; private DNS zone + vnet link; blob
  private endpoint + DNS zone group). `container-apps.bicep` adds `vnetConfiguration`
  (`infrastructureSubnetId`, `internal: false` — external ingress preserved, private egress to
  storage). `storage.bicep` sets `networkAcls.defaultAction: Deny` + exports `storageAccountId`.
- **Applying to an existing VNet-less env is a ONE-TIME delete + recreate** (the env's
  `vnetConfiguration` is immutable), which reassigns both apps' FQDNs — brief outage; no tracked file
  hard-codes the FQDN. Infra is **not** applied by CI (`deploy-app.yml` only updates images); apply
  manually via `az deployment sub create`. Full runbook (incl. the Cloud-Shell-in-VNet bundle
  upload): [`../infra/azure/README.md`](../infra/azure/README.md) step 4.
- **Idempotent thereafter** — once the VNet-integrated env exists, every later infra apply is a
  no-op on the network resources. The image params (`backendImage`/`frontendImage`) default to
  **empty = preserve the running image**, so an infra re-apply never clobbers the tag that
  `deploy-app.yml` deployed back to a placeholder (`container-apps.bicep` reads the live app via an
  `existing` reference; placeholder is used only on first-create/recreate when no app exists). This
  decouples the two pipelines: infra owns topology, `deploy-app.yml` owns images. `clientBundleBlob`
  is likewise a template param that survives re-apply.
- **Validation state** — Bicep compiles clean (`az bicep build`, no warnings); `--what-if` against
  the live env confirms the network resources are net-new Creates and the image is a preserve no-op
  (no placeholder flip). ✅ **Applied + live-validated on Azure (Sweden Central, 2026-08-31):** the
  VNet-integrated env + blob private endpoint + `privatelink.blob.core.windows.net` zone are live in
  `rg-aiinterview-public-swedencentral`; the private DNS resolves `aiinterviewpublicst.blob.core.windows.net`
  to the PE private IP (`10.10.2.4`, verified from inside the VNet). The client bundle
  (`rfcsm-bundle.zip`) was uploaded once to the private `client-bundle` container **from inside the
  VNet via a temporary jumpbox VM** (the only path past the policy-locked storage — an IP-allowlist
  upload is overridden by the Modify policy; the jumpbox + all `jump-*` resources were torn down after
  the upload), and `CLIENT_BUNDLE_BLOB=rfcsm-bundle.zip` set on the backend (persisted in
  `main.parameters.json` so it survives re-apply). **Durability proven across a forced restart:** the
  boot logs show `fetching private client interview bundle → extracted bundle → running rf-CSM bank
  importer` with **no** `client bundle fetch failed` WARNING, and a fresh ephemeral DB (untouched by
  the PR #66 manual sync) serves the rf-CSM default bank (9 questions, 108 rubric items) with non-zero
  report coverage. Boot-time auto-seeding is now the norm; the admin-API sync below is the fallback.
  **Extended to the full multi-bank catalogue (2026-09-01):** the private bundle was rebuilt to add
  `extra_banks/rfcsm-demo01.bank.json` (the client self-test bank `rf-CSM GCO Inspection Interview-demo01`),
  which `seed_client_banks` imports on boot (PR #74). The rebuilt `rfcsm-bundle.zip` was re-uploaded to
  the private `client-bundle` blob **from inside the VNet** — the standard jumpbox path is blocked by an
  ARM cross-RP reference-resolution bug on referencing the existing `vnet-aiinterview-public` subnets, so
  the working path is an **isolated CLI-created vnet + VNet peering + `privatelink.blob` DNS vnet-link +
  `az vm run-command`** (control plane, no SSH/NSG) using an IMDS-token blob REST PUT. A forced restart
  then re-seeds **all 5 banks** (4 boot-channel + demo01) with no manual step. All temporary upload
  resources were torn down and the backend MI reverted to **read-only** (`Storage Blob Data Reader` — boot
  only downloads); the deleted VM MI's grant was revoked.

### Bank + rubric sync to the deployed server (admin-API channel)

**Now the fallback** (superseded by boot-time auto-seeding above, live since 2026-08-31). Kept as a
recovery path: if a boot-time bundle fetch ever fails (bundle-content or DNS issue) the server would
reseed only the generic **demo bank** (no checklists) — so its questions would differ from local
**and** the report would show **coverage 0 / no final result** (length-stub scoring with no rubric to
score against). The fix is an **admin-API bank-bundle sync** that makes the server identical to
local: `GET /admin/question-banks/{id}/export` + `POST /admin/question-banks/import`
move a bank + its ordered questions + each question's **full rubric verbatim** (item weights,
`advisory` gates, SOP citations resolved **by document name** — unlike `PUT .../checklists/{id}/items`,
which drops `advisory` + source id). Local push script: `backend/scripts/sync_bank_to_server.py`
(credentials via env, no client content — safe in the public repo). With boot-time auto-seeding live,
this is a recovery tool rather than a per-restart chore. Full procedure + rationale:
[`RUNBOOK-bank-sync.md`](RUNBOOK-bank-sync.md).

### Client delivery package (`delivery/`, 2026-09-01)

**Hand-off form** of the tested build so a client can deploy it in **their own Azure tenant with
their own AAD**, without the vendor's GitHub repo or source code. Plan + as-built:
[`planning/plan-client-delivery-package.md`](planning/plan-client-delivery-package.md).

- **Version** — the exact tested live build: git `8b7eed1…` = VERSION `0.36.0.4`, retagged to the
  stable image tag `v0.36.0.4` (git sha not exposed).
- **No source code** — prebuilt **linux/amd64** image tars exported from the vendor ACR with
  **skopeo** (docker-archive; built server-side by `az acr build`, so platform-correct). The client
  re-pushes them into its own ACR with `skopeo copy` — no docker daemon either side.
- **Trimmed bicep** (`delivery/infra/`) derived from `infra/azure/main.bicep`, differing by
  `enableGithubOidc=false` **and a simplified bank-delivery topology** (below). The shared
  `modules/role-assignments.bicep` gained an `enableGithubOidc` param **defaulting `true`** so the
  live CI path is unchanged; when off it skips the two GitHub OIDC role assignments (the backend MI's
  **AcrPull** is always created; the delivery package removed the Storage Blob Data Reader grant — the
  Files SMB mount uses the account key, not blob RBAC). The conditional `githubOidc` module's
  `.outputs` access is guarded with documented `#disable-next-line BCP318`; `main.bicep` compiles
  with **0 warnings**.
- **One-click** `delivery/scripts/deploy-client.sh`: `az login` → `az deployment sub create` (first
  create passes the real image tags) → read outputs → skopeo push to the client ACR (with
  `oauth2/exchange` token fallback) → `containerapp update` (frontend gets `BACKEND_URL`) →
  `grant-foundry-rbac.sh` (client's **own** Foundry) → `/health` poll. Idempotent; `--infra-only` /
  `--skip-infra` for partial reruns. **No `az acr build`** (images arrive prebuilt).
- **All 5 question banks reproduced (simplified 2026-09-01 — plain Azure Files share, no VNet)** —
  3 generic banks bake into the backend image and auto-seed. The 2 rf-CSM banks (real SOP citations,
  client-confidential) ship as **plain JSON files** (`delivery/banks/*.json`, gitignored, out-of-band);
  the client uploads them to a **public Azure Files (SMB) share** (`client-banks`, RBAC + account-key
  protected — **no VNet, no private endpoint**) with `upload-banks.sh`. The bicep registers the share
  as a `managedEnvironments/storages` (`azureFile`, account key via `listKeys()`, `ReadOnly`) and
  mounts it read-only at `CLIENT_BANKS_DIR` (`/app/_client_bundle/extra_banks`); the existing
  `seed_client_banks()` imports every `*.json` on each boot — **application code unchanged**. The
  vendor assembles all 5 JSONs with `export-banks.sh` (the export bundle carries the full rubric
  verbatim, so no importer / SOP corpus is needed). *(This replaced the earlier VNet + private-blob +
  `build-bundle.sh`/`upload-bundle.sh` design per owner request; the vendor's own live production
  infra above still uses VNet + private blob.)*
- **Chinese `.docx` operator manual** (`delivery/docs/手册.md` → pandoc → `客户发布操作手册.docx`):
  概述与架构 / 前置条件清单 / 一步步发布 / (可选) rf-CSM 题库 / 验证 / 故障排查.
- **Security boundary** — only trimmed bicep, scripts, manual source, and `*.example` templates enter
  the public repo. Image tars, the rf-CSM bank JSONs (real SOP text — `banks/`), filled `deploy.env` /
  `main.parameters.json`, the generated `.docx`, and the packaged dist zip are gitignored
  (`delivery/.gitignore`) and delivered out-of-band. Verified with a `git add -n delivery/` dry-run
  (only 18 safe files staged; secret scan found only public Azure built-in role GUIDs).
- **Validation state** — templates/scripts authored + statically verified (`az bicep build` 0
  warnings; `network.bicep` removed; Files mount wiring confirmed; `bash -n` on all 5 scripts;
  `export-banks.sh` stages the banks; pandoc `.docx` opens with CJK intact). The delivery rework is
  **not committed** — shipped as a standalone zip (`make-delivery-zip.sh`). **Not yet deployed into a
  client tenant**; the package is prepared for hand-off.
