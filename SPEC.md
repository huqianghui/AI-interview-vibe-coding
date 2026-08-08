# AI Interview Web App — Technical Spec

**Status:** Draft for review (feeds `/autoplan`)
**Date:** 2026-08-07
**Repo:** AI-interview-vibe-coding (greenfield, PUBLIC)
**Reference:** AI-avatar-vibe-coding (Avatar-platform layer) — patterns ported, domain logic rewritten

> This is an internal technical blueprint, not a GitHub issue. Client names, real
> SOP content, and candidate data MUST NOT appear in this file or in commits (repo is public).

---

## 1. Context

A web app that runs SOP-based interviews with an AI digital-human interviewer. Built as a
sales PoC for a client, to production standard (see `## Quality bar`). If the demo lands,
the client greenlights it as their main hiring tool.

**Four capabilities to demonstrate:** AI, digital human, RAG, memory.

**Winning demo (one shot, end to end):** digital-human interviewer asks a question → candidate
answers by voice → interviewer asks a follow-up citing an earlier answer (memory) → on-the-spot
report with SOP citations (RAG + scoring).

**Deciders:** business leader / budget holder + IT lead. No SOP expert scoring line-by-line at
the demo.

**Differentiation vs off-the-shelf (HireVue/Vervoe/etc.) — revised per /autoplan C2:**
The moat is **SOP-traceable, source-cited compliance scoring**: we score whether a candidate's
answers comply with the client's *own* SOP, item by item, each judgment pointing back to the SOP
source (document + page). That is the uncopyable claim — it is bound to the client's private SOP.
The private-Azure closed loop (upload SOP → AI-generate question bank + rubric → digital-human
interview → report; data never leaves the boundary) is the frame around it. **Do NOT lead the
pitch with the digital human or private deployment** — a 2026 competitive scan shows incumbents
(HireVue AI Interviewer, Sara, HeyMilo, Braintrust AIR) already ship live conversational avatars
with adaptive follow-ups, and private/VPC deployment (HireVue is FedRAMP) is converging to
commodity. Those are table stakes / on-screen support, not the headline.

## 2. Quality bar (applies to every feature)

- Built to production / greenlight standard. No demo-only shortcuts.
- **CI hard gate:** every commit passes lint + typecheck + all tests + build. 100% pass.
- Tests genuinely cover core user stories: pytest + pytest-asyncio (backend), vitest (frontend
  unit), Playwright (E2E). Coverage threshold 85% to start, monotonically non-decreasing.
- All 9 features completed to production standard before the first demo (dev *order* is
  risk-first, but delivery *standard* is "all done").

## 3. Tech stack (inherited from reference, domain rewritten)

**Backend:** Python 3.11+, FastAPI, SQLAlchemy 2.0 async + Alembic (SQLite dev / Postgres prod),
JWT auth (python-jose + passlib bcrypt), pydantic-settings.
**Frontend:** React 18 + TypeScript, Vite 6, Fluent UI v9 (`@fluentui/react-components`,
`@fluentui/react-icons`) — pure Fluent, no Radix, no lucide, TanStack Query v5, React Router v7,
React Hook Form + Zod, i18next (zh-CN + en-US, locale-parity test).
**Azure:** OpenAI (AsyncAzureOpenAI, Entra-first + key fallback), Blob Storage, AI Search /
Foundry IQ, Voice Live (`azure-ai-voicelive`, `@azure/ai-voicelive`), AI Projects
(`azure-ai-projects`, Foundry prompt agents). Frontend voice: `@azure/ai-voicelive` + `rt-client`.
**Config:** DB-backed `ServiceConfig` table (service_name-keyed, encrypted keys) as source of
truth; `.env` as bootstrap/fallback. Azure OpenAI scoring pins api-version 2024-06-01; Foundry
agent registry 2025-01-01-preview; AI Search retrieve 2026-05-01-preview (PREVIEW — spike first).

## 4. Auth & multi-tenancy

- **Candidate:** anonymous session. JWT `{"sid", "typ":"anon", "exp"}`, sent via `X-Anon-Session`
  header, DB row authoritative (revocation + expiry checked against the row, not just the JWT).
  Token lives in React state only, never localStorage.
