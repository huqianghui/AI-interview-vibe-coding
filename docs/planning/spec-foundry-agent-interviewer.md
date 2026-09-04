# Spec: Foundry-agent interviewer — replicate the Foundry Agent editor + fuse the interview flow

**Status:** Draft (authored via `/spec`, 2026-08-10, `--file-only`)
**Repo:** refactor in-place in the current `AI-interview-vibe-coding`
**Spec of record:** [`../../SPEC.md`](../../SPEC.md); this doc scopes the Foundry-agent-base refactor.

---

## Context

The demo's four selling points are AI, digital human, RAG, memory — and the winning path is a
digital-human interviewer that asks SOP-grounded questions, decides follow-ups, and produces a
report. Azure AI Foundry's **prompt agent** already provides voice, avatar, Foundry IQ knowledge,
and a unified Tools/Toolbox natively, configured on one agent. This project's earlier detour
hand-rebuilt those (a self-made config page, `ServiceConfig`, a hand-written LLM adapter, a retrieval
adapter) instead of standing on the Foundry agent. That work is superseded here.

The correct base already exists in **AI-avatar-vibe-coding**: a full Foundry prompt-agent + Voice
Live WebRTC + digital-human stack, a **full user/admin JWT auth system**, and a frontend **already
mid-migration to Fluent UI v9** whose admin config surface is a superset of AI-Coach's and includes a
`configuration-panel.tsx` modeled on the Foundry portal's Configure panel. The user wants the app to
look and configure exactly like the Foundry portal's Agent editor (Fluent v9 — the current
AI-interview UI is not acceptable), with real user/admin roles, and the **interview content and flow
fused on top**: read questions one at a time, show them, accept a text or voice answer, let the agent
decide follow-up vs next question, until done.

## Base inventory (verified 2026-08-10, four Explore passes)

**PORT from AI-avatar-vibe-coding (the base — frontend, auth, and agent stack all come from here):**

| Capability | File(s) |
|---|---|
| Foundry prompt-agent create/update (`PromptAgentDefinition`, `create_version`, `name:version`) | `agent_sync_service.py` |
| Voice/avatar bound onto the agent via metadata (`microsoft.voice-live.configuration`) | `agent_sync_service.build_voice_live_metadata` |
| Foundry IQ → MCPTool binding (Knowledge) | `knowledge_base_service.build_search_tools` |
| Voice Live WebRTC (signaling + STS bearer; audio browser↔Azure) | `voice_live_webrtc.py`, `voice_live_service.py` |
| Persona catalog (character/style/voice/greeting/prompt → own agent) | `avatar_persona.py`, `avatar_persona_service.py` |
| Text chat via Responses API (`agent_reference`, `previous_response_id`, streaming) | `agent_chat_service.py` |
| **User/admin auth** (User model role=admin/user, bcrypt, JWT HS256/24h, `require_role`) | `models/user.py`, `api/auth.py`, `services/auth.py`, `dependencies.py`, `api/admin_users.py` + users migration |
| Entra-first Azure auth + admin-managed config + secrets | `azure_auth.py`, `config_service.py`, `secret_store.py`, `connection_tester.py`, `region_capabilities.py` |
| **Admin config UI** (azure-config page, model/KB pickers, `configuration-panel.tsx` Foundry-style) | `pages/admin/azure-config.tsx`, `components/admin/*`, `configuration-panel.tsx` |
| **Frontend Fluent v9 base** (19/22 adapters done, theme bridge, auth store/guards/login) | `components/ui/*` (Fluent adapters), `stores/auth-store.ts`, `router/auth-guard.tsx`, `pages/login.tsx`, `styles/fluent-theme.ts` |
| Scoring base (answer/pronunciation scoring) | `voice_score.py`, `voice_scoring_service.py` (+ AI-Coach scoring) |

**DO NOT PORT (explicitly out — user-confirmed):**
- **"voice instance" concept** — `voice_live_instance*` model/schema/service/CRUD routes/migrations/FK,
  the instance admin pages, and the dead `vl_instance_id` params. (Voice Live runs from persona +
  agent + config; verified independent.) Relocate `resolve_voice_config` /
  `resolve_voice_config_for_persona` to a neutral `voice_config_resolver.py` before deleting the
  instance service.
