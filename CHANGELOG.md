# Changelog

## 0.18.0.0 (2026-08-10)

Phase 2 of the Foundry-agent interviewer refactor (epic #26, issue #28): the Azure-integration
base. Per-module diff against AI-avatar-vibe-coding, porting **only** what this repo genuinely
lacked — no re-porting of what already worked, no HCP-training machinery. Landed as six focused
sub-commits (2.0–2.5). Local dev / CI still run entirely on mock providers — zero Azure to build
or test; every live path is coverage-omitted and exercised only against real resources.

### Added
- **Centralized Azure auth** (`app/services/azure_auth.py`, Phase 2.1): single source of truth for
  the Entra-first / API-key-fallback strategy + per-surface scope constants (Cognitive Services,
  Foundry, Search, ARM). Both prior duplicated call sites (agent-sync, voice) now delegate.
- **Foundry IQ connection discovery + RemoteTool creation** (`app/services/agents/foundry_connections.py`
  + `foundry_client.py`, Phase 2.2) — the genuine gap: the app can now **obtain a usable
  `project_connection_id`**. Lists AI Search connections + knowledge bases (feeds the config
  dropdowns), and finds-or-creates the KB's RemoteTool connection via the ARM control plane
  (`category=RemoteTool`, `authType=ProjectManagedIdentity` — no stored secret) so the MCPTool
  authenticates instead of 403ing. Shared Entra-first `AIProjectClient` builder extracted so the
  adapter and the connections service use one seam.
- **Agent chat via the Responses API** (`app/services/agent_chat_service.py`, Phase 2.3):
  `chat_with_agent` / `stream_agent_response` drive the hosted Prompt Agent
  (`responses.create` + `agent_reference`, `previous_response_id` for multi-turn); `agent_name=None`
  gives the ungrounded plain-model fallback. This is the text/decision channel the interview state
  machine will use. Without the reference's HCP `personalization_context`.
- **Transient-retry on agent create** (Phase 2.5): connection drops retry with 2s/4s backoff; a
  500/auth error goes straight to the pre-created-agent recovery path.

### Changed
- **Restored + reconnected the DB-backed AI Foundry config layer** (Phase 2.4): instead of
  re-porting avatar's heavier `config_service`, restored this repo's own right-sized layer (single
  master `service_configs` row, P1 endpoint-allowlist exfil guard, Fernet at-rest encryption,
  DB > .env > code-default overlay) that Phase 2.0 had deleted, and reconnected it: admin routes
  now use the Phase 1 JWT `require_role("admin")` guard; the KB dropdown's Entra fallback delegates
  to `azure_auth`; the overlay's dead `azure_openai` LLM path (adapter removed in 2.0) was dropped.
  Endpoints (`/admin/config/ai-foundry` GET/PUT/test + `/model-deployments` + `/knowledge-bases`)
  satisfy the existing frontend `admin.ts` contract unchanged.

### Removed
- **Self-made config machinery** (Phase 2.0): the earlier bespoke `admin_config`/`config_service`/
  `config_overlay`/`azure_llm` iteration was deleted before the port, then the config layer was
  restored in right-sized form in 2.4. Zero remnants of `voice_live_instance` / `conference` /
  training-`skill` / `meta-skill` concepts (grep-verified).

### Tests
- Backend: 320 pass, 86.70% coverage (new: `azure_auth`, `foundry_connections`,
  `agent_chat_service`, `azure_agent_sync` pure-helper suites; restored `config_service` +
  `admin_config_api` retargeted to the JWT `admin_auth` fixture). Frontend: 29 pass; E2E: 4/4.

## 0.17.0.0 (2026-08-10)

Real user/admin login replaces the shared admin token. Admins now sign in with a username and
password and get a JWT; the `/admin` editor is gated by an actual admin role, not a pasted secret.
This is Phase 1 of the Foundry-agent interviewer refactor (epic #26), ported from
AI-avatar-vibe-coding and adapted to this repo.

### Added
- **User model + JWT auth** (`app/models/user.py`, migration `9a62a4b063ec`): users with role
  `admin`/`user`, bcrypt-hashed passwords, active flag.
- **Auth API** (`app/api/auth.py`): `POST /auth/login` (returns a JWT), `GET /auth/me`,
  `POST /auth/refresh`. `app/services/auth_service.py` handles hashing (bcrypt, used directly) + JWT
  (HS256, 24h). `get_current_user` / `require_role("admin")` dependencies.
- **Admin user management** (`app/api/admin_users.py`): list (search/role/active filters), get,
  patch, soft-delete — admin-only, cannot delete your own account.
- **Login UI** (`/admin`): username/password form calling the real login + an admin-role check;
  `frontend/src/api/auth.ts` client. The candidate anonymous-session path is untouched.
- **Optional default-admin seed on boot** — set `SEED_ADMIN_USERNAME`/`SEED_ADMIN_PASSWORD` to seed
  one admin; skipped when no password is set (no known-credential admin ships by default).

### Changed
- The existing `/admin/*` routes (personas, SOP, checklists, question banks) now require
  `require_role("admin")` (real JWT) instead of the shared `ADMIN_API_TOKEN`.

### Notes
- Two independent auth systems by design: candidate `AnonymousCandidateSession` (interview path,
  unchanged) and the new user/admin JWT (editor/config). Backend 280 tests / 87% cov; frontend 29
  tests; E2E 4 (login flow). All on mocks.
- Part of epic #26; the self-made config/LLM machinery is superseded and removed in Phase 2 (#28).

## 0.16.0.0 (2026-08-10)

Point the app at your own AI Foundry from the admin page — no `.env`, no restart. The `/admin` Azure
config panel now loads your resource's real model deployments and Foundry IQ knowledge bases and lets
you pick them from dropdowns; saving wires the interviewer agent, LLM scoring, and SOP retrieval to
that Azure config live. This completes the real-Azure integration (epic #18): upload SOP → AI
question bank + rubric → digital-human interview → SOP-cited scored report can now run end to end on
a customer's own Azure, all configured through the UI.

### Added
- **Config-page dropdowns.** The Azure panel gets a "Load models & knowledge bases" button that calls
  the two backend endpoints and renders model + knowledge-base as dropdowns (with a text-input
  fallback when a list is empty or the resource is unreachable), plus a knowledge-source field. The
  API key stays write-only/masked. Selecting and saving persists model + knowledge base + knowledge
  source to the DB config, which the overlay applies immediately.

### Notes
- Epic #18 (real-Azure integration) is complete: #19 (LLM adapter) + #20 (overlay + API endpoints) +
  #21 (this UI). Frontend 23 tests; backend 266 tests / ~88% cov; E2E 4 specs — all on mocks.
- Live-Azure validation (real model dropdown, real agent conversation, real SOP-cited scored report)
  is a manual Layer-3 check against a Foundry resource; see `docs/VERIFICATION.md`.

## 0.15.2.0 (2026-08-10)

The saved config page now drives real LLM scoring and SOP retrieval, and remembers which Foundry IQ
knowledge base to use. Saving an AI Foundry config with a model + knowledge base flips the LLM and
retrieval providers to Azure and re-registers the adapters live — so an interview scored after a save
uses the real model, and follow-ups/citations pull from the real Foundry IQ knowledge base, no
restart. Two new admin endpoints list the resource's real model deployments and knowledge bases so
the config page can offer them as dropdowns (wired into the UI in the next release).

### Added
- **Knowledge-base config** — `service_configs` gains `knowledge_base` + `knowledge_source` columns
  (migration `562c9adccffb`); `PUT /admin/config/ai-foundry` persists them and `GET` returns them.
- **`GET /admin/config/ai-foundry/model-deployments`** — lists the resource's model deployments
  (Foundry project-scoped API → legacy Azure OpenAI API → saved-model fallback; fail-soft, never 500).
- **`GET /admin/config/ai-foundry/knowledge-bases`** — lists Foundry IQ knowledge bases (api-key
  first, Entra fallback on 401/403; fail-soft).

### Changed
- **Config overlay now covers LLM + retrieval.** Applying the saved master config also overlays the
  Azure OpenAI fields (endpoint/key/deployment) and, when a knowledge base + source are set, the
  Foundry IQ search fields, then flips `default_llm_provider` to `azure_openai` and
  `default_retrieval_provider` to `azure` and re-registers those adapters.

### Notes
- Part of epic #18 (real-Azure integration), issue #20. The config-page dropdowns that consume the
  two new endpoints land in #21. Backend 266 tests / ~88% cov; migration reversible.

## 0.15.1.0 (2026-08-10)

Real Azure OpenAI LLM adapter. Interview scoring and "Draft from SOP" checklist generation can now
run against a real model deployment instead of the deterministic mock — so a scored report reflects
an actual model judgment. The adapter registers under the `azure_openai` provider and stays dormant
until selected (via `DEFAULT_LLM_PROVIDER=azure_openai` or the forthcoming config-page overlay); the
mock stays the default, so nothing changes for dev/CI.

### Added
- **`AzureLLMAdapter`** (`app/services/agents/adapters/azure_llm.py`) implementing the `LLMAdapter`
  protocol: `complete(prompt, *, json_mode)` runs an Azure OpenAI chat completion on the configured
  deployment (json_mode → `response_format={"type":"json_object"}`), returning the raw content
  string. Auth is API-key-first with an Entra (`DefaultAzureCredential`) fallback, api-version pinned
  `2024-06-01`. Registered by `registry._register_azure_llm()` (from `refresh_azure_adapters()`) only
  when `azure_openai_endpoint` + `azure_openai_deployment` are set.

### Notes
- Part of epic #18 (real-Azure integration). The adapter is the F3/F4 half; wiring it into the
  runtime path (overlay flips `default_llm_provider` from the saved DB config) lands in #20.
- Backend 259 tests / ~90% cov. The live adapter is coverage-omitted (`azure_*.py`) like the other
  Azure adapters — exercised against real Azure, unit-tested with a mocked client.

## 0.15.0.0 (2026-08-10)

DB-backed Azure service config + admin config page. The AI Foundry connection (endpoint, API key,
project, model) is now configurable at runtime and saved to the database, so an operator points the
app at their own Foundry project through the UI instead of editing `.env`. This closes a real gap:
`config.py` already claimed "DB-backed ServiceConfig is the source of truth" but that table was never
built — the model default `gpt-4o` (not deployed on the demo resource) then 404'd with no runtime
override. Config now resolves **DB > .env > code default**.

### Added
- **`service_configs` table + master AI Foundry row** (`app/models/service_config.py`, migration
  `9aa4493d2167`). A single master row holds endpoint / encrypted API key / default project /
  model, right-sized to this project's 4 services (LLM, retrieval, agent-sync, voice-live).
- **Admin config API** (`app/api/admin_config.py`, `require_admin`): `GET/PUT /admin/config/ai-foundry`
  (key write-only, returned masked) + `POST /admin/config/ai-foundry/test` (lightweight connectivity
  probe). `config_service` handles upsert + Fernet encryption; an empty key on save **preserves** the
  stored secret.

### Security
- **Endpoint allowlist (credential-exfil guard).** The saved endpoint must be an `https` first-party
  Azure host (`*.services.ai.azure.com`, `*.openai.azure.com`, `*.cognitiveservices.azure.com`,
  `*.search.windows.net`); anything else is rejected with **422** before the row is touched. Without
  this, an admin-token holder could point the endpoint at an arbitrary host and, because an empty key
  preserves the stored secret, make `/test` send the decrypted Azure key there (or probe internal
  metadata IPs). Now the key can only ever leave for an allowlisted Azure host.
- **Fail-closed encryption.** With `debug` off and `ENCRYPTION_KEY` unset, the app now refuses to
  encrypt/decrypt instead of falling back to a key derived from `SECRET_KEY` (which is a committed dev
  default) — so at-rest encryption of the stored API key is never silently cosmetic in production.
  Dev (`debug=true`) keeps the derived-key convenience.
- **Runtime overlay** (`app/services/config_overlay.py`): the saved master row is overlaid onto the
  `get_settings()` singleton at startup and after each save, then the Azure adapters are
  re-registered — so a config change takes effect **without a restart**. `registry.refresh_azure_adapters()`
  is the re-register seam.
- **Fernet encryption util** (`app/utils/encryption.py`) for at-rest secrets; `ENCRYPTION_KEY`
  setting (derives a stable dev key from `SECRET_KEY` when unset). `cryptography` is now a direct dep.
- **Admin config panel** in `/admin` (`AdminPage.tsx` + `api/admin.ts`): endpoint / project / model /
  write-only key inputs with Save + Test connection.
- **`backend/.env.example`** (committed, secret-free) documenting every knob for a live run, with the
  model-deployment gotcha called out; root `.gitignore` now also refuses `.env`/`.env.*` (allows
  `.env.example`) as defense-in-depth for this public repo.

### Notes
- Precedence is **DB > .env > code default**: production reads the saved config; `.env` fills gaps in
  dev; the neutral code default (`gpt-4o`) is the last resort. The earlier stop-gap of hardcoding
  `gpt-4o-mini` was reverted in favor of this real config layer.
- Backend 241 tests / ~90% cov; frontend 22 unit + 4 E2E. All on mock providers — zero Azure to
  build, test, or run the config page (the live effect is a Layer-3 manual check).

## 0.14.0.0 (2026-08-09)

Playwright end-to-end tests. The winning-demo path is now covered by real-browser E2E, on top of
the existing unit/component tests — driving both servers (backend + frontend) against mock
providers, so the full candidate and admin flows are verified in an actual Chromium, with zero
Azure.

### Added
- **Playwright E2E suite** (`frontend/e2e/`), 4 specs run serially against a fresh migrated SQLite
  DB and a known admin token:
  - Candidate text interview: land → orientation → answer → **F7 memory follow-up quoting the
    candidate's own words** → report.
  - P3 boundary: the candidate page never exposes checklist/rubric/expected_points.
  - Admin editor: sign in → create a default bank → add a question → draft its checklist
    (weights = 100), then a candidate interviews against it and reaches a **scored** report — the
    executive view's grade gauge and the SOP-source-beside-answer evidence are asserted, and the
    detail view discloses per-item judgments.
  - Voice with no microphone falls back to the mic-permission dialog (F9 AC #4) — never hangs.
- **`playwright.config.ts`** boots the backend (fresh DB + migrations + admin token + mock
  providers) and the frontend (vite dev proxying `/api` to the E2E backend) as managed web servers.
- **CI `e2e` job** installs both stacks + `chromium` and runs `npm run e2e` on every PR.

### Notes
- `E2E_API_TARGET` lets the frontend proxy point at the E2E backend port; vitest excludes `e2e/` so
  unit and E2E layers stay separate.
- Everything runs on mock providers — no Azure needed to run the E2E suite in CI or locally.

## 0.13.1.0 (2026-08-09)

Docs — `CLAUDE.md` now instructs future gstack planning documents to be promoted into the repo
`docs/planning/` (versioned, reviewable) rather than left only in local `~/.gstack` state. Codifies
the convention used to bring the existing planning trail into the repo in v0.13.0.0, so specs,
design docs, plans, and reviews keep travelling with the project. Machine-local logs stay in
`~/.gstack` by design.

## 0.13.0.0 (2026-08-09)

Digital-human avatar video + planning docs brought into the repo. The interviewer can now show an
actual avatar face (not just the audio orb) when Voice Live sends the digital-human video track,
and the project's planning trail (design doc, spec draft, autoplan review) now travels with the
repo instead of living only in local gstack state.

### Added
- **Avatar video (F5/F9).** When the interviewer persona has a character, the voice broker requests
  the `avatar` modality (`modalities: [text, audio, avatar]`) and flags `avatar_enabled`. The voice
  hook negotiates a recvonly video transceiver and attaches the incoming video track to a `<video>`
  element; the new `AvatarView` shows the avatar face once the track arrives and falls back to the
  audio orb for voice-only sessions (or while the avatar is still negotiating). So the interview
  always has a presence, and gets a real face when one is available.
- **Planning docs in the repo.** `docs/planning/` now holds the design/brainstorm doc, the
  pre-autoplan spec draft, and the autoplan review — promoted from local `~/.gstack` state so the
  full planning trail is versioned and reviewable. `docs/IMPLEMENTATION-STATUS.md` maps every
  feature to its shipped version and live-Azure validation state.

### Notes
- The avatar face requires Azure Voice Live to send the video track for the session; the
  voice-only orb remains the fallback and the always-present baseline.

## 0.12.0.0 (2026-08-09)

F2b + F3b — Admin editors. The business can now edit the interview question set and its scoring
checklists through an admin UI, not just the seeded defaults. This closes the last of the SPEC
scope; the interview app now covers all nine features plus both admin editors.

### Added
- **Question-bank editor (F2b).** Admin API + a `/admin` page: create banks, set the default,
  add / edit / delete / reorder questions. Questions carry their `expected_points` here (the
  interviewer-internal rubric link) — admin-only, never on a candidate response (P3).
- **Checklist editor (F3b, F3 AC #4).** Draft a checklist from the SOP, then edit its items
  (kind / text / weight / source) and save. Weights are re-normalized to sum 100 on every save
  (forbidden items → 0), so an edited rubric stays valid; the editor round-trips (save → reload).
- **Admin page** at `/admin`, gated by the shared admin bearer token (entered once, held in
  sessionStorage). Three panels: banks, the selected bank's questions, and the selected question's
  checklist. Utilitarian internal tool, separate from the candidate demo surface.

### Notes
- The admin API client (`api/admin.ts`) is deliberately separate from the candidate client so the
  admin bearer token can never ride on a candidate call.
- Service layer for both editors already existed (`question_service`, `checklist_service`); this
  adds the missing edit/delete/reorder/update operations, the admin routes, and the UI.

## 0.11.2.0 (2026-08-09)

Fix — the interviewer agent syncs against the **project-scoped** Foundry endpoint. Verified live:
an interviewer agent now creates, reads back, and deletes against the real Foundry project. This
clears the F5/P16 exit criterion for agent sync — the automatable metadata shape already passed CI,
and now the actual create round-trips against a live project.

### Fixed
- **Project-scoped endpoint.** `AzureAgentSyncAdapter` now builds the endpoint the SDK requires —
  `https://{account}.services.ai.azure.com/api/projects/{project}` — from the account endpoint plus
  the project name. The bare account endpoint returned 404 on every agents call (caught in a live
  sync, not by CI). Added a `project` parameter, wired from `azure_foundry_default_project`, and a
  unit test for the scoping (bare → scoped, already-scoped → unchanged, no-project → as-is).

### Validated live (2026-08-09)
- Interviewer agent create → get → delete against the `avarda-demo-prj` Foundry project via
  `DefaultAzureCredential` (az login). The MCPTool + `PromptAgentDefinition(tools=…)` shapes from
  v0.11.1.0 also build cleanly against the installed `azure-ai-projects` 2.4.0 SDK.
- Still pending: the KB MCP binding end to end needs Azure AI Search credentials (endpoint + index
  + a RemoteTool connection), which aren't in the current environment — the tool shape is correct
  and CI-tested, but the live agent↔KB retrieval call is unverified until those creds are present.

## 0.11.1.0 (2026-08-09)

Fix — the interviewer agent binds its SOP knowledge base over **MCP**, matching how AI Foundry
actually connects a Knowledge Base to an agent (the Portal's "Knowledge" section, Preview). The
v0.11.0.0 binding used an `azure_ai_search` tool shape that the live Foundry contract rejects; this
corrects it to the reference project's live-verified MCPTool contract before it could bite at demo
time (SPEC P15/P16).

### Fixed
- **Knowledge binding is now an MCPTool.** The agent carries an MCPTool pointing at the KB's
  `/knowledgebases/{index}/mcp` endpoint, filtered to the single `knowledge_base_retrieve` tool,
  with `require_approval="never"`. Authentication rides on a **RemoteTool** project connection
  (`project_connection_id`) — a CognitiveSearch/ApiKey connection returns 403, the trap the
  reference hit live. New `foundry_kb_mcp_connection` config names that connection.
- The pure tool-shape builder (`agents/knowledge_tool`) and its CI tests now assert the MCP URL and
  MCPTool fields; the SDK `MCPTool` construction stays in the coverage-omitted Azure adapter.

## 0.11.0.0 (2026-08-09)

F7 — Session memory + Foundry IQ knowledge binding. The interviewer now visibly remembers: a
follow-up question quotes what the candidate just said, then probes deeper. And the interviewer's
Foundry agent is bound to the SOP knowledge base, so its answers and follow-ups are grounded in the
SOP, not just the candidate-facing citation API. This is the last of the nine core features — the
interview flow is complete.

### Added
- **Memory-aware follow-ups (F7).** When a question owes a follow-up, the interviewer's prompt now
  opens by quoting the candidate's own prior answer ("You mentioned '…' — can you walk me through
  that?") before asking the deeper probe. The candidate sees this follow-up as their current
  question, so the memory moment is visible, and the quote is exactly what they said (sourced from
  the recorded turn). Bilingual lead-in.
- **Foundry IQ bound to the interviewer agent (P15).** The interviewer's Foundry prompt agent is
  now synced with the SOP knowledge base attached as an Azure AI Search knowledge-source tool, so
  the agent's own answers stay SOP-grounded. The tool definition is a pure, CI-tested shape (the
  index name and the distinct knowledge-source name are kept separate — the F1-spike distinction
  that a live 400 punished); an unconfigured KB simply syncs an ungrounded agent rather than
  failing.

### Notes
- Voice interviews additionally get memory "for free" from the Foundry prompt-agent's built-in
  conversation memory; the follow-up synthesis here is the deterministic, transport-agnostic
  version that also drives the text channel and CI.
- The live agent↔knowledge-source binding runs through the coverage-omitted Azure adapter (needs a
  live Foundry project); the tool-definition shape and the follow-up synthesis are fully CI-covered.

## 0.10.0.0 (2026-08-09)

F8 — Interview report. The scored interview now renders as a real report: a headline grade + score
gauge, a one-line strength/gap narrative, and — the demo's money shot — a rubric item's SOP source
quote shown side by side with the candidate's own words. Full per-question, per-item detail is one
click away. This turns the F4 scoring data into something a business leader reads at a glance.

### Added
- **Executive view (P14).** A circular score gauge with the A-F grade at its center, a 1-2 sentence
  narrative summarizing strengths and the main gap, forbidden-item warnings, and a side-by-side
  panel putting the SOP source quote next to the candidate's answer — the most legible proof that
  the scoring is grounded in the SOP, not invented.
- **Detail view.** Progressively disclosed per-question accordion; each item shows a colour-coded
  4-state judgment chip (met / partially met / not met / violated), its weight, the rationale, and
  both quotes.
- **Report narrative (backend).** A deterministic strength/gap summary built from the same per-item
  judgments the detail view shows, so the headline and the breakdown never disagree.
- **`ScoreGauge` component.** A dependency-free SVG gauge; colour tracks the grade band.

### Changed
- The interview page's scored phase, previously a flat coverage-percent list, now renders the full
  report. A question with no checklist authored still falls back to the minimal list.
- The report payload carries the new `narrative` field alongside the F4 `total_score` / `grade` /
  `warnings` / per-item judgments.

### Notes
- Bilingual (zh-CN + en-US) throughout, including the 4-state judgment labels.
- The narrative is deterministic (no extra LLM round-trip) so the headline is reproducible and free
  of latency at report time.

## 0.9.0.0 (2026-08-09)

F4 — Scoring engine. The knowledge→scoring chain is closed: a completed interview is now graded
answer-by-answer against each question's SOP-derived checklist, producing a 4-state judgment per
item with the SOP quote and the candidate's own words side by side, plus a weighted score and
grade. This is the SOP-traceable compliance scoring the demo leads with, and it replaces the Step-0
length-based stub.

### Added
- **4-state per-item judgment.** Every checklist item is judged `met` / `partially_met` /
  `not_met` / `violated`, each carrying a rationale, a verbatim span from the candidate's answer,
  and the SOP source quote + page it's graded against — the traceability that proves the RAG is
  real.
- **Weighted score + grade.** Item weights (F3 normalizes them to 100) produce a 0-100 question
  score (met=full, partially_met=half); the interview score is the mean across graded questions,
  mapped to an A-F grade.
- **Anti-hallucination rails (SPEC P7).** An empty or too-short answer can't score high (every item
  forced to `not_met`); a forbidden item the answer triggers is forced to `violated` with a
  warning; a judgment the model invents for an item not on the checklist is dropped; and if the
  model skips an item, scoring retries with a stricter reminder rather than silently under-counting
  coverage. The short-answer threshold is recalibrated for a single Q&A turn, not the reference's
  aggregate-transcript number.
- **Cross-language scoring (AC #4).** The judging prompt states the SOP, the answer, and the
  rationale may be in different languages and compares by meaning — an English SOP scores a Chinese
  answer.
- **Richer report.** The report now carries `total_score`, `grade`, forbidden-item `warnings`, and
  per-question per-item judgments with both quotes, alongside the existing coverage. Questions
  without a checklist authored yet still produce a stub row, so the report always covers every
  question.

### Fixed
- Provider registry falls back to the mock LLM/retrieval adapter when the configured default isn't
  registered (carried in from the F3 fix; the scoring path is the second consumer of the LLM
  adapter and would have hit the same 500).

### Security
- Scoring runs server-side; the rubric and its weights are never exposed to candidates. The report
  shows a candidate their own results (scores, judgments, source quotes), never the raw checklist.

### Notes
- CI + local dev score through the mock LLM (which returns a deterministic per-item judgment); the
  Azure adapter drives prod. The pure engine — rails, weighting, grade bands — is fully CI-covered
  without any Azure.

## 0.8.0.0 (2026-08-09)

F3 — Checklist (rubric). Each interview question can now have an AI-drafted scoring checklist:
required / recommended / forbidden items, each weighted and tied back to the SOP text it came from.
This is the rubric F4 scores against, and the source attribution is the traceability the demo
leads with. Admin-only — the rubric is never shown to candidates.

### Added
- **Checklist + item models.** `checklist` (per question, versioned, default flag) and
  `checklist_item` (kind, text, weight, source_quote, source_document, source_page, order). Items
  are first-class rows so each one is independently source-attributable and (F3b) editable.
- **AI drafting (AC #1).** `POST /admin/checklists/questions/{id}/draft` retrieves the question's
  SOP passages, asks the LLM to draft items with source quotes, gates the untrusted output (valid
  kinds only), and persists them. When the LLM yields nothing usable, it falls back to deriving
  required items from the question's expected points, so drafting is deterministic and useful with
  zero Azure.
- **Weights always total 100 (AC #3).** Item weights are normalized to sum to exactly 100 using
  largest-remainder rounding (never 99/101). Forbidden items are gates, not scored weight, so they
  sit at 0 and don't consume the budget.
- **Source-attributed items (AC #2).** Every item carries its kind, weight, and the SOP source
  (verbatim quote + page) it was drawn from.
- **Read endpoint.** `GET /admin/checklists/questions/{id}` returns the current default checklist
  with its items and weight total.

### Fixed
- **Provider registry no longer 500s on an unwired default.** When the configured default LLM or
  retrieval provider isn't registered (e.g. `azure_openai` set in the environment before the Azure
  adapter is wired), the registry now degrades to the mock provider with a warning instead of
  raising on every request. An explicitly-requested unknown provider still raises (that's a bug,
  not a deploy state).

### Security
- **No rubric leak (P3).** Checklists are admin-only and never appear in any candidate-scoped
  response, even after one is drafted for a question — a test asserts the candidate question list
  stays clean of checklist/rubric/weight/source fields.

### Notes
- Business editing of drafted checklists (F3b) is post-demo; drafting + read ship now.
- The real LLM drafting path runs through the same adapter seam as the rest of the app; CI + local
  dev use the mock adapter (which returns a checklist-shaped draft), the Azure adapter drives prod.

## 0.7.0.0 (2026-08-09)

F2 — Question bank. Interview questions now live in the database as an ordered, language-tagged
bank instead of a hardcoded pair. A candidate can fetch the ordered question list up front, and the
interview runs off the enabled default bank — the state machine reads from it with the Step-0
hardcoded set kept only as a zero-data fallback. Ten seeded demo questions ship by default.

### Added
- **Question bank + questions (AC #1).** New `question_bank` (name, description, language, enabled,
  is_default) and `question` (bank, order_index, text, language, expected_points, follow-up hook)
  models. Exactly one enabled default bank is DB-enforced (partial-unique index), mirroring the
  interviewer-persona invariant, so the interview always resolves "the" bank without guesswork.
- **Seeded demo bank.** Ten generic, role-agnostic questions are seeded as the default bank on
  first boot (idempotent — a no-op once a default exists). The interview immediately runs over them.
- **Candidate question list (AC #2).** `GET /candidate/interview/questions` returns the default
  bank's enabled questions in order. The interview state machine reads the same bank, so what a
  candidate previews is what they'll be asked.
- **Language respected (AC #4).** Bank and per-question language fields flow through to the API.

### Changed
- The interview state machine now resolves its questions from the default bank per turn (was a
  hardcoded in-code set). Progression, the follow-up hook, and answer grouping (F6) are unchanged —
  the follow-up columns moved onto the question row. With no bank seeded, a built-in two-question
  fallback keeps the spine runnable.

### Security
- **No rubric leak (P3).** A question's `expected_points` links to the scoring rubric and is never
  included in any candidate-facing response — the candidate question list and the in-interview
  question projection both omit it. A test asserts the absence.

### Notes
- Admin create/edit/reorder of banks (F2b) is post-demo; the service layer already supports it
  (`create_bank` / `add_question` / `set_default_bank`), the demo ships seed + read only.
- Real client SOP-derived questions and their expected_points load at deploy time; the repo carries
  only neutral placeholders.

## 0.6.0.0 (2026-08-09)

F1 — Knowledge base + traceability. An admin can now upload an SOP document and have it extracted,
chunked with page/section labels, and stored, so citations can point back to an exact location —
the traceability the demo leads with. The Foundry IQ retrieval gate (validated live in the F1
spike) is now wired behind an admin API. Local dev / CI run entirely on mocks; no Azure needed.

### Added
- **SOP upload + ingestion (AC #1).** `POST /admin/sop/documents` accepts a PDF / DOCX / PPTX /
  TXT / MD file, extracts text **segment by segment** (per PDF page, per PPTX slide), chunks each
  segment, and persists one `SopChunk` per chunk carrying that segment's page/section label. The
  raw bytes go to a pluggable blob store (local filesystem in dev, swappable for Azure Blob),
  never into the DB and never handed to candidates (P4).
- **Graceful failure (AC #4).** A corrupt or unsupported file is recorded as `status="failed"`
  with a 201 response — it never crashes the upload, so a bad file in a batch doesn't take the
  batch down. Extraction and each binary parser degrade to empty rather than raising.
- **Document listing.** `GET /admin/sop/documents` returns each ingested document with its chunk
  count — the admin knowledge-base view.
- **Citation retrieval (AC #2/#3).** `POST /admin/sop/retrieve` runs a query through the configured
  retrieval adapter (mock in dev/CI, Foundry IQ with creds) and returns only fully-attributed
  `{title, url, page}` citations. The strict field gate — drop any citation missing any required
  field — was proven against a live KB in the F1 spike and is reused unchanged; an empty result is
  the honest no-match signal, not an error.
- **Pluggable blob storage.** A local filesystem store (path-traversal guarded) with an `azure`
  slot for prod; selected by config, cached per process.

### Security
- All SOP routes are admin-only (shared bearer token, fail-closed). The raw SOP corpus and its blob
  pointers are interviewer/business internals (P3/P4); candidates only ever see server-mediated
  citation text later, never these routes.

### Notes
- Retrieval was validated live against a real Foundry IQ KB during the F1 spike (GO, 2026-08-08);
  this release wires that proven gate behind the API and adds the ingestion half. The live
  `retrieve` call and the binary parsers are coverage-omitted (need live creds / optional deps);
  the extraction dispatch, chunker, field gate, ingestion pipeline, storage, and API are all
  CI-covered on mocks.

## 0.5.0.0 (2026-08-09)

F9 — Frontend interview page, the winning-demo path. A candidate can now land on the interview
page, get a spoken/typed interview from the digital-human interviewer, and reach a report — the
F5 persona + F6 state machine finally have a face. Voice runs over a direct browser-to-Azure
WebRTC connection; the backend only brokers a short-lived credential, so candidate audio never
touches our servers.

### Added
- **Interview page (F9 AC #1-2).** Candidate lands anonymously, sees the interviewer as a
  state-reactive audio orb (idle / listening / speaking / muted), a question-progress dot-stepper
  (answered / active / remaining), and the current question pinned above the transcript. Layout
  follows the P11 hierarchy: presence dominant, question always visible, transcript secondary.
- **Two answer channels, one event (P9).** Text and voice both finalize through the backend's
  single `answer_finalized(text, source)` contract — text submits with `source=text`, voice with
  `source=voice`. A candidate can switch channels per question.
- **Voice hook (F9 AC #5).** `useInterviewVoice` opens an `RTCPeerConnection` (no ICE servers —
  Azure handles TURN), a `voice-live-events` data channel for transcripts/VAD, and a signaling
  WebSocket for the SDP handshake. A dropped connection auto-reconnects up to 3 times with
  1s/2s/4s backoff, then surfaces a clear failure and falls back to text.
- **Manual "I'm done answering" control + orientation beat (P13).** A pre-Q1 orientation screen
  sets expectations ("you'll answer N questions, take your time"), and the candidate always has an
  explicit end-of-answer button — never solely at the mercy of a silence heuristic.
- **Mic-permission recovery (F9 AC #4).** A denied microphone shows a retry / use-text-instead
  dialog; text input never stops working, so a blocked mic can't block the interview.
- **Scoring + report beats (P10).** After the last answer, a "analyzing answer N of M against the
  SOP" screen leads into a report-ready reveal.
- **Azure Voice Live broker (backend).** A new `POST /candidate/interview/{id}/voice/session`
  endpoint issues the browser everything it needs to reach Azure Voice Live directly: the signaling
  URL and a short-lived bearer. Credential issuance is Entra-first (Microsoft Entra / managed
  identity) with an API-key STS fallback, verified live against the Foundry endpoint on the GA
  `2026-07-15` api-version at the `/voice-live/realtime` path.

### Security & robustness
- **P5 gate — voice is rejected, not silently degraded.** An interviewer persona whose Foundry
  agent isn't synced yields a 409, and the page falls back to text (P6b) rather than connecting to
  an ungrounded model-mode session. The reference project's silent model-mode fallback is not
  inherited.
- **P3 / P12 — no rubric leak.** The voice-session response carries only transport + persona-
  cosmetic fields (voice, VAD, avatar, character, greeting). No checklist, rubric, weight, or SOP
  text ever reaches a candidate; citations stay out of the live Q&A entirely (they belong to the
  report phase). A CI test asserts the absence.
- Ownership-guarded (a candidate can only broker voice for their own interview) and
  anonymous-session-gated, matching the rest of the candidate API.

### Notes
- Local dev / CI run on a mock voice provider — the whole page + broker flow is exercisable with
  zero Azure. The Azure credential path is coverage-omitted (needs a live endpoint) but was
  smoke-tested end to end against the real resource.
- Tests immune to a developer's `backend/.env`: provider selection is pinned to mock in the test
  harness so local runs match CI (SPEC P2).

## 0.4.1.0 (2026-08-08)

F6 — Turn-by-turn interview state machine, completed to all five ACs. The Step 0 spine (ask →
answer → advance → report over one channel-agnostic event) gains the follow-up hook and verbal
end-of-answer cue. No migration: `follow_up` turn_kind already existed and question follow-up
config is in-code (Step 0 question set).

### Added
- **Follow-up hook (AC #4).** A question may generate up to `max_follow_ups` follow-up turns
  (demo default 0/1). After a candidate answers, if a follow-up is owed the state machine records
  a `follow_up` interviewer turn and stays on the question; the next answer is a `follow_up`
  candidate turn. Progression (`asking → answering → follow_up×0..N → judged → next`) is derived
  from recorded turns, so it survives restarts. Demo q2 now carries one follow-up so the hook is
  exercised end-to-end.
- **Answer grouping (AC #4).** `scoring.group_answers` groups a question's candidate turns (main +
  0..N follow-up) into ONE answer, so a question with a follow-up is scored once, not twice — the
  report keeps exactly one entry per question.
- **Verbal end-of-answer cue (AC #3).** `interview.verbal_cue` — pure, CI-tested detect/strip for
  zh + en cue phrases ("我答完了" / "done" / …), matched only as a trailing terminator so
  cue-like words mid-answer are left intact. When `source=verbal_cue`, the cue is stripped from
  stored/scored content (it's transport signalling, not answer substance). Silence-timeout
  advancement remains native Voice Live EOU detection in the transport layer (F9), not backend
  logic.

### Notes
- Channel-agnostic contract (P9) unchanged: text, voice, and verbal_cue still converge on the
  single `answer_finalized(text, source)` event.
- Interview modules (`state_machine`, `scoring`, `questions`, `verbal_cue`) at 100% coverage.

## 0.4.0.0 (2026-08-08)

F5 — Interviewer digital human. A persona model + admin API configure the interviewer's identity,
voice knobs, and Foundry prompt-agent binding, with the demo-critical Voice Live metadata shape
verified in CI (no Azure needed to run or test).

### Added
- `InterviewerPersona` model + migration `b0fdc500f6d5` with a **partial-unique index**
  (`enabled = 1 AND is_default = 1`) so exactly one enabled default can exist — the invariant is
  DB-enforced, not app-enforced.
- `voice_live_metadata` — a pure, provider-agnostic, 100%-covered builder that owns the exact
  bytes of `microsoft.voice-live.*` agent metadata: snake_case `session` object, disabled caps as
  explicit `null` (EOU sub-object omitted when off), 512-char chunking across `.1`/`.2`/… keys,
  and a `decode_*` inverse for round-trip tests. This is the **guard for the F1 spike Trigger C
  silent failure** — a camelCase key drift turns Portal Voice mode OFF, and now fails CI here
  instead of at demo time.
- `persona_service` — CRUD + one-default enforcement (prefetch-before-flush, SPEC P8) + agent
  sync status transitions (`none`/`pending`/`synced`/`failed`).
- `AgentSyncAdapter` protocol with a `mock` provider (CRUD runs with zero Azure) and a
  coverage-omitted `azure` adapter (DefaultAzureCredential → API-key fallback; create-500 →
  probe-and-update recovery; immutable-agent `create_version` semantics).
- Admin persona API (`/admin/personas`) behind a fail-closed shared-bearer-token guard
  (`require_admin`) — persona config is interviewer-internal and off-limits to candidate sessions
  (SPEC P3/P4). Sync runs inline; a sync failure is a recorded `agent_sync_status=failed` state,
  never a 500 (F5 AC #4).

### Config
- `default_agent_sync_provider` (mock), `foundry_project_endpoint`, `foundry_agent_model`,
  `foundry_api_key`, `admin_api_token` — all default-empty so the app boots with zero Azure.

## 0.3.1.0 (2026-08-08)

F1 spike live-validation — ran the `retrieve` contract against a real Foundry IQ knowledge
base. **Verdict: GO.** The live run corrected three bugs in the reference contract that would
each have silently broken every grounded turn.

### Fixed (reference contract bugs, found live)
- `knowledgeSourceParams.knowledgeSourceName` must be the KB's *knowledge source* name, not the
  index/KB name (the reference passed the index name → HTTP 400). Added
  `azure_search_knowledge_source` config + adapter param.
- `sourceData` is `null` unless the request sends `includeReferenceSourceData: true`; the
  adapter now always sends it.
- `sourceData` fields are per-index (no universal `title`/`url`/`page`). The citation gate is
  now field-configurable (`required_fields` + `field_map`) while keeping the strict
  all-fields-or-drop invariant.

### Added
- `backend/scripts/smoke_retrieve.py` — standalone live `retrieve` smoke test (not in CI; reads
  `AZURE_SEARCH_*` from a gitignored `.env`, auths via key or Azure CLI Entra token).
- Field-map + custom-required-field tests for the gate; SPIKE.md updated with the live findings
  and GO verdict.

## 0.3.0.0 (2026-08-08)

F1 Foundry IQ traceability spike — the code-contract half of de-risking the citation
`retrieve` dependency (SPEC §6, highest risk). Live-validation half deferred to the client's
demo Azure env. All mock/stub-backed; zero Azure required to run or test.

### Added
- SOP models (`SopDocument` + `SopChunk`, SPEC F1) with page/section labels for traceability,
  plus Alembic migration.
- Strict citation full-field gate (`agents/citations.py`, SPEC F1): keeps a citation only if
  `title`+`url`+`page` all present; partials silently dropped; empty = no-match signal. Pure,
  provider-agnostic, 100% CI-covered.
- Azure retrieve adapter (`adapters/azure_retrieval.py`, coverage-omitted): ports the reference
  `retrieve` call shape (`api-version=2026-05-01-preview`); registers only with live creds.
- SOP text-extraction dispatch + overlapping section-aware chunking (`app/sop/`); binary
  parsers (pdf/docx/pptx) isolated in a coverage-omitted module; dispatcher degrades to `""`
  on any failure (never raises).
- `docs/SPIKE-F1-foundry-iq.md`: go/no-go as fallback triggers (P15) + deferred live-validation
  checklist (P16), including the camelCase-metadata Voice-mode trap and the AI Search
  `/docs/search` GA fallback path.

### Fixed
- Retrieval adapter selection keyed on `default_voice_provider` (wrong capability); added a
  dedicated `default_retrieval_provider` setting.

## 0.2.0.0 (2026-08-08)

Step 0 completion — frontend skeleton + end-to-end thin slice (ask → answer → placeholder
report), all mock/stub-backed (no Azure required to run).

### Added
- Interview state machine (SPEC F6): `InterviewSession` + `InterviewTurn` models, status
  lifecycle (created→in_progress→completed→scored), and the single channel-agnostic
  `answer_finalized(text, source)` event (SPEC P9) shared by text/voice/verbal-cue sources.
- Two hardcoded interview questions + deterministic stub scoring with the fixed 4-state
  judgment vocabulary (`met | partially_met | not_met | violated`) and coverage aggregation.
- Candidate-guarded interview API (`/candidate/interview/start|{id}/answer|{id}/report`) with
  IDOR ownership checks (a candidate can only drive their own interview; 404 hides existence).
- Alembic migration for the interview tables.
- Frontend skeleton: React 18 + TS + Vite 6 + Fluent UI v9 + TanStack Query + React Router +
  i18next (zh-CN/en-US). Interview page drives the thin-slice loop over the text channel;
  language switcher; typed API client with anonymous-session handling.
- Frontend CI job (typecheck + eslint + vitest + build) and Vitest tests for the API client
  and interview page.

## 0.1.0.0 (2026-08-07)

Step 0 skeleton — backend foundation + CI, all mock-backed (no Azure required to run).

### Added
- FastAPI backend scaffold: config (pydantic-settings), async SQLAlchemy 2.0 + SQLite,
  health endpoint, ruff + pytest tooling.
- Provider adapter layer: LLM + retrieval protocols, mock adapters (default local/CI
  providers, zero Azure), and a name-keyed registry. `DEFAULT_*_PROVIDER=mock`.
- Anonymous candidate session auth: JWT (`typ=anon` + `sid`), `X-Anon-Session` header,
  DB-row-authoritative expiry/revocation, session-create endpoint.
- Alembic async migrations + first migration (anonymous_candidate_sessions).
- CI hard gate (GitHub Actions): ruff lint + format check, migrations apply, pytest with
  85% coverage gate. In-memory SQLite test doubles.
- SPEC.md: full 9-feature technical spec (post /office-hours → /spec → /autoplan review).