- **Admin:** standard JWT, role `user`/`admin`.
- **No multi-tenancy** for the PoC.

---

## 5. Features (9)

Each feature lists: data model (concrete columns), API, acceptance criteria. Naming and patterns
mirror the reference project's proven shapes.

### F1 — Knowledge base + traceability

SOP upload → chunk → vectorize → Azure AI Search / Foundry IQ index, with document-name + section
position retained for citation.

- **Model `sop_document`** (id, name, blob_path, content_type, size, status, uploaded_at, version).
  Storage via pluggable backend (local dev / Azure Blob prod), ported from reference `storage/`.
- **Model `sop_chunk`** (id, document_id FK, chunk_index, content, page_label / section_path,
  token_count). Mirrors the reference's dropped `material_chunks` shape (chunk_index/content/page_label).
- Text extraction: pdfplumber / python-docx / python-pptx, per-file try/except returning `""`
  (ported from `skill_text_extractor.py`).
- **Ingestion pipeline:** chunk (section-aware) → embedding (Azure OpenAI text-embedding-3-large,
  multilingual) → push to AI Search index with `{title, url/section, page}` retrievable metadata.
  **Spike first (0.5–1 day):** confirm Foundry IQ integrated vectorization gives section-level
  traceability; if not, hand-roll chunking + index push.
- **Citation retrieval** (ported from `avatar_search_service.retrieve_citations`): POST
  `{endpoint}/knowledgebases/{kb}/retrieve?api-version=2026-05-01-preview`, body
  `{messages:[...], knowledgeSourceParams:[{knowledgeSourceName, kind:"searchIndex"}]}`. Return
  `{title, url, page}`. **Strict field gate:** drop any citation missing any of the three fields.
- **AC:** (1) upload a PDF/DOCX SOP → chunks persisted with page/section labels; (2) query returns
  citations with correct doc name + page; (3) citation missing any field is dropped, not shown;
  (4) unsupported/corrupt file fails gracefully without crashing the batch.

### F2 — Question bank

- **Model `question`** (id, bank_id FK, order_index, text, language, expected_points (JSON, links
  to checklist items), enabled, created_at). Seeded with 10 questions for the demo.
- **Model `question_bank`** (id, name, description, language, enabled, is_default).
- API: admin CRUD + candidate-facing ordered read. **Demo start:** seed data + read-only list;
  full admin editor is F2b (post-demo, still in scope).
- **AC:** (1) 10 seeded questions load in order; (2) read API returns questions for an interview;
  (3) admin create/edit/reorder works (F2b); (4) language field respected.

### F3 — Checklist (rubric)

Per-question scoring standard: required / recommended / forbidden items + weight + source text.

- **Model `checklist`** (id, question_id FK, prompt_version, is_default). 
- **Model `checklist_item`** (id, checklist_id FK, kind ENUM `required|recommended|forbidden`,
  text, weight, source_quote, source_document_id FK, source_page). Mirrors reference
  `ScoringRubric.dimensions` JSON pattern but as first-class rows for traceability.
- **AI draft generation:** given SOP + a question, LLM drafts checklist items with source quotes
  (structured JSON output). Business edits via UI (F3b, post-demo, still in scope; reuses the
  reference rubric-editor RHF+Zod pattern).
- **AC:** (1) AI generates a checklist draft from SOP + question with source quotes; (2) each item
  carries kind + weight + source_document + page; (3) weights per checklist sum to 100; (4) editor
  saves/loads (F3b).

### F4 — Scoring engine

Per-item checklist comparison, 4-state judgment + rationale + SOP quote, coverage/total/grade.

- Pattern ported from reference `scoring_engine.py`: strict JSON output
  (`response_format={"type":"json_object"}`), temperature 0.1, DB-versioned prompt (registry
  pattern), safe custom-template renderer (no arbitrary str.format).
- **4-state judgment per item:** `met | partially_met | not_met | violated` (violated = forbidden
  item triggered). Each judgment carries rationale + verbatim answer quote + SOP source quote.