- **Conference** — conference session/audience-Q&A queue (`conference*`, `turn_manager.py` audience
  queue).
- **AI-Coach training "skill" business** — `skill_foundry_service.py`, `skill_consumption_service.py`,
  meta-skill, document→skill. (This is HCP-training terminology, irrelevant to interviews. NOTE: the
  Foundry-native **Tools/Toolbox** block in the agent editor IS kept — that is different from this.)

**DROP from the current AI-interview (self-made, superseded by the base):**
- `app/services/config_service.py` (self-made variant), `app/api/admin_config.py`,
  `app/services/agents/foundry_connections.py`, `app/services/agents/adapters/azure_llm.py`,
  `app/services/config_overlay.py`, `service_configs` model/migrations — replaced by the ported base.
- The current Tailwind-free Fluent-but-thin interview UI is replaced by the ported AI-avatar frontend.

**KEEP from the current AI-interview:**
- Question bank data layer (`question_bank`/`question` + seed) — the interview question source.
- Report/scoring data layer — the sink when scoring is wired (later phase).

## Quality-gate findings folded in (Plan sub-agent review, scored 4/10 → addressed)

The initial spec was an inventory pass; a dependency/compile-graph review surfaced these, now baked
into the phases below. Do not treat any port as copy-paste.

1. **DB-layer + Settings are NOT compatible across the two repos — a port is a rewrite of data-access
   boilerplate, not a rename.** AI-interview: `app/db.py`, `Base` inline (`app/db.py:16`), session
   `async_session_factory` / `get_db` (no commit/rollback). AI-avatar: `app/database.py`,
   `Base`/`TimestampMixin` in `app/models/base.py`, session `AsyncSessionLocal`, `get_db` commits.
   Every ported avatar service imports `from app.database import AsyncSessionLocal` and
   `from app.models.base import Base` — neither exists here. **Two different `Base` classes cannot
   share metadata/migrations.** Phase 2 must do a DB-layer + `Settings` reconciliation FIRST (decide:
   unify on one `Base`/session; enumerate every `settings.X` the ported code reads and add missing
   fields — AI-avatar has `api_prefix`/`database_auth_mode`/`cors_origins`/`feature_*` that this repo
   lacks).
2. **Dual auth is intentional and must be stated.** This repo's candidate path uses
   `AnonymousCandidateSession` + `anonymous_session_service.py` (all `app/api/interview.py` routes gate
   on `get_anonymous_session`). AI-avatar ALSO has an `anonymous_session_service.py` bound to a
   DIFFERENT model (`AnonymousAvatarSession`). **KEEP this repo's `AnonymousCandidateSession` + service
   untouched.** The ported `User`/JWT auth is a SECOND, separate system (admin/user for the
   editor/config UI); it does NOT replace candidate anon-auth. Do not overwrite the candidate model
   while porting the admin auth.
3. **`resolve_voice_config` relocation:** in the source repo it's entangled with `HcpProfile`/
   `VoiceLiveInstance`, but this repo has NEITHER model, so that tangle is moot here. The relocated
   `voice_config_resolver.py` only needs the `AvatarPersona` branch (kept) — drop the
   `HcpProfile`/`VoiceLiveInstance` branch. Verify `resolve_voice_config_for_persona` doesn't itself
   read `VoiceLiveInstance` before copying.
4. **Frontend port is a rewrite, not a finish.** `configuration-panel.tsx` (703 lines, the Phase-3
   centerpiece) has ~70 Tailwind utility `className`s; **this repo has ZERO Tailwind config** and a
   different dep set (react-router v6 vs v7, no axios/zod/lucide). "19/22 adapters done" is only the
   small `components/ui/*` primitive layer, not feature pages. Phase 3 must scope "convert the
   Configure panel's ~70 Tailwind classes to Fluent v9 `makeStyles`/tokens" as an explicit task, and
   reconcile the router-major mismatch.
