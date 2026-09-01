# Changelog

## 0.35.0.1 (2026-09-01)

### Fixed
- **Agent editor "Language" selection now persists across a page refresh.** In `/admin/agent`,
  changing the Language dropdown (and its per-locale Speech voice / Greeting view) then saving
  showed "Saved." and correctly bumped the persona version — but a refresh reverted the dropdown to
  `zh-CN`. Root cause: the editor's active locale was **ephemeral React state** (`activeLocale`,
  initialized to the first locale on every mount), never part of the persona payload — so it was
  neither saved nor restored, while the underlying `voice_map`/`greeting_map` (both locales) were in
  fact persisted correctly. Added a real persisted `default_locale` field on `InterviewerPersona`
  (Alembic migration, `server_default="zh-CN"` backfills existing rows), wired through
  `PersonaCreate`/`PersonaUpdate`/`PersonaOut` and the frontend form mappers, and made
  `form.defaultLocale` the single source of truth for the selector (removing the ephemeral state).
  The selected language now round-trips with the persona version. The reconcile-from-Foundry path
  was verified not to touch `default_locale` (or `voice_map`/`greeting_map`/voice knobs), so a saved
  locale survives editor re-open. A full four-layer audit confirmed no other persona config field
  had this save→load defect.

## 0.35.0.0 (2026-09-01)