- **Anti-hallucination rails** (ported `_enforce_scoring_rules` pattern): if the answer text is
  empty/too-short, cap scores; if a forbidden item fires, force `violated` + warning regardless of
  other content; reject/log any item the LLM invented that isn't in the checklist.
- **Language-aware:** SOP language, answer language, report language may differ; prompt instructs
  cross-language comparison explicitly.
- **Output:** per-item state + rationale + quotes; coverage % (met+partial / total weighted); total
  score (weighted, 0-100); grade; improvement suggestions; forbidden-item warnings. Structured
  JSON API.
- **AC:** (1) each checklist item gets one of 4 states + rationale + both quotes; (2) forbidden
  item in the answer forces `violated` + warning; (3) empty answer never scores high (rail fires);
  (4) English SOP + Chinese answer scores correctly (cross-language); (5) total = weighted sum,
  reproducible at temp 0.1.

### F5 — Interviewer digital human

Foundry prompt agent + inline voice mode config. No VoiceLiveInstance.

- **Model `interviewer_persona`** (ported from `AvatarPersona`): id, name, character, style,
  voice_map (JSON locale→voice), greeting_map (JSON locale→text), prompt_fragment
  (agent instructions), enabled, is_default (partial-unique index: exactly one enabled default),
  voice knobs (turn_detection/eou, noise_suppression, echo_cancellation, interim_response,
  proactive_engagement, voice_temperature, playback_speed), agent_id, agent_version,
  agent_sync_status (`none|pending|synced|failed`), agent_sync_error.
- **Agent sync** (ported from `agent_sync_service`): create/update Foundry prompt agent via
  `azure-ai-projects` `AIProjectClient.agents.create_version/get/delete`. Writes
  `microsoft.voice-live.enabled` + `microsoft.voice-live.configuration` metadata (snake_case
  `session` object: voice / input_audio_transcription / turn_detection.end_of_utterance_detection /
  noise_reduction / echo_cancellation / avatar / proactive_engagement / interim_response), chunked
  at 512 chars. Credential fallback: DefaultAzureCredential first (required for create), API key
  for read/update/delete.
- **AC:** (1) create an interviewer persona → Foundry agent synced, agent_id + version stored;
  (2) voice config metadata written in snake_case (portal shows Voice mode ON); (3) exactly one
  enabled default persona enforced at DB level; (4) sync failure sets status=failed + error, doesn't
  crash.

### F6 — Turn-by-turn interview state machine

Channel-agnostic (text + voice share progression logic); follow-up hooks reserved; end-of-answer
detection.

- **Model `interview_session`** (id, candidate_session_id FK, question_bank_id FK, status ENUM
  `created|in_progress|completed|scored`, current_question_index, started_at, completed_at). State
  machine ported from reference session lifecycle.
- **Model `interview_turn`** (id, interview_session_id FK, question_id FK, turn_index, role
  `interviewer|candidate`, turn_kind `main|follow_up`, content, audio_ref, created_at). An
  **Answer = the group of candidate turns for one question** (main + 0..N follow_up) — follow-up
  content is scorable without schema change.
- **Progression:** `asking → answering → (follow_up × 0..N) → judged → next`. Channel-agnostic:
  text UI and voice UI both feed "answer text" to the same progression; channel is only transport
  (per reference dual-path decision — text via Responses API, voice via Voice Live → agent, no
  shared abstraction forced).
- **End-of-answer (voice):** silence timeout via Voice Live native EOU detection
  (`turn_detection.end_of_utterance_detection`, `semantic_detection_v1_multilingual`) + verbal cue
  fallback (candidate says "我答完了"/"done" → detected in transcript). Silence threshold configurable.
- **Follow-up hook:** per-question `max_follow_ups` config (demo default 0 or 1); when >0, an
  optional follow-up turn is generated and its content joins the answer group for scoring.
- **AC:** (1) session advances question 1→N, one question at a time; (2) text and voice both drive
  the same state machine; (3) voice: silence timeout advances; verbal cue advances immediately;
  neither cuts off mid-sentence in a clean demo run; (4) follow-up turn (when enabled) is recorded
  and included in that question's answer group; (5) status transitions
  created→in_progress→completed→scored enforced.