5. **Decision owner (REVERSAL):** the **backend `state_machine` is the SINGLE decision-maker** for
   follow-up vs next question (this repo already has `answer_finalized(db, session, text, source)` with
   `ANSWER_SOURCES = ("text","voice","verbal_cue")` at `state_machine.py:69-80`, and deterministic
   follow-up via `follow_ups_asked < max_follow_ups`). The Foundry agent only generates question/
   follow-up TEXT and does voice/avatar presentation — it does NOT decide flow. **Voice must NOT use
   Voice Live agent-autonomous mode** (that would let the agent drive the conversation and desync from
   backend state). This supersedes the earlier "agent decides" choice and removes the two-decision-maker
   conflict.
6. **Voice→turn mechanism (Phase 4's hardest new problem):** voice audio is browser↔Azure direct, so
   the backend never sees it live. A frontend handler on the final-transcript event
   (`conversation.item.input_audio_transcription.completed` / `response.audio_transcript.done`) must
   POST the transcript to the INTERVIEW `/answer` endpoint with `source="voice"` (NOT a bare
   transcript-log endpoint), exactly once, distinguishing final from interim. Phase 4 carries a
   sub-design note pinning: which event is authoritative, idempotency/ordering, and that the question
   the candidate hears is the backend-provided text (agent speaks it), so the backend's question
   pointer stays authoritative.
7. **Phase 2/4 coupling:** Phase 4 extends the same instructions-building code Phase 2 creates.
   Phase 2 must build the agent-instructions mechanism as composable prompt-sections up front (so
   Phase 4 injects the per-question interview text without reopening Phase 2's frozen builder).

## Phased plan (each phase → its own issue under an epic)

### Phase 1 — Auth + user/admin (port from AI-avatar)
User model (role admin/user), `/auth/login` + JWT (bcrypt, HS256, 24h) + `require_role`, admin user
CRUD, users migration. Frontend: auth store, `ProtectedRoute`/`AdminRoute`/`GuestRoute`, login page.
Replaces the shared-token guard. Outcome: real login, admin-gated routes.

### Phase 2 — Port + simplify the Foundry-agent backend base
Bring agent_sync / voice_live_webrtc / voice_live_service / knowledge_base / avatar_persona /
agent_chat / azure_auth / config_service / secret_store into this repo. Drop the voice-instance
concept (relocate `resolve_voice_config`). Drop conference + AI-Coach training-skill services. Remove
the self-made config machinery. Keep Foundry-native Tools/Toolbox wiring. Outcome: backend creates/
syncs a Foundry prompt agent (model + instructions + voice/avatar metadata + Foundry IQ + toolbox)
and brokers a Voice Live WebRTC session, Entra-first.

### Phase 3 — Foundry Agent editor UI (Fluent v9, mirrors the portal)
Port AI-avatar's admin config UI + `configuration-panel.tsx`; assemble the editor to match the portal
screenshot: left nav, center agent definition (Model dropdown, Voice mode, Instructions,
Tools/Toolbox, Knowledge), right Configuration rail (Language + auto-detect, Speech voice, Interim
response, Proactive engagement, Avatar grid), digital-human preview. Finish the Fluent migration
remnants (form/scroll-area/toast → pure Fluent v9; remove Radix/sonner). Model dropdown + Knowledge
picker use Entra (verified endpoints). Outcome: portal-faithful editor, all Fluent v9.

### Phase 4 — Fuse the interview flow (the only genuinely new logic)
Read questions one at a time from the existing question bank DB; present each (text + spoken by the
agent/avatar when voice mode on); accept a **text or voice** answer, both feeding the SAME backend
turn (`answer_finalized`, source text|voice). The **backend `state_machine` is the single
decision-maker** for follow-up vs next question (deterministic `max_follow_ups`); the agent only
produces the question/follow-up text. Advance until the bank is exhausted, then end. **Voice→turn
sub-design (do first):** a frontend final-transcript handler POSTs to the interview `/answer` endpoint
with `source="voice"` exactly once; voice uses Voice Live model/TTS to SPEAK the backend-provided
question text, NOT agent-autonomous mode — backend keeps the question pointer authoritative.

### Phase 5 — Scoring/report (later; port from AI-Coach, don't rebuild)
Port the AI-Coach scoring base; wire the report to real Foundry output + SOP citations. Deferred
until 1–4 run; existing report data layer is the sink.

## Acceptance criteria (per phase)

**Phase 1:** login issues a JWT; `/admin/*` routes reachable only by role=admin (403 otherwise);
admin user CRUD works; frontend guards redirect by role; users migration up/down clean.

**Phase 2:** backend creates/updates a Foundry prompt agent against `avarda-demo-prj` (model +
instructions + voice/avatar metadata + Foundry IQ MCP tool + toolbox); no voice_live_instance /
conference / training-skill / self-made-config code remains; `resolve_voice_config` relocated; Voice
Live WebRTC session builds from persona + agent + config; Entra-first; backend gate green.

**Phase 3:** the agent-editor route renders the portal layout in Fluent v9 (left nav + center
definition + right Configuration rail + digital-human preview); Model dropdown lists real deployments
(Entra, `ai.azure.com`); Knowledge picker lists real Foundry IQ KBs (via the project AI Search
connection, `search.azure.com`, `2026-05-01-preview`); saving writes a usable agent; zero Radix/sonner
left; frontend gate green.

**Phase 4:** starting an interview reads question 1 and the agent presents it (text + spoken when
voice on); a candidate answers the same question by text OR voice, both reach `answer_finalized` and
advance; the **backend state_machine** decides follow-up vs next (test with a fixture proving the
state_machine — not a bypassed path — drives the branch: ≥1 follow-up + ≥1 advance); interview ends
after the last question. Edge cases (explicit ACs): (a) empty/unseeded question bank → defined
terminal state, not a broken UI; (b) session resume after disconnect → `get_current_question` replays
the pending question; (c) agent-sync/voice-session failure at start → text-only fallback continues
(don't 500); (d) voice unavailable or toggled off mid-interview → text path continues seamlessly.

## Testing plan

| Layer | What | Phase |
|---|---|---|
| Unit | JWT/role guard; agent-definition builder (model/instructions/metadata/tools); voice-config resolver post-relocation; interview turn state | 1,2,4 |
| Integration | login→admin route gate; create→read agent (mocked SDK); WebRTC session from persona+agent+config; question read→present→answer→advance | 1,2,4 |
| Frontend | login/guards; editor renders portal layout; model/KB dropdowns populate (mocked); save calls agent sync; interview turn loop | 1,3,4 |
| Live-Azure (manual, Layer 3) | real login; real agent create; real model/KB dropdowns; a real voice/text interview turn against `avarda-demo-prj` | 1–4 |

## Out of scope (locked)
Voice-instance concept; conference; AI-Coach training skill/meta-skill/document→skill; multi-resource
config / external secret store / region auto-detect; scoring/report to real Foundry (Phase 5). NOT rebuilding any
Foundry-native capability the base provides (Tools/Toolbox and Knowledge are kept, ported not rebuilt).

## Rollback
Epic + issue-per-phase, branch-per-phase, each independently revertable. Superseded self-made modules
deleted in Phase 2 behind that PR. DB migrations reversible; question-bank/report tables untouched.

## Critical facts for the implementer (verified live, 2026-08-10)
- `avarda-demo-prj` has **API-key auth DISABLED** — all Azure calls Entra (managed identity /
  `az login`). Model deployments: `GET {endpoint}/api/projects/{project}/deployments?api-version=v1`,
  scope `https://ai.azure.com/.default`. Knowledge bases live on the **AI Search endpoint** (the
  project AI Search connection `target`): `GET {search}/knowledgebases?api-version=2026-05-01-preview`,
  scope `https://search.azure.com/.default`.
- Deployed models: `gpt-5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-4o-mini`, … (NOT `gpt-4o`).
- Knowledge bases: `omada-product-parameters-kb` (source `omada-product-parameters-index-ks`),
  `custom-skill-demo05-kb`.
- Auth is identical in AI-Coach and AI-avatar; port from AI-avatar (its frontend is already Fluent v9).

## Related
- Base: `AI-avatar-vibe-coding` (agent stack + auth + Fluent-v9 frontend + config UI). Reference for
  scoring + Foundry IQ connection resolution: `AI-Coach-vibe-coding`.
- Supersedes the v0.15/v0.16 self-made config work in this repo.