### Added
- **Boot-time seed of the AI Foundry master config from env (admin config panel reflects the live
  runtime after a restart).** New `seed_master_config_from_env` in
  `backend/app/services/config_service.py`, wired into the FastAPI lifespan (`main.py`) as a
  best-effort boot step. The `service_configs` table lives in the deployment's **ephemeral SQLite**,
  so a saved master config is wiped on every restart even though the connection env vars
  (`AZURE_FOUNDRY_ENDPOINT` / `FOUNDRY_AGENT_MODEL` / …) persist on the Container App. Runtime calls
  already fall back to env, so the connection *worked* — but the `/admin/config` panel reads only
  the DB row and would show "not configured" after every boot. Seeding the row from env on boot
  makes the panel reflect the live runtime config. Idempotent and non-destructive: a **no-op when a
  master row already exists** (never clobbers an operator's saved config) and a no-op when env
  carries no Foundry endpoint (mock / public-demo deploys stay unconfigured). Seeded **key-less** —
  the deployment authenticates to Foundry via managed identity, and `resolve`/overlay supply creds
  Entra-first.

## 0.34.0.0 (2026-08-27)

### Added
- **Boot-time seed of the default interviewer persona (voice works out of the box on the ephemeral
  public demo).** New `backend/app/services/persona_seed.py` recreates the enabled default
  "Interviewer" persona on every startup — the public deployment runs on ephemeral SQLite reseeded
  each boot, so a persona created in the online editor would otherwise vanish on restart, leaving
  voice unavailable (`VoiceUnavailable`) and the agent editor on its empty state. Wired into the
  FastAPI lifespan (`main.py`) as a best-effort seed that never blocks startup. The seeded
  `prompt_fragment` is the generic multilingual interviewer contract (no client wording, roles, SOP
  sections, or KPI thresholds); voices are neutral Azure built-ins.
- **Stable Foundry agent across reboots (no orphan accumulation).** The seed pins a **fixed persona
  id** equal to the operator's local default persona id. Because the sync adapter derives the agent
  name from the persona id (`interviewer-<id>`), reusing the id makes the boot sync a
  create-or-update against the *same* Foundry agent every time, instead of minting a fresh orphan
  agent on each ephemeral-DB boot. Seeding `model=None` lets `settings.foundry_agent_model` (the
  deployment's `FOUNDRY_AGENT_MODEL`) govern, so no model is hardcoded that a given Foundry resource
  may lack. Idempotent — a no-op when an enabled default already exists, so a restart never
  duplicates it or fights the single-enabled-default invariant.
- **Background Foundry sync on boot.** `main.py` launches `sync_default_persona` as a background task
  (voice's P5 gate requires `agent_sync_status == "synced"`); a slow or absent Foundry never delays
  boot, and a sync failure degrades the persona to text-only rather than crashing startup.
- **Editor auto-selects the default persona on entry.** `AgentEditorPage.tsx` now auto-selects the
  enabled default (fallback: first persona) once after the first list load, via a `useRef`-guarded
  one-shot effect so a later background refresh (e.g. after Save) never yanks the operator off a
  persona they've switched to or a "New persona" draft.

## 0.33.0.0 (2026-08-26)

### Added
- **Full CI/CD deployment to Azure Container Apps (Sweden Central).** New `infra/azure/` Bicep
  (subscription-scope `main.bicep` + modules) provisions the resource group, Log Analytics/App
  Insights, a user-assigned managed identity, Basic ACR, a keyless Storage account (private
  `client-bundle` + `materials` containers), the Container Apps environment +
  backend/frontend apps, a GitHub OIDC federated deploy identity, and all role assignments. **No
  AI-resource creation** — the existing Foundry / Voice Live resource is reused; the backend MI is
  granted access on it out-of-band by `infra/azure/scripts/grant-foundry-rbac.sh` (cross-RG).
- **Managed-identity, keyless auth end to end.** Both apps run as a user-assigned MI
  (`AZURE_CLIENT_ID` selects it for `DefaultAzureCredential`); GitHub Actions deploys via OIDC with
  no stored cloud credentials. The four runtime secrets are delivered as **Container App native
  secrets** (encrypted at rest by the platform) rather than Key Vault `secretRef`s: the target
  MCAPS subscription's Azure Policy force-disables Key Vault public network access (reverts within
  seconds of any write), which a VNet-less Container App cannot reach. The secrets still never enter
  the repo — they are passed as `@secure()` Bicep params from the gitignored `main.parameters.json`.
- **Boot-time self-seeding for ephemeral SQLite (no DB PaaS).** New `backend/entrypoint.sh` runs
  `alembic upgrade head` → optional private-blob client-bundle fetch + import
  (`backend/scripts/fetch_client_bundle.py`, MI auth) → `exec uvicorn` (lifespan seeds the generic
  demo bank + admin). Replaces the reference's separate bootstrap Job, which can't seed a per-replica
  ephemeral DB. `CLIENT_BUNDLE_BLOB` unset → public-demo mode (generic bank only). **This first
  deploy ships in public-demo mode:** the same subscription policy that disables Key Vault also
  force-disables the Storage account's public network access, so the "private blob pulled at boot"
  client-bundle channel is unreachable from a VNet-less Container App. Seeding the real rf-CSM client
  bank is deferred to a follow-up that adds a Storage private endpoint + VNet-integrated Container
  Apps environment.
- **Containerization.** New `backend/Dockerfile` + `frontend/Dockerfile` (node build → nginx serve)
  and `frontend/nginx.conf` (SPA fallback + `/api` reverse-proxy with WebSocket upgrade for Voice
  Live). New `.github/workflows/deploy-app.yml` (OIDC → `az acr build` → `az containerapp update` →
  health check) and `.github/workflows/infra-main.yml` (`az bicep build` + `bash -n`).

### Security
- `backend/.dockerignore` excludes the gitignored client importer, its test, and
  `EU_avatar_inspector_interview/` so a local `docker build` produces the same client-free image CI
  does; client content is designed to reach the container only via the private `client-bundle` blob
  pulled at boot (deferred this release — see above). Deploy parameters
  (`infra/azure/main.parameters.json`) are gitignored — only the placeholder `*.example.json` is
  tracked.

### Docs
- New `infra/azure/README.md` (one-time setup + IaC reference) and
  `docs/planning/spec-azure-cicd-deploy.md` (promoted plan). `docs/IMPLEMENTATION-STATUS.md` gains an
  "Azure CI/CD deployment (v0.33.0.0)" section.

## 0.32.0.0 (2026-08-25)

### Added
- **Scoring now shows the grader the fuller SOP passage behind each rubric item (feature C, on by
  default).** At scoring time, every checklist item that links a source document gets its fuller
  original SOP passage — reassembled from `SopChunk` by `source_document_id` + `source_page` — 
  appended to the judging prompt, instead of only the one-line `source_quote`. This addresses the
  client's concern that a grader seeing a single short quote might misread a criterion. **The scoring
  engine is unchanged:** the reassembled passage only enriches the prompt and never enters
  `enforce_and_score`, so the same set of judgments always yields the same score (rails + weighting
  are byte-identical). A `max_chars` guard (~600 chars/item) bounds token cost.
- **Optional "SOP coverage check" the candidate can tick before submitting (feature D, off by
  default).** On the review screen, a switch — *"Also run an SOP coverage check"* — lets the
  candidate opt into an advisory audit that compares the rubric against the original SOP text and
  lists *"SOP points the checklist may not cover"*, appended to the report for reference only. It
  **never affects any score**: per-question scores and the total are byte-identical whether or not
  it is enabled. Default off means zero extra LLM calls and behaviour identical to before. A parse
  failure or missing SOP text degrades silently to "no findings" rather than erroring the report.

### Docs
- Rewrote §4 of `docs/planning/knowledge-evaluation-explainer.zh-CN.md` (client briefing) from
  "optional proposals" to the shipped state: C default-on, D opt-in (default off), both explicitly
  non-scoring, with D's toggle location and the "does not affect the score" wording for client
  conversations.

## 0.31.2.0 (2026-08-24)

### Changed
- **The voice interviewer stays on the question and won't over-probe.** The default digital-human
  interviewer contract now bounds its free-form follow-ups: at most **one short follow-up per
  question**, and it must **stay on the system's current question** — it may not invent new
  questions, wander to another topic, or change the subject on its own (the system decides which
  question comes next). If it does drift, it briefly acknowledges and returns to the original
  question. This fixes the demo behavior where the voice agent occasionally asked an off-topic
  follow-up and then had to self-correct mid-interview.
- This only affects personas that use the auto-generated default instructions (no custom
  `prompt_fragment`); an operator's custom instructions are never overridden. It is a
  prompt/behavior bound only — **scoring is unchanged**: follow-up *questions* are never graded, an
  answered follow-up still folds into that question's single answer group, and an unanswered
  follow-up neither penalizes nor alters the score (SPEC F6/F7).
- **Applies on next persona sync.** The tightened contract is pushed to Foundry when the persona is
  next synced (edit + save the persona in `/admin/agent`, or the reconcile-on-open path); an agent
  already synced in a live environment keeps its previous instructions until then.

## 0.31.1.0 (2026-08-24)

### Added
- **Report citations are now clickable — open the original source file in the browser.** In the
  final evaluation report, each SOP citation that is backed by a source document is a link: clicking
  it opens that document in a new tab so the candidate can read the original file, instead of seeing
  only a filename and section label. Both the executive-view side-by-side evidence and the
  per-question detail rows link through. Citations without a linked document still render as plain
  text.

### Security
- **Scoped access, not an open door.** A candidate can open *only* the specific documents cited by
  *their own* scored report. The endpoint that serves a source file
  (`GET /candidate/interview/{id}/sop/{document_id}`) enforces two guards, each returning an
  identical `404` so it never reveals which documents exist: (1) the interview must belong to the
  caller's session, and (2) the requested document must actually be cited by a question that
  interview answered. The raw storage path is never exposed, and the browser fetches the bytes with
  the candidate's session header (not a URL that carries the token), previewing the file inline.
  This is a deliberate, narrow relaxation of the SOP-privacy boundary (SPEC P4a), post-scoring only
  — it does not change the live-interview rule that citations are never shown mid-answer (P12).

## 0.31.0.2 (2026-08-24)

### Fixed
- **The digital-human interviewer now reads each question exactly once.** A question was sometimes
  spoken (and shown as a transcript bubble) two or three times. Under server-VAD, Azure Voice Live
  auto-creates a response when the candidate stops speaking, and several internal routes lead back
  into the "read this question" path — the idle speak, the `response.done` flush that fires on
  *every* done event, and the collision re-queue — so the same backend question was re-emitted as a
  fresh `response.create` on successive `response.done` events and Azure voiced it 2–3 times. Added
  a per-text idempotency guard (`spokenTextRef` in `useInterviewVoice.ts`): a question that a live
  `response.create` already accepted is never re-read, while a genuinely *rejected* attempt
  (`conversation_already_has_active_response`) still gets exactly one retry, and the guard resets on
  disconnect so a reconnected session re-reads the current question. A stray collision error arriving
  after a question was accepted can no longer resurrect it into the pending-speak slot.

## 0.31.0.1 (2026-08-24)

### Changed
- **The interview now defaults to English.** A first-time visitor (no saved language preference)
  gets an English UI and, more importantly, an English-speaking digital-human interviewer — so an
  English question bank no longer gets read out and evaluated in Chinese by default. The language
  picker still switches to 中文 at any time, and a returning visitor keeps whatever they last chose.
  Under the hood this flips three defaults that all fed the old zh-CN fallback: the i18next initial
  language (`i18n.ts`), the voice-connect locale fallback (`useInterviewVoice.ts`), and the backend
  voice broker's `DEFAULT_LOCALE` (`voice_broker.py`), which the interviewer persona resolves as
  "the candidate's language."

## 0.31.0.0 (2026-08-24)

### Added
- **Interview reports now give a clear overall rating instead of a letter grade.** Every scored
  report leads with one of three ratings — **达到预期 / Meets Expectations**, **有待改进 / Needs
  Improvement**, or **未达预期 / Does Not Meet** — shown as a colour-coded badge beside the score
  gauge, which now takes its colour from the rating. The numeric score and detailed breakdown are
  still there; the rating just makes the bottom line legible at a glance for a non-expert reviewer.
- **A critical mistake caps the rating, with the reason shown.** When an answer contradicts the
  authoritative SOP, invents a procedure, oversteps the role, mishandles a safety/compliance risk,
  or states a guess as fact, the overall rating is held at **有待改进 / Needs Improvement** no matter
  how high the raw score — and the report explains that it was capped and why.
- **Known, unverified source conflicts are disclosed, not penalised.** Where the source material
  itself is known to disagree with itself and hasn't yet been validated by the owner, touching that
  point raises a neutral **披露 / Disclosure** note for transparency — it is deliberately *not*
  treated as a failure and does *not* lower the rating.
- **Six-dimension scoring rubric.** Questions can now be scored on a uniform weighted rubric —
  factual/procedural accuracy, completeness, role/accountability boundary, evidence/traceability,
  risk judgement/escalation, and clarity — so the report reflects *how* an answer fell short, not
  just a single number.
- **Per-question weighting.** Questions can carry a weight so the interview total is a weighted
  average, letting more important questions count for more (defaults to equal weighting — existing
  interviews score exactly as before).
- **Deploy-time importer for a real inspection-interview bank.** A local operator script ingests a
  supplied document set (PDF/DOCX/text), builds the interview bank as the default, and wires each
  question's rubric to the exact source document it cites — all into the local database. The script,
  the supplied content, and the database all stay local; none is committed to the repository.

### Changed
- The interview-level score is now a **weighted mean** of per-question scores rather than a simple
  average (equal weights reproduce the previous number exactly).

## 0.30.3.0 (2026-08-19)

### Fixed
- **The admin pages now ask you to log in instead of silently failing.** Returning to `/admin` or
  `/admin/agent` after your session had expired used to show the workspace as if you were still
  signed in, then quietly break: the persona list and config never loaded, and the browser console
  filled with `401 Unauthorized` errors with no login prompt in sight. The pages now verify your
  saved sign-in the moment they open — showing a brief "正在验证登录状态…" check — and drop you to
  the login form whenever it's no longer valid, so you get a clear way back in instead of a dead,
  half-loaded screen. No protected data is requested until you're actually authenticated.

## 0.30.2.0 (2026-08-19)

### Fixed
- **The digital human speaks every question again (数字人不说话).** In avatar voice mode the
  interviewer's next question would appear as text in the transcript but was never read aloud —
  the candidate saw a silent avatar mid-interview. Root cause: with server-side voice activity
  detection, Azure automatically starts a spoken response the moment the candidate stops talking.
  When the candidate then tapped **我答完了 / I'm done** and the app asked the avatar to read the
  next question, that request collided with Azure's already-running response and was rejected
  (`conversation_already_has_active_response`); the rejection was never retried, so the question
  went unspoken. The app now cancels any in-flight response first, queues the exact question text,
  and speaks it as soon as the current response finishes — always reading the latest question
  (rapid taps collapse to the newest), and re-queuing automatically if a collision still slips
  through. The manual "keep talking" nudge no longer fires while a response is already active.

## 0.30.0.0 (2026-08-19)

### Fixed
- **Voice answers no longer report "未作答" or land on the wrong question.** Both defects traced to
  one frontend race: STT transcription is async — the user's transcript arrives only via Azure Voice
  Live's `conversation.item.input_audio_transcription.completed` event, on a server round-trip *after*
  the candidate taps "我说完了". `InterviewPage` used to read the transcript synchronously right after
  `commitAnswer()` and POST immediately, so each question submitted the **previous** turn's transcript
  (empty for Q1) then auto-advanced — producing both the blank answer and the whole-set off-by-one
  shift. `commitAnswer()` now returns a `Promise<string>` that resolves **this turn's** finalized
  transcript (or `""` on an 8s timeout / teardown — fail-closed, never hangs the UI), and the page
  submits the awaited text. The backend was never wrong (answers pair to questions by explicit
  `question_id` at every hop), so fixing the race makes the ordering defect disappear on its own.

### Added
- **Pre-scoring review phase — finishing the last question no longer auto-scores.** A new `review`
  phase (`GET /candidate/interview/{id}/review` + `ReviewView`) shows every question with the
  candidate's own finalized answer in bank order; scoring starts only on an explicit
  **提交并评测 / Submit & evaluate** click, so the candidate can review the whole set holistically
  first. Entering `review` also releases the mic (`voice.disconnect()`).

### Changed
- **Empty answers are rejected at three layers.** Frontend voice gate (`!spoken.trim()` shows a
  retryable notice, no advance), frontend text gate (submit button `disabled`), backend Pydantic
  `AnswerIn` validator → 422, and a defensive `answer_finalized` empty-content guard → 409. The
  backend guard also fixed a real bug: a `verbal_cue` message that is only the cue (e.g. "我答完了")
  strips to empty and used to be accepted silently.

See [`docs/planning/spec-voice-transcript-race-explicit-submit.md`](docs/planning/spec-voice-transcript-race-explicit-submit.md).

## 0.29.1.0 (2026-08-18)

### Changed
- **`/admin` refactored into a two-tab workspace.** The page was a single vertical stack of
  inline-styled cards (Azure connection on top, then banks/questions/rubric), which put the
  low-frequency runtime config above the high-frequency content work and left the styling out of step
  with the rest of the app. It's now a controlled `TabList` with **题库与评分标准 / Content** and
  **Azure 连接 / Connection** tabs; the scoring rubric stays as an inline panel under the selected
  question (not a separate tab). Migrated from inline styles to the project's Fluent
  `makeStyles`+`tokens` baseline (matching `InterviewPage`) for consistent spacing, radius, borders,
  and status colors.
- **Rubric editor polish.** The inline checklist editor gains a weight-total bar (green at exactly
  100, amber otherwise), kind-color Badges (required / recommended / forbidden), a read-only
  `source_quote` display (admin-only surface, P3-safe), and save/generate status feedback.
- **Cross-navigation between the two admin surfaces.** A top-bar link routes between `/admin`
  (banks + rubric) and `/admin/agent` (the digital-human persona editor), so they're no longer only
  reachable by hand-editing the URL.

No backend or API-contract change; all existing `data-testid`s preserved.

## 0.29.0.0 (2026-08-18)

### Added
- **Digital-human self-heal — the avatar recovers from a media-layer drop instead of falling to the
  orb forever (数字人掉成球且回不来).** The avatar's video/audio ride a *separate* `RTCPeerConnection`
  from the main Voice Live WS, so the WS-close reconnect never covered an avatar-only media drop
  (TURN relay churn, NAT rebind, Azure ending the track between turns). Before, `oniceconnectionstatechange`
  only logged and `track.onended` flipped straight to the orb with no path back — one blip meant orb
  for the rest of the session. Now `useAvatarStream` recovers on its own: a transient ICE
  `disconnected` gets a 3s grace window (no orb flash if it self-heals); an ICE `failed`, an ended
  track, or a grace window that expires still-down triggers a bounded re-handshake (rebuild the PC,
  re-send `session.avatar.connect`, await a fresh `server_sdp`) reusing the last ICE servers, up to
  3 attempts with 500/1500/3000ms backoff. A generation counter supersedes stale in-flight recoveries
  on `disconnect()`/reconnect, and the recovery budget resets once real frames paint again. Covered
  by a new `useAvatarStream.test.tsx` regression suite (failed→rebuild, transient→no-rebuild,
  disconnect cancels rebuild, bounded attempts).
- **Voice status legend on the live interview screen.** In voice mode the four audio states
  (Ready / Listening / Speaking / Muted) render as a strip of tip cards under the header — each with
  a one-line explanation — and the live state is lifted out of the dimmed row so the candidate can
  read what each state means *and* see which one is active. Hidden in text mode (no live audio state
  to describe). New bilingual `voice.statusLegendLabel` + `voice.statusTips.*` strings.

### Changed
- **Question progress is a full-width, dynamic rail.** The old centered dot-cluster is now a
  fraction label plus a rail that flex-grows to fill the top bar, with an animated gradient fill that
  eases toward the current question and a gently pulsing active dot — it reads as progress and no
  longer hugs one side as the question count grows.
- **Removed the redundant live-state badge from the top bar.** The status legend already names and
  highlights the current voice state, so the second badge in the top-bar center was redundant and
  stole room the question progress needs. The top bar is now progress (left) · channel switch (right).
- **Avatar video fills the stage (`object-fit: cover`).** The stage no longer hugs the reported
  video aspect ratio; it fills the full grid height (`box-sizing: border-box` so vertical padding is
  counted in `height:100%`), and the 16:9 stream is `cover`-fit — cropping the figure's wide white
  side margins, never the centered person — so there are no dark letterbox bands and the stage stays
  bottom-aligned with the control column.

## 0.28.1.2 (2026-08-18)

### Docs
- **`docs/IMPLEMENTATION-STATUS.md`: voice full path marked live-validated on the WS-proxy transport.**
  Records that after the v0.26 migration to the backend Voice Live WS proxy, the full voice turn was
  re-verified live (2026-08-18, `ai-foundary-hu-sweden-central2`) via the opt-in Playwright fake-mic
  E2E: `proxy.connected` → `session.updated` with `avatar.ice_servers` → transcript deltas, 1080p
  avatar video, KB `mcp_list_tools` called, no fallback. Docs-only.

## 0.28.1.1 (2026-08-18)

### Fixed
- **Live voice E2E (`voice-live-azure.spec.ts`) matches the current transport.** The opt-in
  `LIVE_VOICE=1` spec still asserted on the pre-v0.26 browser-direct `voice-live/realtime` WebSocket,
  so it timed out with "signaling frames seen: []" against the current build — a stale-test failure,
  not a voice regression. Voice was migrated to a backend WebSocket proxy (`voice_live_proxy.py`) in
  v0.26, so the browser now opens a single `/api/voice-live/ws` and the backend relays every Voice
  Live frame. The spec now listens on `/api/voice-live/ws` and asserts the real, working turn:
  `proxy.connected` → `session.updated` carrying `avatar.ice_servers` → `response.audio_transcript.delta`
  streams, with no `error` frame and no "语音不可用 / voice unavailable" fallback. Verified passing
  against real Azure. Test-only; no runtime behavior change.

## 0.28.1.0 (2026-08-18)

### Fixed
- **Live /interview screen no longer overflows the viewport.** The stage used an unbounded
  `min-height`, so once the digital-human video (or a long transcript) rendered, the whole page
  grew past the screen and pushed the new top bar off-screen. The live layout is now pinned to the
  viewport height (`100vh`) with internal scrolling, so the top bar, stage, and transcript always
  stay on one screen and the transcript scrolls internally.
- **The digital human is sized "刚刚好" — the stage hugs the avatar.** The stage now takes the
  avatar video's own aspect ratio (reported on `loadedmetadata`), capped to the available height and
  top-aligned, so there's no large dark gap below the figure. The video uses `object-fit: contain`
  (was `cover`), so the full figure — including the face — is always visible instead of cropped or
  zoomed. The voice-only orb keeps the full-height stage panel.

## 0.28.0.0 (2026-08-18)

The **/interview** live screen was reorganized for a cleaner, more polished look — no change to
what the interview does, only how it's laid out and styled.

### Changed
- **Global top bar.** Question progress, the voice-status badge, and the text/voice switch now live
  in a single full-width glass bar spanning the top of the live screen, instead of being scattered
  across the stage overlay and answer card. Progress on the left, live voice status centered, the
  作答方式 switch on the right.
- **Adaptive transcript.** The conversation panel now grows to fill the available height of the
  answer column (with internal scrolling and auto-scroll to the newest turn) instead of a fixed
  220px box, and shows a quiet hint while empty so the layout no longer collapses or jumps.
- **Refined stage + typography.** The deep-violet stage gains a layered radial spotlight and softer
  inset/drop shadows; the question text is larger and bolder under a brand-colored eyebrow; and the
  transcript bubbles use harmonized brand/neutral colors with distinct interviewer/candidate sides.

## 0.27.2.0 (2026-08-18)

### Fixed
- **"语音不可用" notice no longer shows under a live digital human.** During the silent background
  reconnect loop, a transient pre-connect error surfaced to the page — setting the
  voice-unavailable fallback even when the very next reconnect attempt succeeded. Mid-reconnect
  errors now stay internal (only exhausting all attempts reports a failure), and the page
  self-heals: whenever the session lands on "connected" while the notice is up, it clears and
  returns to voice.

## 0.27.1.0 (2026-08-18)

The digital human on the **/interview page** is now stable: it no longer randomly fails to appear
or vanish mid-interview. The interview page shares the exact same voice stack as the editor
Playground; its interview-flow actions (speaking each question aloud, "I'm done") exposed three
latent bugs the Playground never triggers.

### Fixed
- **Mid-session Voice Live `error` events no longer kill the session.** The page's manual
  `response.create` (per-question speech, end-of-answer) can collide with a server-VAD
  auto-response; Azure rejects that one request with an in-band `error` event while the session
  (WS, audio, avatar video) stays healthy. That event was treated as fatal — the page silently fell
  back to text ("语音不可用") and hid the live digital human. Such errors are now logged and
  ignored; a genuine pre-connect failure still rejects and falls back to text.
- **Avatar returns after a reconnect.** The one-shot avatar-handshake guard was never reset when
  the WS auto-reconnected, so after any network blip the new session skipped the avatar SDP
  handshake and only the orb showed. The guard resets per session.
- **Voice stays retryable.** One transient failure used to permanently disable the "语音作答"
  button for the rest of the interview; it stays clickable and a successful retry clears the
  fallback notice.
- **The digital human stays visible once streaming.** Avatar visibility now follows the actual
  video state, not the text/voice answer tab — peeking at the text tab no longer blanks a live
  avatar.

## 0.27.0.0 (2026-08-18)

The editor's **Instructions** field now always matches what the Azure AI Foundry Portal shows.
Previously an empty field silently pushed an auto-generated `"You are {name}, an interviewer."` to
Foundry, so the Portal displayed instructions the editor didn't — reading as a mismatch.

### Added
- **Visible default instructions (Portal parity).** When a persona has no custom instructions, the
  editor shows the auto-generated default as the field's placeholder plus a hint explaining that
  this is what the Foundry agent runs (and what the Portal displays); typing replaces it. The
  default string has a single source of truth (`default_instructions` in the persona model) shared
  by the sync adapter and the API (`PersonaOut.default_instructions`).
- **Instructions reconcile with the Portal (like model + version).** `fetch_remote_state` now also
  reads the live agent's `definition.instructions`, and reconcile-on-open pulls a **real Portal
  edit** back into the persona's `prompt_fragment` — so an instruction edited in the Portal shows
  up in the editor. A remote string equal to the stored fragment or to the generated default is
  NOT pulled: an empty fragment still *means* "using the default", keeping the row clean.

## 0.26.0.0 (2026-08-17)

The digital human now shows a **live face**, not just the orb. This release migrates the editor's
voice session onto a backend-proxied Voice Live connection, which is what makes real avatar video
possible — closing the headline *Known limitation* of 0.25.0.0. It also keeps each persona's model
and Foundry-agent version in sync with the Azure AI Foundry Portal, makes voice turns fully
hands-free, and cuts the time-to-connect.

### Added
- **Avatar video (live digital-human face).** The editor Playground's voice session now streams the
  real avatar face, not the animated orb. Voice runs over a new backend **Voice Live WebSocket
  proxy** (`/voice-live` WS + `voice_live_proxy.py`): the backend holds the `azure-ai-voicelive` SDK
  connection and relays both directions, so Azure delivers the avatar's ICE servers + SDP handshake
  on the same connection that configured the session. A separate recvonly `RTCPeerConnection`
  negotiates the video, and the view only swaps the static portrait for live video once real frames
  actually paint (frame-gate) — no orb flash. This is the transport migration flagged as a
  follow-up in 0.25.0.0.
- **Per-persona model + Foundry-agent version reconciliation.** Each persona now stores its own
  `model` (new column) instead of a single global value. Opening a persona in the editor reconciles
  against the live Foundry agent (`POST /admin/personas/{id}/reconcile`): if the Portal bumped the
  agent's version/model, Foundry is authoritative and the app pulls the new version + model back
  into the persona (and, for the default persona, into the runtime config). Editing the model in the
  editor pushes it to Foundry on save (bidirectional).
- **Unified Playground conversation.** Text and voice are no longer separate tabs — one message
  stream carries both typed turns and live voice transcripts (user speech + agent replies), with a
  single composer holding text send + a voice toggle.

### Changed
- **Hands-free voice turns (Foundry-portal parity).** Server VAD is now configured explicitly
  (`create_response=True`, `interrupt_response=True`) so Azure auto-generates the agent's reply when
  you stop speaking and lets you barge in mid-answer — the interviewer no longer needs a manual
  trigger to respond.
- **Agent model dropdown lists all chat deployments.** Deployment discovery is Entra-first and
  filtered to chat-capable models, so the `/admin/agent` model picker shows the full roster on a
  key-disabled Foundry resource instead of a single entry.
- **Faster voice connect.** The Entra credential is pre-warmed in the background at startup, the
  certifi SSL context is built once and reused, and microphone acquisition runs in parallel with the
  connection setup — shaving the one-time cost off the first connect.

### Fixed
- **Avatar portrait no longer flashes to the orb during connect.** The static real-face portrait
  stays visible as an overlay through the entire connect (WS → session update → avatar ICE/SDP →
  first frame) and cross-fades straight into the live face.
- **Avatar WS-proxy SSL trust.** The proxy points aiohttp at the certifi CA bundle, fixing
  `CERTIFICATE_VERIFY_FAILED` when verifying Azure's cert chain on macOS/some Linux.

## 0.25.0.0 (2026-08-13)

The `/admin/agent` editor is now a working Foundry-portal-style workspace: you can pick the agent's
model, attach knowledge bases, and **test the agent right in the editor** — by text and by voice —
without leaving the page. Config is laid out in three always-visible columns instead of hidden
behind a "Configure" button, and the digital human is shown large and centered.

### Added
- **Inline Playground (test the agent in the editor).** The center column is now a live "Try it"
  panel with two tabs: **Text** (chat with the persona's hosted Foundry agent, multi-turn) and
  **Voice + digital human** (Start brokers a real Voice Live session for that persona and connects
  audio + transcript). Backed by new admin endpoints `POST /admin/personas/{id}/test-chat` and
  `POST /admin/personas/{id}/voice/session`.
- **Three-column editor layout.** Left = agent definition, center = Playground, right =
  configuration (language / voice / avatar / advanced) — all visible at once; the Configure drawer
  is gone. Collapses to one column on narrow screens.

### Changed
- **Model + Foundry-IQ dropdowns now populate on a fresh deploy.** Discovery previously required an
  admin to first save the AI Foundry connection into the database; it now falls back to the `.env`
  Foundry credentials when no saved row exists, so the model list and the knowledge-base
  connection/KB pickers work out of the box.
- **Digital human enlarged.** The interviewer preview fills the center column (proportional to the
  viewport) instead of a small fixed box.

### Fixed
- **Interview no longer dead-ends on a stale session.** A cached anonymous token that no longer
  validates (server restarted) used to fail every attempt with "Invalid anonymous token"; the app
  now transparently re-establishes a fresh session and retries.

### Known limitation
- **Digital-human VIDEO still shows the animated orb, not a live face, during a voice session.**
  Live testing proved this is an Azure transport limit, not a UI bug: the current direct-to-Azure
  voice transport streams the agent's audio + transcript but returns no avatar video pipeline
  (`session.updated` reports `avatar: null`, no ICE servers), so no video frames ever arrive and the
  orb is shown. Rendering the real avatar face requires migrating voice to a backend-proxied Voice
  Live connection (a separate, larger change). Audio, transcript, and the static real-face preview
  are unaffected. See `docs/planning/spec-voice-live-agent-contract.md` §11.

## 0.24.0.0 (2026-08-12)

Knowledge grounding is now configured **per interviewer persona**, directly in the `/admin/agent`
editor — matching the Azure AI Foundry portal's per-agent Knowledge experience. An admin picks an
Azure AI Search connection and one or more Foundry IQ knowledge bases for a persona; each is bound
to that persona's Foundry prompt agent as an authenticated MCPTool on sync. The old single global
knowledge base (set under Admin → AI Foundry and bound to every agent) is retired for agent
grounding; the separate SOP text-retrieval used for answer scoring is unchanged.

Two candidate-facing improvements ship alongside it: the digital-human avatar now actually appears
during a voice interview, and the interview page is redesigned into a full-screen two-column stage
(the interviewer's face/orb on the left, question and answer controls on the right) instead of a
cramped centered column.

### Added
- **Per-persona knowledge bases.** New `persona_knowledge_configs` table + `PersonaKnowledgeConfig`
  model (one row per attached KB, cascade-deleted with the persona) and a DB-only
  `persona_knowledge_service` (list / add / remove / `configs_as_dicts`).
- **Editor Knowledge section (now editable).** The read-only status strip is replaced by a
  per-persona list with a **Connect knowledge base** dialog: two cascading dropdowns (Azure AI
  Search connection → Foundry IQ knowledge base) populated live from the resource. Add/remove
  re-syncs the persona's agent immediately.
- **Admin endpoints.** `GET /admin/personas/knowledge/connections`,
  `GET /admin/personas/knowledge/knowledge-bases`, `GET/POST /admin/personas/{id}/knowledge`,
  `DELETE /admin/personas/knowledge/{config_id}` (all admin-only; discovery is fail-soft → `[]`).

### Changed
- **Agent sync binds per-persona KBs.** `AzureAgentSyncAdapter.sync_persona` now resolves each of a
  persona's attached KBs to an authenticated RemoteTool connection (find-or-create via ARM, reusing
  the existing `foundry_connections` helpers) and builds one MCPTool per KB. A KB that cannot
  authenticate fails the sync (recorded as `agent_sync_status=failed`) rather than silently
  dropping — a "synced" agent is never falsely reported as grounded. `build_agent_tools` now takes
  `knowledge_tools` + `persona_tools`.
- Retired the global KB → agent binding in the adapter registry (the F1 SOP scoring retrieval path
  is untouched and still reads the Admin AI Foundry config).
- **Interview page redesigned.** The live Q&A is now a full-width two-column stage: the digital
  human (or the voice orb) on a dark stage at left, and the question, a colored status pill
  (listening / speaking / muted), the text/voice answer controls, and the transcript at right. It
  stacks to one column on narrow screens. The other phases (start, orientation, scoring, report)
  keep a centered layout.

### Fixed
- **Digital human now appears in voice mode.** The avatar video never rendered — the browser
  blocked it from playing because the element wasn't muted, leaving a blank stage. The avatar video
  now plays (its audio was always on a separate channel), and the interviewer's face only replaces
  the fallback orb once real video frames arrive, so a stalled or empty stream shows the orb instead
  of a blank box.
- **Deleting a persona now removes its attached knowledge bases** instead of orphaning them (foreign
  keys are enforced on SQLite).

## 0.23.1.0 (2026-08-12)

Voice mode now actually connects to the interviewer's Foundry agent. Clicking "语音作答" on the
interview page previously fell back to "Voice unavailable" even though the backend brokered a valid
session — the digital human never appeared. The signaling handshake was using the wrong Azure Voice
Live contract for a Foundry agent.

### Fixed
- **Voice Live agent-mode signaling contract.** The broker now builds the WebRTC signaling URL
  against the correct Azure contract (live-verified with a real browser via Playwright fake-mic
  against a real Foundry project): the `/voice-live/realtime/calls` endpoint, api-version
  `2026-01-01-preview`, and the `agent_id` + `agent_project_name` query keys. The previous form
  (`/voice-live/realtime`, `2026-07-15`, `agent_name`/`project_name`) was rejected by Azure as
  "Missing required agent project name" then "Classic foundry agent is not supported in API version
  2026-04-10 and above".
- **Agent-mode token scope.** Agent sessions authorize against the AI Agent service, which needs an
  `ai.azure.com` (Foundry)-scoped bearer; the broker previously always minted a
  `cognitiveservices.azure.com` token, which Azure rejected "Unauthorized to AI Agent service".
  `voice_providers.issue_credential` now takes a `scope`, and the broker passes the Foundry scope in
  agent mode (model mode keeps cognitiveservices).
- **agent_id version suffix.** The SDK returns a created agent id as `name:version`; the signaling
  `agent_id` query must be the bare name (version rides in `agent_version`). The broker now strips
  any `:version` suffix.
- The voice hook now handles the `rtc.call.error` control message from the `/calls` endpoint, so a
  call-level rejection surfaces immediately instead of waiting out the 30-second connect timeout.

- **Audio-only signaling offer for agent mode.** Azure Voice Live's agent-mode initialization
  rejects an SDP offer that carries a video or datachannel m-line (live-verified: an audio-only
  offer negotiates, audio+video or audio+datachannel fails `agent_initialization_failed`). The voice
  hook no longer adds a recvonly video transceiver, and no longer creates the `voice-live-events`
  datachannel on the offering peer connection — it now accepts the channel Azure opens via
  `ondatachannel`, keeping the initial offer audio-only. (Avatar video negotiates over a separate
  `session.avatar.connect` exchange per the Voice Live WebRTC docs.)
- The session config is sent inline in `rtc.call.sdp.create` (agent init happens during the SDP
  exchange, so a later `session.update` alone is not enough).

- **Agent voice-mode metadata must fit one key.** The voice config is stored on the Foundry agent
  as `microsoft.voice-live.metadata`. Our full config (~690 chars) exceeded Azure's ~512-char
  metadata cap and was split into `microsoft.voice-live.configuration` + `…configuration.1`. Voice
  Live does not reassemble a split value — it fails agent initialization. The agent metadata now
  carries a COMPACT config (voice + turn_detection + avatar + proactive_engagement, ~226 chars, one
  key); the verbose runtime knobs still apply at `session.update` time. Live-verified: after this
  fix a real browser offer clears agent-init (previously `agent_initialization_failed`).

- **Signaling query keys must be hyphenated** — `agent-name` / `agent-project-name` /
  `agent-version` (NOT `agent_id` / `agent_project_name`). This was the true blocker behind the
  whole "agent_initialization_failed" / BUNDLE saga: with the underscore keys a normal browser offer
  fails agent init; with the hyphenated keys the standard offer (BUNDLE, datachannel, full codecs)
  completes the full `session.created → session.updated → rtc.call.sdp.created` handshake. Matched
  against the working AI-Coach project's contract and live-verified end to end.
- **Runtime `session.update` trimmed for agent+avatar** — the broker drops `voice`,
  `proactive_engagement`, and `interim_response` from the runtime session config: with an avatar
  configured Azure rejects a runtime voice change ("Cannot update voice when avatar is configured")
  and the realtime session rejects `proactive_engagement`/`interim_response` (those live in the
  agent's metadata, set at sync time).
- **`speakQuestion` no longer overrides `instructions`** in `response.create` (agent mode rejects
  it); it injects the backend-authoritative question as an assistant item and fires a bare
  `response.create`.

**Result (live-verified against real Azure):** clicking 语音作答 now connects the interviewer's
Foundry agent over WebRTC, streams the digital-human avatar video, and the agent speaks
(`response.audio_transcript.delta` events flow). No "Voice unavailable" fallback.

## 0.23.0.0 (2026-08-11)

The `/admin/agent` editor gains a **Tools** capability matching the Azure AI Foundry portal's agent
Tools UI. Because a persona syncs to a real Foundry prompt agent, a selected tool really lands in
that agent's definition — execution stays in the Foundry runtime; this app only carries the config.

### Added
- **Per-persona agent tools** — `interviewer_personas.tools_config` (JSON array), threaded through
  `PersonaCreate/Update/Out` and synced into the Foundry prompt agent's `tools`.
- **`persona_tools.py`** (pure, CI-tested): parses + gates the config to the tool types this app can
  actually emit today — `code_interpreter`, `web_search`, and a public `mcp` server — dropping the
  rest so an unsupported/half-configured tool never syncs.
- **Tools UI** (Fluent v9): a left-panel **Tools** section (`ToolsSection`) with an "Add ▾" menu
  (Web search / Code interpreter quick toggles + "Add tools…") and a **"Select a tool" dialog**
  (`ToolPicker`) mirroring the portal — Configured / Catalog / Custom tabs, search, and the full card
  set (File search, Azure AI Search, Grounding with Bing, Computer Use, Work IQ, Fabric, SharePoint,
  OpenAPI, MCP, A2A). Supported tools add + sync for real; the rest carry a **Preview** badge and are
  not selectable (portal parity without fake function). Custom → MCP prompts for a server URL.
- Tests: `test_persona_tools.py`, `ToolPicker.test.tsx`, plus tools round-trip assertions in the
  backend persona API and the frontend editor page.

### Changed
- The agent SDK converter (`azure_agent_sync._to_sdk_tool`) dispatches by tool `type` — MCPTool
  (KB + public persona MCP), `CodeInterpreterTool`, `WebSearchTool`. `build_agent_tools` merges the
  SOP KB tool (always first) with the persona's gated tools.
- **A persona MCP server requires approval by default.** Since the interviewer agent runs a live
  conversation with an untrusted candidate, an admin-added public MCP defaults to
  `require_approval="always"` (was implicitly unrestricted) so its tools can't be auto-invoked via
  prompt injection. The tool gate also validates `server_url` is plain http(s), tolerates non-string
  fields without crashing, and dedupes repeated tools before they reach Foundry.
- Interviewer avatars now carry Azure's real style slug. A migration backfills any persona still on
  the old Lisa `casual` style to `casual-sitting` so it renders the intended pose in Voice Live.

### Deferred (follow-up issue)
- Connection-authenticated tools (protected MCP, OpenAPI spec, A2A, Bing grounding, Azure AI Search)
  and Microsoft-hosted connectors (Work IQ, Fabric, SharePoint, Computer Use) — shown as Preview
  cards; wiring them needs RemoteTool connection resolution / spec parsing not yet generalized.

## 0.22.0.0 (2026-08-11)

The `/admin/agent` editor now matches the Azure AI Foundry portal Playground: real digital-human
faces (not letter placeholders), the portal's three-region layout, and the full Azure avatar roster.
Picking an interviewer now looks and works like it does in Foundry.

### Added
- **Real-face avatar roster** (`frontend/src/data/avatarCharacters.ts`): the full Azure Voice Live
  catalog — 6 video avatars (Lisa/Harry/Meg/Jeff/Lori/Max, multiple styles each) + 27 photo avatars
  — with official Microsoft Learn CDN preview photos (every thumbnail URL verified against the CDN).
- **`AvatarPreview`**: a static real-face preview for the editor's center Playground column (the
  digital human "stands" in the middle like the portal), with an initial-swatch fallback and a
  voice-only orb when no avatar is set. The live-interview `/interview` WebRTC path is untouched.
- Component tests for `AvatarGrid` (real thumbnails, onError→initial fallback, all/photo/video
  filter, style dropdown) and `AvatarPreview`.

### Changed
- **`AvatarGrid` now shows real faces**, not colored letter blocks: CDN thumbnails with an
  onError→initial fallback (offline/test-safe), an all/photo/video filter, one tile per style for
  video avatars, and a style dropdown for the selected character.
- **Editor layout matches the Foundry portal**: persona selection moved into a top-bar switcher
  dropdown; the left column became divider-separated agent-definition sections (Identity / Voice
  mode / Model / Agent / Instructions / Knowledge); the center is a large Playground preview.
- **Avatar style slugs are Azure's real names** (e.g. `casual-sitting`, not `casual`). Since the
  backend passes `persona.style` through to Voice Live verbatim, this also corrects the value sent to
  Azure. `DEFAULT_AVATAR_STYLE` is now `casual-sitting` (`voice_live_metadata.py`).

### Removed
- `PersonaNav` (left-side persona list) — superseded by the top-bar `PersonaSwitcher`.

## 0.21.0.0 (2026-08-11)

Scoring runs against a real model, and report citations are trustworthy. When an operator points
the app at their AI Foundry in the admin config, interview scoring + checklist drafting now use a
real deployment (previously mock-only — Phase 2 had removed the old LLM adapter). And a checklist
item's SOP citation only shows when it's complete: a half-attributed quote from the drafting model
is stripped rather than shown. Phase 5 (final) of epic #26 — audited against the merged base and
scoped to the two real gaps; voice/pronunciation scoring is a separate future issue.

### Added
- **Real Foundry LLM scoring** (`app/services/agents/adapters/foundry_llm.py`): a `FoundryLLMAdapter`
  that runs `complete(prompt, json_mode)` against a Foundry deployment via the Responses API (JSON
  mode = `text.format`), reusing the Phase 2 Entra-first client. Registered as the `azure` LLM
  provider when a Foundry project endpoint is configured, and flipped on by the config overlay — so
  saving a config in `/admin` makes a scored report reflect an actual model judgment, no restart.

### Changed
- **Report SOP citations are gated.** A checklist item's `source_quote`/`source_page` (drafted by
  the model, previously trusted verbatim) now pass the strict full-field citation gate: a partial
  pair is cleared so no half-attributed claim reaches the report. The item itself is always kept
  (never silently drops checklist coverage) — only the attribution is stripped. Applies to freshly
  drafted checklists, not human-authored admin edits.

### Notes
- Scoring/drafting still default to the deterministic mock in dev/CI — the real adapter only
  registers + activates when a Foundry endpoint is configured, so zero-Azure builds are unchanged.
- The live scoring call is coverage-omitted (needs a real deployment); the request shaping,
  registration, overlay flip, and citation gate are all unit-tested (backend ~350 tests / ~88%).
- Deferred to follow-up issues: voice/pronunciation scoring (Azure Speech SDK, a new report
  dimension) and true citation grounding (cross-checking a drafted quote against the actually
  retrieved SOP passage). Live scoring against `avarda-demo-prj` is a manual Layer-3 check.
- **Epic #26 complete** — all five phases (login, Azure base, editor UI, interview flow, scoring)
  are now on main.

## 0.20.0.0 (2026-08-11)

The interview flow, fused and hardened. A candidate can answer each question by text OR voice and
reload the page without losing their place; in voice mode the digital human now speaks the actual
interview question (not an improvised one); and a few sharp edges are gone. Phase 4 of epic #26 —
an audit confirmed the turn-by-turn spine (ask one question at a time, backend decides follow-up
vs next, ends when the bank is exhausted) was already built, so this release closes the real gaps
that audit found rather than rebuilding it.

### Added
- **Resume after reload.** Your in-progress interview survives a browser refresh: the app persists
  the interview id and re-reads the pending question (new `GET /candidate/interview/{id}`), landing
  you back where you were instead of restarting from question 1. Starting again mid-interview
  resumes the same session rather than orphaning it.
- **A defined "no questions" screen** instead of a blank page if an interview has no questions.

### Changed
- **Voice speaks the real question.** In voice mode the interviewer now reads the backend's
  authoritative question text verbatim, instead of letting the agent generate its own utterance —
  so what you hear matches the question being scored (Phase 4 voice→turn design).
- **Voice answers keep everything you said.** If you pause mid-answer (producing several final
  transcript segments), all of them are now submitted as one answer; previously only the last
  fragment was kept.
- **The "Answer by voice" button recovers.** A transient voice failure no longer disables voice for
  the rest of the interview — a successful reconnect re-enables it.

### Notes
- The turn-by-turn state machine remains the single decision-maker for follow-up vs next (it never
  bypasses to the agent); text and voice both converge on one `answer_finalized` event.
- Backend ~290 tests / ~87% cov (resume, multi-follow-up, empty-bank terminal, voice-source over
  HTTP, voice-fail-then-text); frontend 34 tests; E2E 5 (added a real-browser reload-resume).
- Live voice round-trip (the digital human speaking the injected question) is a manual Layer-3
  check against Azure Voice Live; the wiring is unit-covered where jsdom allows.
- Builds on epic #26 Phases 1–3 (v0.17–v0.19).

## 0.19.0.0 (2026-08-10)

A Foundry-portal-style Agent editor. Admins get a new `/admin/agent` page that looks and configures
like the Azure AI Foundry prompt-agent editor: a left persona nav, a center agent-definition column
(digital-human preview, identity, model, instructions, knowledge status), and a gear-triggered
Configuration rail (language, speech voice + greeting per language, interim/proactive toggles, an
avatar picker grid, and advanced audio knobs). Pick an interviewer, edit its instructions and voice,
choose a digital-human avatar, and save — the backend creates/updates the Foundry agent behind it.
This is Phase 3 of epic #26; built native Fluent v9 (this repo has no Radix/Tailwind to port).

### Added
- **`/admin/agent` editor** (`pages/AgentEditorPage.tsx` + `components/agent-editor/*`): login-gated
  like `/admin`; persona nav (enabled dot, default badge, agent-sync chip, "New persona"); center
  `AgentDefinitionPanel` (AvatarView preview, identity name/enabled/default, `AgentSyncStatusCard`
  with retry-sync, model dropdown, voice-mode toggle, instructions, knowledge status); an
  `OverlayDrawer` `ConfigurationRail` (language → per-locale voice + greeting, interim/proactive,
  `AvatarGrid`, advanced turn-detection/EOU/noise/echo/temperature/playback).
- **Persona API client** (`api/personas.ts`): list/get/create/update/set-default/retry-sync over the
  shared `adminRequest`, with `voice_map`/`greeting_map` JSON-string ⇄ record helpers.
- **Avatar picker** (`data/avatarCharacters.ts` + `AvatarGrid`): a small roster of Voice Live video
  avatars (lisa/harry/meg/jeff) writing the persona `character`/`style` fields the backend already
  maps to the Voice Live avatar config.

### Notes
- Model dropdown lists the resource's real deployments and the knowledge status shows the real
  configured Foundry IQ base (both via the existing admin config endpoints, Entra-backed live).
  Per-persona model + knowledge overrides are intentionally not persisted (no backend field) — model
  is informational, knowledge is bound from the global config; both link back to `/admin`.
- Editor preview is static (no live WebRTC in the editor) — orb + selected character/style label +
  greeting; the live avatar face is the interview page (F9).
- Frontend 29 → 43 tests; typecheck + lint (`--max-warnings 0`) + build + E2E (4) all green.
- Builds on Phase 2 (v0.18.0.0); this Phase 3 is additive frontend.

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
  `project_connection_id`**. Lists AI Search connections + knowledge bases (the `/admin` config KB
  dropdown now populates from the real resource through this shared path), and finds-or-creates the
  KB's RemoteTool connection via the ARM control plane (`category=RemoteTool`,
  `authType=ProjectManagedIdentity` — no stored secret) so the MCPTool authenticates instead of
  403ing. Shared Entra-first `AIProjectClient` builder extracted so the adapter and the connections
  service use one seam. Auto-resolving the connection during a persona sync (an ARM write) is
  deferred to the editor UI phase that triggers that sync; until then the agent uses the configured
  connection id.
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
- Backend: 327 pass, 88.43% coverage (new: `azure_auth`, `foundry_client`, `foundry_connections`,
  `agent_chat_service`, `azure_agent_sync` pure-helper suites; restored `config_service` +
  `admin_config_api` retargeted to the JWT `admin_auth` fixture). Frontend: 29 pass; E2E: 4/4.

### For contributors
- Pre-landing review (7 specialists) fixes folded in before merge: the synchronous Entra
  credential probe in `build_project_client` now runs off the event loop (`asyncio.to_thread`) at
  all five async call sites (it was blocking the FastAPI loop on every discovery/sync request);
  added the missing pure-helper tests the coverage audit flagged (`_build_openai_request`,
  `_ApiKeyTokenCredential`, `_get_credential_sync` real body); removed the unused
  `get_token_credential_sync`.

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