### F7 — Session memory surfacing

Foundry agent built-in session memory + an explicit demo moment.

- Uses Foundry prompt agent's built-in conversation memory (zero new persistence).
- **Explicit demo moment:** the interviewer's follow-up prompt references an earlier answer in the
  same session (e.g., "你第二题提到X,这里为什么…"). Implemented as a follow-up-turn prompt that
  passes prior-turn context to the agent.
- **AC:** (1) within one interview, a follow-up visibly cites content from an earlier question's
  answer; (2) the citation is accurate to what the candidate actually said (from interview_turn).

### F8 — Interview report

- **Model `interview_report`** (id, interview_session_id FK, total_score, grade, coverage_pct,
  per_question_scores (JSON), missing_knowledge_points (JSON), forbidden_violations (JSON),
  generated_at). Report DTO pattern ported from reference `report_service`.
- Aggregates F4 per-question results: total + per-question score & coverage, concentrated missing
  knowledge points, forbidden-item summary.
- **Export:** Excel via openpyxl (ported `export_service`). Server-side PDF is out of scope for the
  demo (browser print acceptable); flagged as post-demo if the client requires formal PDF.
- **AC:** (1) scored session produces a report with total + per-question breakdown; (2) missing
  knowledge points + forbidden violations aggregated; (3) Excel export downloads and opens; (4)
  report only available when session status = scored.

### F9 — Frontend interview page

- Reuses Avatar-layer patterns: voice components (audio orb, avatar view, transcript, controls),
  sources-panel (citations structurally separate from transcript), mic-permission dialog, question
  progress indicator.
- **Voice hook** ported from `use-anonymous-voice-live.ts`: RTCPeerConnection (no ICE servers,
  Azure handles TURN), `voice-live-events` data channel, signaling WebSocket (SDP create), 3-attempt
  reconnect with 1s/2s/4s backoff, `MicAccessError` distinct from service errors. WebRTC primary,
  WebSocket fallback.
- **AC:** (1) candidate lands (anonymous), grants mic, sees digital-human interviewer; (2) question
  progress (n/N) visible; (3) citations render in a separate sources panel, never inline in the
  transcript; (4) mic-denied shows retry / use-text-instead; (5) reconnect recovers a dropped
  connection within 3 attempts.

---

## 6. Dependency graph & build order (risk-first)

```
F5 Digital human ─┐
F6 State machine ─┼─> F9 Frontend interview page ─> [WINNING DEMO PATH]
F1 Knowledge base ┘        │
   │                       │
   └─> F3 Checklist ─> F4 Scoring ─> F8 Report
F2 Question bank ─────────┘
F7 Memory (rides on F5+F6)
```

**Build order (expose biggest risk first, per chosen approach "skeleton + e2e thin slice"):**
0. **Scaffold:** repo (FastAPI + React + Fluent + CI + auth + alembic + i18n), one hardcoded
   question, stub scoring, digital-human turn-by-turn thin slice runnable. Proves the two riskiest
   things (Foundry-agent voice path + state machine) in week one.
1. **Spike:** Foundry IQ integrated-vectorization traceability granularity (F1 decision).
2. F5 + F6 + F9 to production (the demo spine).
3. F1 + F2 + F3 + F4 (knowledge → scoring chain).
4. F7 + F8 (memory moment + report).
5. F2b + F3b admin editors (still in scope, lowest demo urgency).

## 7. Rollback / risk

- Foundry IQ retrieve API is preview (2026-05-01-preview) — spike gates F1 approach; fallback is
  hand-rolled chunking + AI Search index push.
- Scoring consistency (≥80% expert agreement) is a post-greenlight goal, not a demo gate; PoC
  calibration is ~1 day (enough that the demo doesn't embarrass).
- All Azure config in DB-backed ServiceConfig → swappable without redeploy.

## 8. Out of scope (PoC)

- Multi-tenancy / org isolation.
- Server-side PDF (Excel + browser print only).
- Dynamic follow-up scoring beyond the reserved hook (follow-up content is captured & scorable, but
  advanced adaptive questioning is post-demo).
- Cross-session candidate memory (only in-session memory for the demo).

## 9. Blocking pre-work from client (before/early in build)

1. Final SOP document(s). 2. The 10 interview questions. 3. Judging criteria / checklist source +
2-3 "model answer + expert score" samples (incl. a cross-language case). 4. Demo Azure environment
(AI Search index quota, Foundry IQ access, Voice Live region).

## 10. Open items for `/autoplan` review

- Embedding model choice (text-embedding-3-large assumed — confirm multilingual retrieval quality).
- Whether F2b/F3b admin editors are truly needed for greenlight or can stay stubbed.
- Voice EOU silence-threshold default (start 3–4s, tune on real audio).

---

## 11. Review patches (from /autoplan — mechanical, auto-applied)

Four independent reviews (CEO / Design / Eng / DX) ran against this spec. The items below
were clearly correct and are folded into the spec. Taste/strategy decisions requiring the
owner's call are tracked separately (see the /autoplan approval gate, not this file).

### Test & local-dev (DX + Eng — Critical)
- **P1. Mock-adapter path is a first-class requirement.** Local dev + CI run fully on mock
  providers by default (`DEFAULT_LLM_PROVIDER=mock`, mock Voice Live / citation-retrieve /
  Foundry-agent-sync no-op), ported from reference `app/startup/adapters.py`. Azure is opt-in
  via env/DB config. Without this, no-Azure local dev and the 100%-CI gate have no seam.
- **P2. Test-double strategy stated:** all Azure SDK calls (AsyncAzureOpenAI, AIProjectClient,
  AI Search retrieve, azure-ai-voicelive) mocked at the client-construction boundary in unit
  tests, per reference `test_agent_sync_service.py` (`patch(..., new_callable=AsyncMock)`),
  in-memory SQLite + `get_db` override per reference `conftest.py`. Playwright F9 voice E2E is a
  smoke-test tier that may skip in CI and runs against a live demo env pre-ship (the reference
  does NOT run WebRTC E2E in CI — do not over-promise it in the 100% gate).

### Security (Eng — High)
- **P3. Checklist never leaks to candidates.** AC added to F3: checklist/rubric (items, weights,
  source_quote, source_page) is NEVER present in any candidate-scoped (`X-Anon-Session`) response
  at any interview status. Dedicated security test asserts no `checklist`/`rubric`/`weight`/
  `source_quote` keys in candidate-facing question/turn/report payloads.
- **P4. Private data boundaries.** Anon sessions never receive direct blob URLs (only
  server-mediated citation text). Note that `prompt_fragment` / SOP-derived agent instructions
  persist in Azure Foundry control plane (outside DB encryption) — keep SOP verbatim content out
  of agent metadata; reference checklist logic, not raw SOP text.

### Robustness (Eng — High/Med)
- **P5. Voice session rejected, not silently degraded, if `agent_sync_status != synced`** (F6/F9
  AC). The reference's WebRTC path had NO such enforcement and silently fell back to model mode —
  do not inherit that bug.
- **P6. Mid-interview failures handled** (F6 AC): (a) unrecoverable disconnect after 3 reconnects
  → current in-flight turn preserved (partial content, not discarded) + offer resume-in-text;
  (b) agent unreachable during an active interview → fall back to text-only continuation of the
  same session, not a hard crash.
- **P7. Scoring integrity** (F4 AC): missing checklist item in LLM output → raise/retry, never
  silently omit (a dropped `required` item inflates coverage%). Recalibrate the short-answer
  length threshold for a single Q&A turn — do NOT port the reference's 100-char aggregate-
  transcript number as-is.
- **P8. SQLite lock contention:** F5 agent-sync writes must use the prefetch-before-flush pattern
  (reference `prefetch_sync_config`). Demo day uses Postgres, or serializes writes, for concurrent
  candidates.

### State machine framing (Eng — Med)
- **P9. State machine transition contract** = a single `answer_finalized(text, source)` event with
  three producers (text-submit / voice-EOU / verbal-cue). "Channel-agnostic" means shared state +
  one event type, NOT shared triggering logic. F6 AC #2 reworded accordingly.

### Demo-critical UI states (Design — Critical)
- **P10. Add missing states to F9/F8:** question-transition beat (avatar acknowledges → progress
  advances → new question announced), scoring-in-progress screen ("Analyzing answer N of M against
  SOP…"), report-ready reveal. These sit on the winning-demo path and were entirely unspecified.
- **P11. `QuestionProgress` is a NEW component** (dot-stepper: not-started/active/answered/
  remaining), not a "reuse" — no analog exists in the reference. F9 must specify interview-page
  layout hierarchy: (1) avatar dominant, (2) current question pinned/visible without scrolling
  transcript, (3) progress indicator, (4) transcript secondary, (5) sources-panel.
- **P12. sources-panel is NOT candidate-facing during live Q&A.** Showing raw SOP citations to the
  candidate mid-interview looks like leaking the rubric. Citations surface in the scoring/report
  phase (and admin/reviewer view), not during the live answer.
- **P13. Candidate has a visible manual "I'm done answering" control** (button/hotkey), paired with
  the verbal-cue fallback — never solely at the mercy of a silence heuristic. Add a low-anxiety
  "still listening…" affordance and a brief grace beat before advancing. Add a short pre-Q1
  orientation beat ("you'll answer N questions, take your time").

### Report presentability (Design — High)
- **P14. F8 needs executive-view + detail-view split.** Executive: one headline grade + visual
  gauge, LLM-generated 1-2 sentence strength/gap narrative, and 1-2 SOP citations shown as
  quoted source text SIDE BY SIDE with the candidate's actual answer (the most demo-legible proof
  RAG is real). Detail: full per-item/per-question breakdown, progressively disclosed. AC added.

### Preview-API scope (DX + Eng — Med/High)
- **P15. Widen the F1 spike scope:** confirm BOTH the citation-retrieve response shape AND the
  Foundry-agent knowledge-source connection (RemoteTool / `_create_remote_tool_connection` in
  reference `knowledge_base_service.py`) are stable across the preview version. The hand-rolled-
  chunking fallback covers indexing only — it does NOT de-risk the agent-connection or citation-
  shape dependency. Spike output includes a fallback trigger condition, not just a one-time go/no-go.
- **P16. Read the reference source + git history before porting** (esp. `agent_sync_service.py`
  voice metadata: camelCase→snake_case was a real silent-failure bug fixed 2026-08-05; chunking-at-
  512 was reverted then reinstated). Add a manual Foundry-portal "Voice mode ON" verification
  checkpoint as a Step-2 exit criterion — the automatable AC (bytes written) can pass while the
  portal ignores the metadata.

---

## 12. Owner decisions at the /autoplan gate (strategy — NOT auto-decided)

Three CEO/strategy challenges were surfaced to the owner (they contradicted or extended
prior decisions). The owner's rulings:

- **C1 — Scope: keep all 9 features to production standard.** The owner OVERRODE the three
  reviewers' recommendation to split demo-critical vs production-hardening. Rationale (owner's,
  standing): on greenlight the code becomes the project foundation with zero rewrite, so the
  investment is justified even though it delays time-to-demo. Reviewers' dissent is on record
  (scope inflation for a single-demo sales PoC); owner accepts that trade knowingly.
- **C2 — Differentiation: SOP-traceable scoring now LEADS the pitch** (see §1, §4 revised).
  Digital human + private cloud demoted to support, per competitive scan.
- **C3 — No recorded/scripted demo fallback.** The owner will rely on rehearsal to stabilize the
  live one-shot path. Reviewers' dissent is on record (all four flagged live-demo fragility:
  WebRTC/WiFi, EOU silence threshold untuned for the room, preview-API drift). Mitigation falls
  entirely on rehearsal + the robustness patches P5/P6 (graceful degradation, reconnect,
  reject-if-unsynced) already folded into the spec. No Wizard-of-Oz safety net.
