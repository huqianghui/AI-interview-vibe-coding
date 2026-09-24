# Changelog

## 0.39.2.2 (2026-09-24)

### Fixed
- **One colour, no frame: the digital human is the only surface on screen.** The interview stage
  and the editor's preview panel no longer draw a coloured box around the avatar. The avatar box
  sizes itself to the stream's exact aspect (a 512×512 photo avatar is a square, a 16:9 video avatar
  is 16:9), so there is no letterbox band and no outer frame — smaller when the space is narrow,
  never cropped. The live video is also painted by Azure in the photo's own thumbnail backdrop
  colour (measured once per character and kept in the avatar roster, passed to the voice proxy as
  `avatar_bg`), because Azure's live synthesis otherwise uses a different grey wall than the
  official thumbnail; now the live face and the editor preview are the same picture.

## 0.39.2.1 (2026-09-24)

### Fixed
- **Digital human is no longer cropped on the interview page, and sits flush on the stage.** Photo
  avatars (the `vasa-1` characters such as amira / adrian) stream a 512×512 square, but the
  interview stage fitted every stream with `object-fit: cover` (tuned for 16:9 video avatars), which
  on a wider-than-square stage scaled by width and cut the shoulders (and chin) off the bottom,
  while the persona editor's photo preview showed the full head-and-shoulders framing. The fit now
  follows the stream's own aspect ratio: 16:9 video avatars keep filling the stage, square/portrait
  photo avatars show the whole frame. The photo avatar's own light-grey backdrop no longer floats as
  a box inside the dark stage: Azure is asked to paint the avatar background in the stage colour and
  the stage is that same flat colour, so the frame edge disappears (interview sessions only; the
  editor Playground keeps its light stage). Verified live: the stream reports 512×512 and renders
  on the navy background.

## 0.39.2.0 (2026-09-24)

### Fixed
- **Linear turn mode: "I'm done" now always moves to the next question.** A linear bank session
  whose current question allowed follow-ups (`max_follow_ups > 0`) still received the authored
  template follow-up ("You mentioned "…" — Can you walk me through that in a bit more detail?") at
  submit, so the candidate saw a probe instead of question 2 — contradicting the editor's own
  "Linear turns — read the question, then stay silent — no follow-ups" promise. `answer_finalized`
  now advances unconditionally unless a `FollowUpProvider` is explicitly passed, and no route passes
  one any more (the judged branch already advanced). The per-question **Max follow-ups** is therefore
  judged-only: it budgets how many pre-submit follow-ups / redirects the judge may write for that
  question. Editor hint text (en/zh) and SPEC F6/F7 updated to match; the F7 citing helper
  (`build_follow_up_prompt`) stays as a pure, unit-tested helper behind the retained hook.

## 0.39.1.0 (2026-09-24)

### Changed
- **Judge: reasoning off, shorter output, and the LLM round-trip now overlaps the silence window
  (owner decisions D17).** Live measurement showed the judge's ~2–3 s is the fixed cost of one gpt-5-mini
  round-trip regardless of prompt size (a 61-character prompt takes as long as the full one; network is
  ~250 ms), so: the Foundry adapter's `fast` mode now turns reasoning OFF (`reasoning.effort=minimal`),
  keeps `verbosity=low`, and caps `max_output_tokens` at 320; the contract asks for one sentence of at
  most 15 words / 30 Chinese characters; `speech_text` is capped at 120 characters; timeout 10 s (the
  prefetch below means it no longer sets the perceived delay). Non-reasoning models (gpt-4.1-mini,
  gpt-4o-mini) receive no reasoning knobs — live-verified no 400.
- **Judge contract rewritten as a step-by-step procedure (needed once reasoning is off).** Without
  reasoning the model called a pause "still speaking" and stretched an unrelated sentence to cover a
  missing required item (live: the incomplete answer got `wait` every time). The contract now makes it
  (1) quote the candidate's own words for EVERY required rubric item (≤ 8 words; no quote = missing),
  (2) apply rules in a fixed order — off-topic → redirect, mid-sentence → nudge, complete sentence with a
  missing required item → follow_up, else wait — and (3) phrase a follow-up as an open question ("who
  else", "what happens next") that never names the rubric's person/document/action. Live: the
  incomplete case now yields a follow-up 5/5 on the seeded persona prompt.
- **Speculative prefetch.** The page asks the judge the moment an utterance ends (`POST /judge` with
  `dry_run: true` — decide, write nothing) and, only if the pause lasts the configured window, calls the
  new `POST /judge/apply` (writes the follow-up turn / delivers the nudge). Perceived delay drops from
  ≈ 2 s silence + 2–3 s LLM to ≈ 1 s. A candidate who keeps talking invalidates the prefetch (its draft
  no longer matches) and the timer falls back to a one-step call. Text channel stays one-step.
- **Budget semantics.** `judge_max_calls_per_question` now counts DELIVERED verdicts (`judge_events.applied`);
  `wait` never consumes it; raw LLM calls per question are bounded at 3× the budget so discarded
  prefetches cannot run away. Migration `a3b4c5d6e7f8` adds `judge_events.applied` (existing rows → applied).
- Eval on the real model with reasoning off: 12/12 (off-topic answers — with or without a rubric — are
  now usually steered back via a "please continue" nudge rather than a `redirect`; accepted as the same steer;
  one leak-guard silence and Azure's jailbreak filter count as correct silence). gpt-4.1-mini and
  gpt-4o-mini confirmed error-free on the fast parameters.

## 0.39.0.0 (2026-09-24)

### Added
- **Judged turn mode for question-bank interviews** (issue #114, PR-2 of 2; spec + review addendum in
  `docs/planning/spec-judged-turn-mode.md`). Admins can now switch a bank persona from **Linear turns**
  (silent between questions) to **Judged turns**: while the candidate PAUSES — voice: end of utterance +
  `judge_silence_seconds`; text: no keystroke for the same window — the backend asks an LLM judge
  (persona prompt ⊕ a fixed contract ⊕ the rubric ⊕ the delimited draft) whether the interviewer should
  say anything: `wait`, `nudge` ("please go on", spoken as an aside / shown as a bubble), `follow_up`
  (ONE guiding question toward an unaddressed required rubric point, written as an interviewer
  `follow_up` turn so the header switches and voice reads it), or `redirect` (an off-topic answer is
  brought back). **"I'm done" always advances** — the judge is never consulted at submit, there is no
  template fallback, and rubric text is never quoted (n-gram + phrase leak guard; a hit means silence).
  Caps: `judge_max_calls_per_question` LLM calls per question, and the question's `max_follow_ups` for
  follow_up/redirect. The retired `model` turn mode (Foundry agent speaking in its own turn) is gone:
  existing rows become `linear`; nothing changes for any persona until an admin opts into Judged.
- **One prompt per persona.** A blank `prompt_fragment` is pre-filled with the generated default on
  create (and back-filled by the migration), so the single Instructions field is the prompt actually in
  force for agent sync, the Playground, and the judge's tone/patience. The editor states its scope and
  shows the fixed judge contract read-only.
- **Admin UI:** Configuration rail — Linear / Judged radios, "Silence before the judge listens" (1–30 s),
  "Max judge checks per question" (0–5); question editor — inline **Max follow-ups** (0–3) per question
  (previously only settable via API); shared `BoundedIntInput` (draft → clamp on blur/Enter) now also
  backs the auto-submit seconds input.
- **Wire:** `interviewer_personas.judge_silence_seconds` / `judge_max_calls_per_question`;
  `interview_sessions.turn_mode` **snapshot** (`linear|judged`, copied at start — a persona flip never
  re-interprets a live interview); `judge_events` (one row per LLM judge call: trigger, verdict,
  latency, model); `POST /candidate/interview/{id}/judge` (`question_id` + `follow_ups_asked` make stale
  requests free `wait`s; blank/capped/stale ⇒ no LLM call; a concurrent call ⇒ 409); candidate
  `start`/`GET` carry `voice_judge_silence_seconds`; `QuestionOut.follow_ups_asked`; `PersonaOut.judge_contract`.
  Migration `f2a3b4c5d6e7`.
- **Judge model latency, live-measured and tuned:** gpt-5-mini at default reasoning effort took 7–10 s per
  judge call (the spec's 3 s timeout failed every real call). The Foundry adapter gained a `fast` mode
  (reasoning effort `low`, low verbosity — `minimal` was 1 s faster but misjudged off-topic answers)
  and a cached project client (the cold first call cost ~8 s; the app now pre-warms it at boot).
  Result: 1.6–7.5 s per call, median ≈3.5 s; judge timeout 10 s. gpt-4.1-mini was tried as a judge
  and rejected (not faster, two off-topic misjudgements). **Acceptance criterion 3 (p50 < 2.5 s) is
  therefore NOT met with gpt-5-mini; measured p50 ≈3.5 s — the owner decides whether to accept or
  revisit the model.**
- **Tests.** Backend 661 passed (CI fake provider) + `test_judge_eval.py` against the REAL model
  locally (12 cases + 2 adversarial persona prompts, pass line ≥ 11/12; 12/12 on 2026-09-24 —
  Azure's jailbreak filter rejecting the injection cases and the leak guard silencing one Chinese
  follow-up both count as correct silence). Frontend 265 passed. New opt-in live spec
  `frontend/e2e/bank-judged-live.spec.ts` (three WAV fixtures, one case per run via `JUDGED_CASE`) —
  **all three passed on real Azure 2026-09-24:** incomplete answer → one guiding follow-up ("Do you
  notify the sponsor or medical monitor, and how quickly…"), header switched and read aloud, "I'm
  done" → Q2; complete answer → `wait` only, Q1 read once; mid-thought pause → one spoken "Please go
  on.", candidate continued, "I'm done" → Q2; no acknowledgment anywhere. The live run also caught a
  migration bug CI could not (`judge_events.created_at` had no DB default; fixed, and a new
  `test_migrations_judge_schema.py` runs the real alembic chain in CI). New
  `test_migrations_judge_schema.py` brings the backend to 662 passed.

## 0.38.4.0 (2026-09-24)

### Changed
- **Mouth voice sessions now run Azure's multilingual semantic VAD with end-of-utterance detection**
  (issue #114, PR-1 of 2). Every "mouth" session — external personas and linear/judged bank personas
  — builds `turn_detection` as `azure_semantic_vad_multilingual` with `silence_duration_ms: 800`,
  `remove_filler_words: true` and `end_of_utterance_detection: {model: semantic_detection_v1_multilingual,
  threshold_level: medium, timeout_ms: 1500}` when the persona's existing `eou_detection` knob is on
  (its default). Until now that knob was honoured only by the `/calls` metadata builder; the WS proxy
  hardcoded the plain `azure_semantic_vad`. Cleaner, less fragmented end-of-utterance segments are the
  boundary the upcoming judge keys off. Agent sessions (bank *model turn*, the editor Playground) and
  personas with `eou_detection` off keep the plain VAD; `create_response` / `interrupt_response`
  semantics are unchanged in every mode. `proxy.connected` additionally reports the `turn_detection`
  type. Constants, not admin knobs (owner decision D2/D16). Guarded by five new shape tests in
  `test_voice_live_proxy.py`; the live spec `bank-linear-restart-live.spec.ts` now asserts Azure echoes
  the multilingual shape.

## 0.38.3.1 (2026-09-24)

### Fixed
- **Linear-turns bank sessions now read every question — live-verified on real Azure.** The
  v0.38.2.0 default had a gap the unit tests could not see: a linear bank session still connected in
  **agent** mode, and the only way to hand an agent text to read is an assistant conversation item.
  Live run (fake mic speaking a real answer): question 1 read once, the spoken answer produced NO
  extra turn (the "Thank you." per pause is gone), but the response meant to read question 2 said
  **"Thank you."** — the agent's own instructions ("acknowledge when the candidate finishes") won over
  the assistant item, so question 2 showed in the header and was never spoken. Fix: a linear-turns
  bank persona is now a **mouth** exactly like an external persona — MODEL mode + the reader prompt
  (`external_reader_prompt` or its generated default) as a system item, the question carried in
  `response.instructions` via the read directive (the delivery that reads verbatim, live-verified since
  v0.37.x). `is_mouth_persona()` in `voice_live_proxy.py` decides it (external always; bank when
  `bank_turn_mode` is linear; the editor Playground keeps the agent), the WS route skips the
  agent-sync gate for mouth personas, and `proxy.connected.mode` reports `model` for them. Bank
  MODEL-turn personas are unchanged (agent mode, assistant-item read, agent-owned reaction). New
  azure-free `test_voice_live_plan.py` locks the plan; the new opt-in live spec
  `bank-linear-restart-live.spec.ts` (real Azure + a spoken-answer WAV on the fake mic) proves the
  whole loop: linear flags on start/proxy/session, one read per question, no acknowledgment after the
  spoken answer, "I'm done" advances and reads question 2, "Start over" abandons + reconnects + re-reads
  question 1.

## 0.38.3.0 (2026-09-24)

### Added
- **"Start over" (重新开始) for candidates.** An in-progress interview session persists in the
  DB, and both `/start` and the page's resume-on-mount always hand it back — so a candidate who wanted
  a fresh run was stuck on the old session until every question was answered (client request). The
  interview page now shows a **Start over** button in the header during orientation and the
  live Q&A. It is destructive, so a dialog confirms first ("Your answers so far will be discarded…");
  on confirm the page tears down voice, calls the new endpoint, and re-enters orientation on the fresh
  session exactly like a first start (transcript and draft cleared, question 1 read again, the
  voice-default auto-connect re-armed for the new session).
- Wire: `POST /candidate/interview/{id}/restart` marks the owned live session **`abandoned`** (a new
  terminal status alongside `completed`/`scored`: kept for the record, never resumed, reviewed, or
  scored — every later route on it is a 409 and its `current_question` is null) and returns a brand-new
  `in_progress` session on the default persona's *current* engine with the usual entry-point voice
  flags; the client saves the new id so a reload resumes the fresh interview. Only `in_progress` can be
  restarted (409 otherwise; a finished interview is simply followed by a normal `/start`); another
  candidate's interview is a 404. External sessions first send the brain its `end` signal (a turn in
  flight is a 409 like `/end`, and abandons nothing) so the vendor conversation is closed rather than
  orphaned. No migration (status is a free string column). Tests: 4 backend API cases (abandon +
  fresh start + old-session 409s, ownership/auth/completed, external end-then-abandon, external
  conflict) and 2 `InterviewPage` cases (dialog cancel/confirm flow, backend refusal banner).

## 0.38.2.0 (2026-09-24)

### Fixed
- **Question-bank voice sessions no longer say "Thank you." after every pause.** Root cause: bank
  sessions ran Azure server-VAD with `create_response=True`, so *every* end-of-utterance Azure detected
  opened a full model turn, and the interviewer prompt asks the model to acknowledge the answer in that
  turn — a candidate who pauses twice mid-answer got two "Thank you."s, the "I'm done" click could nudge
  a third, and only then was the next question read. The prompt cannot fix this: `create_response` is a
  single boolean, the model has to say *something* in each turn it is given, and its "Please go on" vs
  "Thank you" guess per pause is unreliable. Fix: bank sessions now default to **linear turns** — the
  same contract external sessions always ran — where the model has no turn of its own and the digital
  human only reads each backend question verbatim, silent in between.

### Added
- **`bank_turn_mode` — an admin-controlled turn contract for question-bank voice sessions** (owner
  reversal, 2026-09-24, of the v0.38.1.1 "engine decides, no knob" decision; the two protocol facts
  recorded there still hold, what changed is the preferred default and that the reaction is now an
  explicit opt-in). In the `/admin/agent` Configuration rail, bank personas get a **Between questions
  (question bank)** control: **Linear turns — read the question, then stay silent** (default) or
  **Model has its own turn — may acknowledge or follow up** (the pre-0.38.2.0 behaviour, governed by
  the instructions; the hint warns it reacts once per *pause*, not once per answer). Bank-only: the
  control is hidden for external personas (linear by construction) and the value persists untouched
  while a persona runs external. Under linear turns the page also reads backend **follow-ups**
  verbatim (nobody else will voice them), where model-turn sessions keep letting the agent own them.
  The editor **Playground** keeps the model turn for a bank persona regardless (it is a free
  conversation with the agent to test its instructions, not the interview flow).
- Wire: `interviewer_personas.bank_turn_mode` (`String(16)`, migration `e1f2a3b4c5d6`, server default
  `'linear'` — **existing personas flip to the silent contract on deploy**; switch them back in the
  editor if you want the acknowledgments), `PersonaOut` / create / update carry it (422 outside
  `linear|model`, explicit null included), and the candidate `start` / `GET` responses carry
  `voice_linear_turns` for the session's engine snapshot (external ⇒ always `true`; bank ⇒ the
  persona's mode; no persona ⇒ the engine alone; `null` on mutation responses, latched by the page
  like `voice_auto_submit_seconds`). `build_avatar_session` derives `create_response` from
  `linear_turns_for_persona()`; `proxy.connected` additionally reports `linear_turns` for the live
  E2E spec. Regression guards: `test_voice_live_proxy.py` (bank linear ⇒ `create_response=False`,
  bank model ⇒ `True`, external ⇒ `False` in both modes, legacy persona object ⇒ linear, playground
  ⇒ model turn for bank only), admin + candidate API round-trips, editor form/rail cases, and an
  `InterviewPage` case proving a linear bank session reads the follow-up and hands the hook
  `linearTurns: true` across a null-reporting mutation.

## 0.38.1.1 (2026-09-23)

### Changed
- **`linear_turns` closed by design, not by adding a setting — zero behavior change.** The open
  proposal was a per-persona `linear_turns` switch so question-bank sessions could also run the fully
  silent turn contract (no model turn at all between questions). It turns out the useful middle
  ground it aimed at is unreachable: Azure's server-VAD `create_response` is a **single boolean**, so
  the turn created when the candidate stops speaking is simultaneously the source of a "Thank you."
  acknowledgment and of an unwanted follow-up — the switch could only ever mean "all reaction" or
  "total silence", never "acknowledge but don't ask". And agent mode **rejects overriding
  `instructions` inside `response.create`**, so a scoped one-off "acknowledge only, ask nothing" turn
  cannot be built for a bank persona either. Decision: **bank mode stays under model + prompt control
  (`prompt_fragment`); external mode is linear because it supplies no brain at all** — the engine
  decides, there is no knob. That is exactly what already shipped, so this release only makes the
  concept explicit: the frontend option `externalMode` is renamed **`linearTurns`** (the two bare
  `response.create` guards in `commitAnswer`), and the three reasons above are recorded in
  `voice_live_proxy.py` next to `create_response=not is_external` and in the hook's option doc so the
  item is not re-filed as a quick win. No migration, no new persona field, no admin-UI change, no
  prompt text touched. Existing regression guards keep it honest: `test_voice_live_proxy.py`
  (bank ⇒ `create_response=True`, external ⇒ `False`) and the `linear turns: commitAnswer never
  fires a bare response.create` hook test. Note for future readers: the OTHER `response.create` in
  the hook — paired with an assistant item in `emitSpeak` — is the verbatim read trigger, keyed off
  `readDirectiveRef`, and must keep firing under linear turns or the question is never spoken.

## 0.38.1.0 (2026-09-23)

### Changed
- **Voice silence auto-submit is now admin-controlled per persona, with one independent setting
  per interview engine.** Voice sessions used to auto-submit the candidate's answer after a hardcoded
  3s of silence (external-brain sessions), which fired while candidates were still *thinking* — a
  pause is not an end of answer. The `/admin/agent` Configuration rail gets an **Answer submission
  (voice)** block showing the pair for the persona's current engine: **Auto-submit answer after
  silence** (switch) and **Silence before auto-submit (seconds)** (1–60, remembered while off).
  Defaults: **Question bank OFF** (the turn advances only on the explicit **I'm done** click) and
  **External interview API ON at 3s** (its hands-free flow is unchanged). Both are admin-editable,
  and the two engines are separate config items — switching the engine never carries one pair into
  the other (same rule as the two prompt fields). When on, the interview page arms the timer after
  every utterance, clears it when the candidate speaks again, and the button stays as the
  immediate override.
- Wire: `interviewer_personas.{bank,external}_auto_submit_enabled` /
  `{bank,external}_auto_submit_silence_seconds` (migration `d0e1f2a3b4c5`, server defaults
  0/3 and 1/3 — existing personas keep today's behaviour), `PersonaOut` / create / update carry all
  four (422 outside 1–60), and the candidate `start` / `GET` responses carry
  `voice_auto_submit_seconds` for the SESSION's engine (0 = off, N = seconds; `null` on mutation
  responses so the page's per-session latch is never switched off mid-interview). `useInterviewVoice`
  takes `silenceAutoCommitMs` instead of the removed `EXTERNAL_SILENCE_AUTOCOMMIT_MS` constant. The
  seconds input edits a draft and clamps on blur/Enter (no more per-keystroke snapping).
- Hardening from the pre-landing adversarial review: a silence auto-submit that fires while a
  submit is already in flight is dropped (the page mirrors `busy` in a ref the timer path checks), so
  a second `commitAnswer()` can never be resolved by the NEXT question's transcript; and an explicit
  `null` for any of the four new persona fields is rejected as 422 instead of surfacing as a
  misleading 409 from the NOT NULL column.
- Tests: +6 backend (per-engine defaults, bank/external pairs, session-snapshot engine, boundaries,
  mutation routes unreported, explicit-null 422), +1 admin round-trip/validation; frontend +6 rail
  tests (new `ConfigurationRail.test.tsx`), +4 form round-trips, +3 page tests (latch, off, no
  double commit), hook matrix extended (bank arms too; default-off never arms for
  bank/external/0/null/NaN/Infinity/negative).

## 0.38.0.2 (2026-09-23)

### Changed
- **Project default model is now `gpt-5-mini` everywhere, with `gpt-4.1-mini` as the documented
  second choice.** Applies to the interviewer agent chat model (`FOUNDRY_AGENT_MODEL`) and the Voice
  Live session model (`VOICE_LIVE_DEFAULT_MODEL`): backend code defaults, `backend/.env.example`,
  the Azure bicep parameter defaults and parameter files (`infra/azure/` and the client
  `delivery/infra/` package), the delivery README and 手册, `docs/VERIFICATION.md`,
  `docs/IMPLEMENTATION-STATUS.md`, `docs/azure-resources/README.md`, and the admin config
  placeholder. The public deployment's Container App env was switched the same day and verified
  live (voice + Lisa avatar connect on `gpt-5-mini` after a fresh boot).
- **Why:** the public site's voice had been failing with `Model gpt-5.4-mini is not supported in
  this region` — since v0.37.4.6 the Voice Live model resolves persona → master config → env, and
  the first two carried the chat model. Voice Live only accepts models it hosts natively in the
  resource's region (Learn → Speech regions → Voice Live tab); deployments on your own resource do
  not count. Live-probed on Sweden Central 2026-09-23: accepted `gpt-5-mini`, `gpt-4.1-mini`,
  `gpt-5.6-terra`, `gpt-5.4`, `gpt-5.1`, `gpt-5-nano`, `gpt-4.1-nano`, `gpt-4o`, `gpt-4o-mini`,
  `gpt-realtime-2.1`/`2.1-mini`/`1.5`; rejected `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.4-mini`,
  `gpt-6-luna`, `gpt-6-sol`, `gpt-6-astra`. Using one model that works for both roles keeps a
  fresh (ephemeral-SQLite) boot consistent without code changes.

## 0.38.0.1 (2026-09-23)

### Fixed
- **Photo avatars (Adrian, Amara, …) now connect in voice mode** (#103). Picking any avatar from the
  editor's **Photo** tab made the Playground and the candidate `/interview` page fail to connect
  (owner saw "The `type` field of SessionUpdatedMessage message should be 'session.update'"; today
  Azure reports it as `avatar_verification_failed: Avatar with character [adrian] and style [None]
  not found`). Root cause: Azure's standard **photo** avatars (VASA-1 talking heads) have no style
  and must be requested with `"type": "photo-avatar"` + `"model": "vasa-1"`; the session builders
  sent only `character`/`customized`/`video`, so Azure treated "adrian" as a **video** avatar and
  rejected the session. Video avatars (Lisa/Harry/Meg/Jeff/Lori/Max) were never affected.
  - New single source of truth `build_avatar_config()` / `is_photo_avatar()` in
    `voice_live_metadata.py` (rosters mirror `frontend/src/data/avatarCharacters.ts`) used by the
    WS-proxy session (`voice_live_proxy.build_avatar_session`), the `/calls` broker session and the
    agent metadata — photo → `type`/`model`, no `style`; video → `character` + `style` (a blank
    video style now falls back to that character's own default, e.g. Harry → `business`, instead
    of being sent as `null` or as Lisa-only `casual-sitting`, both of which Azure rejects). The
    agent metadata previously stamped `casual-sitting` onto photo avatars; that is dropped too (a
    photo avatar sent WITH a style is rejected by Azure). A backend test now parses the frontend
    roster file so the two avatar lists can never drift apart silently.
  - **Live-verified 2026-09-23** against real Azure in agent AND model mode, and end-to-end
    through the backend WS proxy: all 6 video avatars + 5 sampled photo avatars reach
    `session.updated` with `avatar.type` `video-avatar`/`photo-avatar` and ICE servers; a
    re-synced agent whose metadata carries the new photo shape initializes fine. +14 backend
    regression tests (wire shape for photo/video/blank/stale-style, metadata stays one ≤512-char
    key). No frontend behavior change.

## 0.38.0.0 (2026-09-22)

### Added
- **Candidates now sign in to take an interview.** `/interview` opens on a "Candidate sign-in" card;
  only a `user`-role account can start an interview (an admin account is told "Admin accounts cannot
  take interviews"). The candidate stays signed in for the tab's lifetime, a reload resumes the
  in-progress interview, and closing the tab then signing in again resumes the SAME interview
  (session creation is idempotent per account). A "Sign out" button clears everything and returns
  to the card. Usage rule: one account is used by one person at a time.
- **Three ready-made candidate accounts, visible to the admin.** `user1`, `user2`, `user3` are
  created on every boot with passwords derived from the deployment's `SECRET_KEY` (`xxxx-xxxx-xxxx`),
  so they are unique per deployment, survive an ephemeral-SQLite restart unchanged, and are never
  stored in plaintext. The `/admin` page gains a read-only **Users** tab that lists them with a Copy
  button, marks the admin row "not viewable", and shows "Reset required" if `SECRET_KEY` was changed
  after seeding. (Create / reset are intentionally not in this release.)

### Changed
- **`SECRET_KEY` is now required.** The backend refuses to start when it is missing or still the old
  placeholder — it signs every JWT and now also derives the candidate passwords, so a public default
  would make those passwords computable from the repo. Local dev: set it in `backend/.env`
  (`openssl rand -hex 32`, see `.env.example`); Azure and client deployments already inject it.
- `POST /public/candidate/session` requires `Authorization: Bearer <candidate JWT>`; the session row
  records `user_id`. All other interview endpoints are unchanged (`X-Anon-Session`).
- `GET /admin/users` items carry `generated_password` and `password_stale`.
- Migration `b8c9d0e1f2a3`: `users.password_generation`, `anonymous_candidate_sessions.user_id`
  (both nullable; downgrade-safe).
- **One live candidate session per account is now enforced by the database** (code review R2).
  Migration `c9d0e1f2a3b4` adds `anonymous_candidate_sessions.active_user_id` with a UNIQUE index:
  the live row holds the account's seat, expired/revoked rows release it (NULL), so two simultaneous
  first logins cannot mint two sessions — the loser reuses the winner's. Backfill claims the seat for
  rows that are live at upgrade time; downgrade-safe.
- **Login no longer leaks whether a username exists via response time** (code review R3). An unknown
  username pays the same bcrypt verify as a wrong password. Matters now that `/auth/login` is reached
  from the public interview page with well-known usernames (`user1..3`).
- A failed candidate-account seed at startup is logged with a traceback instead of swallowed silently
  (it still never blocks startup).
- E2E specs sign in as `user1` through a shared `e2e/helpers/candidateLogin.ts` (reads the derived
  password via the admin API, never hardcodes it).

## 0.37.4.7 (2026-09-22)

### Changed
- **Seeded interviewer persona is now strictly linear — no follow-up questions.** The client wants
  the simplest flow: one question, one answer, move on. The boot-seeded `prompt_fragment`
  (`persona_seed._PROMPT_FRAGMENT`, what every fresh public/client deployment boots with and what
  the Foundry agent's instructions are synced from) previously allowed "AT MOST ONE short
  follow-up", which is exactly where the digital human's extra probing came from in bank mode
  (server VAD auto-response + the "I'm done" `response.create` both give the model a free turn).
  The Guidance section now bans follow-ups of any kind, limits the post-answer turn to one short
  neutral acknowledgment ("Thank you."), allows only a verbatim re-read when the candidate asks
  to repeat, and the Role-boundary/Language wording no longer mentions follow-ups. Pinned by
  `test_seeded_prompt_is_linear_no_follow_ups`. Bank-level `max_follow_ups` is unchanged (the
  client's default bank already has 0 on every question). Prompt-level mitigation only: the model
  still gets a turn after each answer; a code-level silent-advance mode for bank personas is a
  separate follow-up. Persistent-DB installs keep their existing persona row (the seed is
  idempotent) — update the fragment in the digital-human editor to pick this up.

## 0.37.4.5 (2026-09-14)

### Fixed
- **External-mode reader contract now bans acknowledgment openers ("Understood." etc.) — issue 6.**
  The digital human's transcript showed lines like "Understood. How do you typically handle…" as
  if the external interview system had said them — but the "Understood." prefix was the MOUTH
  model's own conversational filler (verified: the stored external `speech_text` turns carry no
  such prefix, the codebase contains no "Understood" string, and one leaked bubble — "Understood!
  Please proceed with the next piece of text for me to read." — contained no external text at
  all). `default_external_reader_prompt` now explicitly requires the reply to begin with the
  FIRST word of the provided text and names banned openers ("Understood", "Got it", "OK", "Sure",
  "Thanks", "好的", "明白", "收到", "…or anything similar in any language"). Prompt-level
  mitigation: an LLM contract is not a hard guarantee, but the named-opener + first-word framing
  targets exactly the observed leak. Applies wherever the persona's `external_reader_prompt` is
  unset/blank (the seeded default persona); a custom stored prompt is untouched by design.

## 0.37.4.4 (2026-09-14)

### Fixed
- **Production had the chat-model-as-voice-model misconfig too — voice silently degraded to text
  on the public deployment.** A production comparison test (same instrumented flow as the local
  measurements) hit the same `"Model gpt-5.4-mini is not supported in this region"` loop:
  `infra/azure/main.parameters.json` set `voiceLiveDefaultModel: gpt-5.4-mini` (changed alongside
  the chat model — exactly the conflation v0.37.4.1 removed from the runtime overlay). Corrected
  to `gpt-4o` in the parameters file, hotfixed live via `az containerapp update --set-env-vars`
  (revision 0000032), and both infra copies' bicep `@description` now warn the param takes a
  VOICE-capable native model, never the agent chat deployment. Live-verified on production after
  the fix: voice channel auto-selected, 1080p avatar, face-before-voice.

### Changed
- **`docs/avatar-latency-ice-gathering.md` deep-dive expansion** (client review feedback): removed
  a client name; added why the wait-for-complete pattern was originally CORRECT (one-shot vanilla
  ICE signaling — the offer is sent once with no trickle channel), why relay-only makes the
  sufficient-set wait safe (before/after difference table), and the mechanics of WHY VPN
  interfaces stall gathering (silent UDP drops the browser can't distinguish from slow). The
  remaining-latency section now carries the measured LOCAL vs AZURE-PRODUCTION comparison —
  backend→Voice Live leg 2.5-2.7s → 0.95s when co-located in swedencentral (validating the
  deployment guidance), click-Start→avatar-frames 11.25s → 9.99s — plus per-item answers: the
  external-gateway leg collapses when the client deploys into their own network; the first-frame
  ~3.5s splits into user↔region RTT (region choice helps) and Azure-side render pipeline spin-up
  (irreducible, but paid once per interview and hidden by prewarm + the cached portrait).

## 0.37.4.3 (2026-09-14)

### Added
- **The interviewer's figure now appears instantly: cached portrait stands in while the live
  stream connects (issue 5).** The remaining seconds of avatar startup are network/service RTT
  (external gateway + Azure session + first 1080p frame) that the client cannot remove — so the
  wait moves to the perception layer instead: ~2s after the live avatar connects, a frame is
  captured from the video element (MediaStream frames never taint the canvas), downscaled to
  480px JPEG, and stored in localStorage; on every later visit the person shows IMMEDIATELY
  (slightly dimmed, with the existing "connecting" hint pill) and the live video fades in over
  the portrait — no orb flash in between. First-ever visit (or cleared storage / non-image slot
  value, which is rejected) falls back to the orb exactly as before. Single-slot cache by design
  (this deployment runs one default persona); a persona change self-corrects on the next session.
- **`docs/avatar-latency-ice-gathering.md`** — client-facing write-up of the digital-human
  latency investigation: when the 8s ICE-gathering stall bites (VPN/mDNS multi-interface
  networks), how the relay-candidate fast path fixes it, the full measured before/after stage
  breakdown (16.0s → 11.2s worst-case; ~0 perceived with orientation prewarm + the portrait
  above), and the lessons for avoiding the pattern (never block on gathering "complete";
  timestamp every wait; measure before optimizing; alert when a safety timeout is consistently
  maxed out).

## 0.37.4.2 (2026-09-14)

### Fixed
- **Digital human appears ~7.5s faster: the avatar ICE gate no longer stalls to its 8s cap.** The
  offer/answer handshake waited for the null-candidate signal or gathering "complete" — signals
  that never fire on networks with VPN/mDNS interfaces — so EVERY avatar connect sat out the full
  8s safety timeout before sending the SDP offer. Azure's avatar path runs over its TURN relay,
  so the handshake can proceed once one relay (or srflx) candidate is gathered: the gate now sends
  the offer after a 300ms settle window following the first usable candidate (null-candidate,
  gathering-complete, and the 8s cap all remain as backstops). Measured live: gathering→offer
  8.0s → 0.38s; click-Start→first video frame 16.0s → 11.2s (worst case, instant click-through —
  with normal orientation reading time the avatar is ready before "I'm ready" is clicked), and the
  avatar now becomes visible BEFORE the held first-question read is released instead of the
  6s hold expiring first.

### Added
- **Production nginx now caches the built frontend assets.** Vite's content-hashed `/assets/*`
  get `Cache-Control: public, max-age=31536000, immutable` (a release ships new hashed filenames,
  so a stale file can never be served), and `index.html` — the one un-hashed file that names the
  current assets — is `no-cache` so every load revalidates (cheap 304) and picks up a new release
  immediately. Local dev (Vite) is unaffected.

## 0.37.4.1 (2026-09-14)

### Fixed
- **Saving an admin config no longer breaks model-mode voice sessions (voice fell back to text).**
  `config_overlay` overlaid the master row's `model_or_deployment` — the agent's **chat**
  deployment (e.g. `gpt-5.4-mini`) — onto `voice_live_default_model`, but Voice Live MODEL mode
  takes a native voice-capable model name (gpt-4o family / realtime). The moment an admin saved a
  config with a model picked, every model-mode voice connect (external-brain personas, and the
  new v0.37.4.0 voice-by-default flow) failed with *"Model gpt-5.4-mini is not supported in this
  region"* and the interview silently degraded to the text channel. The overlay no longer touches
  the voice model; it stays env-configured (`VOICE_LIVE_DEFAULT_MODEL` > code default `gpt-4o`).
  Live-verified: with `gpt-5.4-mini` saved as the agent model, the voice session brokers `gpt-4o`,
  the interview auto-enters the voice channel, and the 1080p digital human streams.

## 0.37.4.0 (2026-09-14)

### Added
- **The interview's default channel now follows the interviewer persona's configuration.** The
  page always opened in the text channel; a fully voice-configured digital-human persona still
  required the candidate to find the voice pill. `/start` and the GET-resume route now return
  `voice_default: true` when the enabled default persona carries an operator-configured voice
  (any non-blank `voice_map` entry — `resolve_voice`'s built-in fallback deliberately does NOT
  count), and the page then auto-enters the voice + digital-human channel. The connection is
  **prewarmed at the orientation screen**: the seconds the candidate spends reading orientation
  copy absorb the WebRTC + avatar handshake, so the digital human is live the moment they click
  "I'm ready" — with the speak-question effect now phase-gated (nothing is read over the
  orientation screen; this also applies to a manual orientation-time voice click) and the mic
  auto-muted until the live phase (orientation-screen speech must not feed server-VAD or the
  pre-click transcript buffer that drains into the first answer). One attempt per interview: a
  failed connect or a manual switch back to text is never re-forced, and every existing
  degradation path (mic denied → dialog, connect failure → text) is unchanged. A persona without
  a configured voice — or no default persona — keeps text as the default.

## 0.37.3.2 (2026-09-14)

### Added
- **Admin Foundry card shows the effective auth mode and can clear a saved API key.** A stale
  saved key kept showing as "API key (saved: ****xxxx)" forever with no way to remove it, and
  nothing in the UI said keyless Entra ID / Managed Identity auth was actually in effect. The key
  input now has an auth-mode line underneath: keyless → "No API key saved — authenticating with
  Entra ID / Managed Identity."; key saved → "API key saved (****xxxx) — used as fallback; Entra
  ID / Managed Identity is tried first." plus a **Clear key** button. Clearing sends the new
  `clear_api_key: true` on the config PUT, which deletes the stored key (blank `api_key` still
  preserves it, so re-saving other fields from the masked UI stays safe; `clear_api_key` wins if
  both are sent).

## 0.37.3.1 (2026-09-14)

### Fixed
- **Admin "Test connection" now works keyless (Entra ID / Managed Identity) and probes the right
  API.** The probe previously required a saved API key and always hit the legacy
  `/openai/deployments` path — which returns 404 on `services.ai.azure.com` Foundry resources
  regardless of auth, so a correctly-configured key-disabled resource showed "Endpoint returned
  404." It now mirrors the runtime auth strategy (Entra bearer first, saved key as fallback),
  probes the Foundry project deployments API when a project is set, resolves the connection the
  same way runtime does (DB row, `.env` field-by-field fallback), and reports which auth
  succeeded ("Connection succeeded (Entra ID).") or why each attempt failed — a 404 with a
  project set now hints "check the project name" instead of reading like a broken endpoint.
- **Admin UI says the API key is optional.** The Foundry connection card and the key input's
  placeholder now state that a blank key means Entra ID / Managed Identity auth (required for
  key-disabled resources) and a saved key is only a fallback, instead of implying a key is
  expected.

## 0.37.3.0 (2026-09-11)

### Added
- **Boot seed can now pin the default persona's interview brain (`SEED_PERSONA_BRAIN`).** The
  ephemeral-SQLite deployment reseeds the default persona on every boot with
  `interview_brain="bank"`, so an external-brain deployment silently reverted to bank mode on each
  restart and an operator had to re-toggle it in the editor — the brain setting was the one piece of
  external-mode config that did NOT survive a release/restart (endpoint/key already env-seed via
  `seed_external_config_from_env`, and the reader-prompt default lives in code). Now
  `SEED_PERSONA_BRAIN=external` makes `persona_seed.seed_default_persona` seed the default persona
  external-ready (values outside `BRAIN_MODES` fall back to `bank` with a boot log warning, never a
  crash), and the optional `SEED_PERSONA_READER_PROMPT` seeds a custom reading contract (empty =
  `NULL` = use the generated `default_external_reader_prompt`). Default behavior unchanged
  (`bank`) — the public demo deploy is unaffected unless the env var is set.

## 0.37.2.0 (2026-09-11)

### Added
- **External-mode interviewer persona gains its own independent reader prompt (`external_reader_prompt`).**
  The interviewer persona now carries **two independent, separately-stored, separately-editable** prompt
  config items instead of one: the existing `prompt_fragment` (bank mode → the Foundry agent's
  `instructions`) and a NEW `external_reader_prompt` (external mode → the reading contract that shapes how
  the persona "mouth" reads the backend-injected `speech_text`). They are two independent nullable
  columns, **not** one field the `interview_brain` toggle swaps — switching the brain back and forth never
  destroys the other prompt's content. `NULL`/blank means "unset, use the generated default"
  (`default_external_reader_prompt(name)`), so an existing persona keeps working with no migration of its
  data. Because external mode connects in **MODEL mode** with no Foundry agent (v0.37.1.9) and Azure
  rejects `instructions` overrides in `response.create`, the reader contract is delivered as a
  connect-time **system conversation item** (`build_reader_prompt_item`, parallel to
  `build_language_pin_item`), injected in `voice_live_proxy.run_proxy` right after the language pin when
  the session is external. The editor shows/edits only the active mode's field (bank → Instructions;
  external → Reader prompt), with the generated default surfaced as the placeholder. `reconcile_persona`
  never touches the new column (it has no Foundry agent behind it). Additive, dormant, nullable migration
  `f6a7b8c9d0e1` (`down_revision = "e5f6a7b8c9d0"`), no backfill. Plan:
  [`docs/planning/plan-external-reader-prompt-20260911.md`](docs/planning/plan-external-reader-prompt-20260911.md).

## 0.37.1.9 (2026-09-11)

### Fixed
- **External voice: question header and interviewer transcript now match (root cause: two competing
  brains).** In external-brain voice interviews the INTERVIEWER header card ("Question 2: …") and the
  latest spoken interviewer bubble in the transcript below it ("Question 4 of 9: …") showed *different
  questions* — plus leaked meta-instructions ("Please answer the question:") and improvised follow-ups
  ("Could you clarify…"). Root cause was architectural, not a display race: the default `Interviewer`
  persona has `interview_brain=external` **and** still carries a hosted Foundry `agent_id`. The
  Voice Live connection layer chose agent-vs-model mode purely from `bool(persona.agent_id)`, so an
  external session connected in **agent mode** — attaching a hosted Foundry interviewer agent that
  became a **second, independent brain**. Two brains ran at once: the external workflow's `display_text`
  populated the header while the hosted agent spoke its own pool of questions (the transcript is the
  avatar's actual spoken audio), so the two diverged. The v0.37.1.6/1.7 fixes only closed *model-mode*
  improvisation paths and had no effect on a hosted agent's own orchestration. Fix: enforce the correct
  invariant at the connection layer — when `interview_brain == "external"`, force **MODEL mode** (ignore
  `agent_id`, connect with the plain `voice_live_default_model`) so the Azure side is a pure "mouth"
  reading the backend-injected `speech_text`, never a second brain. Applied in **both** voice paths
  (`voice_live_proxy.run_proxy` — the live avatar WS proxy; and `voice_broker.create_voice_session` —
  the WebRTC broker), and the P5 `agent_sync_status` gate is now skipped for external personas in both
  (`voice_live_ws` + `voice_broker`), since a persona that deliberately ignores its agent shouldn't be
  gated on that agent being synced. The avatar is unaffected (its config is independent of the
  agent/model choice). Covered by a new `test_voice_broker` regression asserting an external persona
  with an un-synced `agent_id` still yields a MODEL-mode session (no `agent-name=` in the signaling URL).

## 0.37.1.8 (2026-09-11)

### Added
- **Hands-free turn advance in external voice mode: silence auto-commit (~3s) + kept "I'm done"
  button.** In external-brain voice interviews every finished answer triggers one external API call
  to fetch the next turn, so "when is this turn done" is a client-side boundary decision (the
  external API is request/response and never hears live audio). Previously the candidate had to click
  "我说完了 / I'm done answering" after every answer — clunky for a back-and-forth conversation. Now,
  after the candidate stops speaking and stays silent for `EXTERNAL_SILENCE_AUTOCOMMIT_MS` (3s), the
  buffered answer auto-commits and advances — any new speech within the window resets the timer, so a
  mid-answer pause to think won't submit early. The "I'm done" button stays as an immediate manual
  override (P13). Server-VAD splits one answer into several transcript segments on pauses, so segments
  are buffered and joined before commit (this is why we wait 3s of silence, not fire on every
  `transcription.completed`). No double-fire: after auto-commit the turn goes busy → `useExternalMicAutoPause`
  mutes the mic → no new speech re-arms the timer, and the timer nulls itself and is cleared in
  `commitAnswer` / cleanup / on `speech_started`. Bank mode never arms the timer (gated on
  `externalMode`). Implemented via a new `onSilenceAutoCommit` option on `useInterviewVoice`, wired in
  `InterviewPage` to the same commit-and-advance path the button uses. The 3s threshold is a hardcoded
  constant for now; whether to make it configurable (per persona / role / pace) is flagged as a client
  discussion item (see `docs/planning/discuss-external-question-presentation-20260911.md` 议题 4).
  Covered by 3 new hook tests (auto-commit after ~3s; speech resets the timer; bank mode never arms).

## 0.37.1.7 (2026-09-11)

### Fixed
- **Digital human no longer improvises follow-up questions in external voice mode (issue5 — the
  second improvisation path).** After v0.37.1.6 closed the server-VAD auto-response path, external
  voice interviews still showed the avatar asking off-script follow-ups that quoted the candidate's
  just-spoken answer (e.g. *"Could you clarify what you mean by 'organize them as the organization
  chart'?"*) — questions the external brain never produced, never scored, and that never appeared in
  the question header or `interview_turns`. Root cause: `commitAnswer()` (the "I'm done answering" /
  P13 path) fires a bare `response.create` to advance the turn, and in agent mode a *bare*
  `response.create` makes the hosted Foundry agent autonomously generate a turn from its own generic
  instructions — i.e. an improvised follow-up. v0.37.1.6's `create_response=False` only suppressed
  the *server-VAD* auto-response, not this explicit nudge; worse, with the auto-response gone the
  nudge now fires on *every* commit (nothing else holds `activeResponseRef`), so the agent improvised
  after every answer. Fix: `commitAnswer` skips the bare `response.create` when the session is
  external (new `externalMode` option on `useInterviewVoice`, wired from `interview.external_phase`).
  External turns advance via the backend → `speakQuestion` verbatim read only; the agent stays a pure
  "mouth". Bank sessions are unchanged — their agent still drives the turn, so the nudge remains.
  This is the frontend complement to the backend `create_response=False` fix: together they close
  BOTH bare-`response.create` paths so an external-brain agent can never improvise. Follow-ups, if
  wanted, belong to the external workflow (decided: Approach A — see
  `docs/planning/discuss-external-question-presentation-20260911.md`). Covered by a new
  commitAnswer external-mode test asserting no `response.create` is sent.

## 0.37.1.6 (2026-09-11)

### Fixed
- **Digital human no longer improvises its own questions in external voice mode (issue3 + issue4 —
  one root cause).** In external-brain voice interviews the avatar would (issue3) speak the same
  question twice, rendering two Interviewer bubbles, and (issue4) ask a *different* question than the
  one shown in the top question header — even leaking its internal meta-instruction
  ("Please answer the question as the candidate: …"). Root cause: the Voice Live turn-detection was
  built with `create_response=True` for *every* persona, so the moment the candidate paused, Azure
  auto-generated a spoken agent turn from the persona's own instructions. But an external persona has
  no interview logic of its own — it is purely the external brain's "mouth", meant to read exactly
  the `speech_text` the backend injects (via an explicit `response.create`) and nothing else. The
  auto-response therefore (a) competed with the injected verbatim read → two Azure responses → two
  bubbles (issue3), and (b) diverged from the external-brain-driven `display_text` header → the top
  question and the spoken question no longer matched (issue4). Fix: `build_avatar_session` now sets
  `create_response=False` when `persona.interview_brain == "external"`, so the agent never generates
  a turn on its own — the only audio it produces is the injected `speech_text`, which stays in
  lockstep with the header `display_text`. VAD still detects end-of-utterance and transcribes in both
  modes (candidate-answer capture unaffected; external advances via "I'm done answering" /
  `commitAnswer`), and barge-in stays enabled. Bank personas keep hands-free auto-response — their
  agent does drive the turn — and are unaffected. Covered by a new
  `test_avatar_session_disables_auto_response_for_external_brain` guard (azure-equipped envs).

## 0.37.1.5 (2026-09-11)

### Fixed
- **Mute button no longer reverts to "unmute" in external voice mode (issue2).** In external-brain
  voice interviews, clicking Mute flipped straight back to unmuted. Root cause: the mic auto-pause
  effect (pause while the interviewer produces the next turn / a stalled turn awaits 恢复) depended
  on the voice object, whose identity changes every render, so it re-ran on every render and
  re-asserted `setMuted(shouldPause)` — during an open turn `shouldPause` is false, so each unrelated
  re-render fired `setMuted(false)` and clobbered the candidate's own Mute click. Extracted the logic
  into `useExternalMicAutoPause`, which drives the mic only on *transitions* of the pause condition
  (last value tracked in a ref); an unrelated re-render is now a no-op and a manual mute sticks. The
  auto-pause-on-awaiting / unpause-on-reopen behavior is preserved. Bank mode was never affected.
  Regression bug dated to the Phase-2 external brain (v0.37.0.0 / PR #76); now covered by four
  `useExternalMicAutoPause` unit tests (manual-mute-sticks, pause/unpause transitions, inert while
  inactive, clean re-pause after reconnect).

## 0.37.1.4 (2026-09-11)

### Fixed
- **Orientation copy no longer says "You'll answer 0 questions" in external mode.** External-brain
  interviews expose no fixed question count (the interviewer drives the flow turn by turn), so the
  count-based orientation line interpolated `total` as `0`. The orientation card now shows a
  count-free variant (`orientation.bodyExternal`, both locales) whenever the session is external
  (`interview.external_phase != null`); bank interviews keep the original "{{total}} questions" copy.

## 0.37.1.3 (2026-09-10)

### Tests
- **Two CI-only E2E stabilizations (harness-only, no assertions weakened, no product code).**
  - *Scored-report journey: real timeout headroom (180s).* The admin-authors-a-bank → full
    interview → scoring → report test legitimately runs close to the 60s default per-test budget
    even on the mock provider, so a congested CI runner tipped it into timeout — main went red
    twice on a pure runner-speed lottery while the identical code was green on the PR run minutes
    earlier.
  - *External-config spec: close a probe/save status race.* After clicking test-connection the
    spec only asserted a visible non-empty status — which the earlier save's "Saved." already
    satisfies — so on runners with slow NXDOMAIN resolution the probe's failure text landed AFTER
    the closing reset-save and overwrote its "Saved.", failing the final assertion. The spec now
    waits for the probe result itself (status leaving "Saved.") before moving on.

## 0.37.1.2 (2026-09-10)

### Tests
- **Opt-in LIVE voice + external-brain E2E (`external-voice-live.spec.ts`) — the exact demo
  combination.** The default VOICE persona (digital human) is temporarily pointed at the external
  brain (original brain restored afterwards) and a full interview runs on the real dev servers:
  the external question's `speech_text` is asserted SPOKEN via real Azure voice (`response.done`),
  Chromium's fake mic (`FAKE_AUDIO` WAV) answers each question, server-VAD transcripts are
  committed through the real "I'm done answering" flow (≥3 turns), and the session ends on the
  external completion acknowledgement — with the P12 no-local-report and P3 no-leak assertions.
  Run: `LIVE_VOICE_EXTERNAL=1 LIVE_ADMIN_PW=... FAKE_AUDIO=/tmp/answer-raw.wav npx playwright test
  --config=e2e/live.config.ts external-voice-live`. Live-verified (1 passed, 2.6m, 2026-09-10).

## 0.37.1.1 (2026-09-10)

### Tests
- **Opt-in LIVE external-brain E2E (`external-interview-live.spec.ts`).** Drives the real running
  dev servers and the REAL external interview server using the endpoint/API key an admin saved in
  the Connection tab — nothing hardcoded, proving the stored config is what the backend uses.
  Health-probes via the admin test-connection path, points the default persona at the external
  brain (restored afterwards), then completes a full candidate interview in the browser until the
  external server declares the session done; asserts hidden question count, the completion
  acknowledgement instead of a local report (P12), and no rubric/score leakage (P3). Run:
  `LIVE_EXTERNAL=1 LIVE_ADMIN_PW=... npx playwright test --config=e2e/live.config.ts
  external-interview-live`. Live-verified end-to-end (59s, 2026-09-10).

## 0.37.1.0 (2026-09-10)

### Fixed
- **External interview transport: drop the explicit `Accept: text/event-stream` request header —
  it 401'd against the live gateway.** The first live run of the external HTTP channel (the 0.37.0.0
  E2E used the mock provider) surfaced a gateway quirk: its auth layer rejects any request carrying
  `Accept: text/event-stream` with 401 "Access token is invalid" (code 4001), while the identical
  request under the default `Accept: */*` returns 200 and streams SSE normally — confirmed with
  back-to-back A/B pairs on the same key after ruling out key rotation, IP allowlisting, the `user`
  tag, and the hex payload. The client now sends no explicit Accept header; the response
  content-type check still guards the stream shape. Live-verified end-to-end: admin test-connection
  OK plus a full real interview (9 questions, opaque state round-tripped every turn,
  `session_complete` on turn 10).

## 0.37.0.1 (2026-09-05)

### Tests
- **E2E harness: supply a throwaway `ENCRYPTION_KEY` to the mock-provider backend.** The new
  external-config E2E (`external-config.spec.ts`, shipped in 0.37.0.0) is the first e2e to exercise
  the Fernet API-key encryption path on save. The Playwright `webServer` backend command booted on
  mock providers with no `ENCRYPTION_KEY` and debug off, so the encrypt-on-save raised
  `EncryptionKeyMissing`, the save 500'd, and the spec's "Saved." assertion timed out — reddening
  CI while production stayed unaffected (it supplies `ENCRYPTION_KEY` as a Container App secret).
  Added a test-only Fernet key to the harness env alongside the mock-provider vars. Harness-only;
  no product code changed.

## 0.37.0.0 (2026-09-05)

### Added
- **External interview brain — a vendor-neutral "external" interview mode (SPEC Phase 2).** A
  persona can now be backed by an external interview API/server instead of the built-in question
  bank: the backend drives that endpoint turn-by-turn as a plain API client (never a Foundry-agent
  tool), vendor-neutral throughout — no product name appears anywhere in code, config, or UI; the
  mode enum is simply `external`.
  - **Data layer.** `InterviewSession` gains `external_*` columns (brain-mode snapshot, opaque
    state blob, last public response, `external_phase` sub-state, `turn_version` CAS counter) and
    `InterviewerPersona.interview_brain` (Alembic `e5f6a7b8c9d0`). `external_phase` is a sub-state
    of `in_progress`, so resume works unchanged for external sessions.
  - **Transport + orchestration.** A hex-encoded POST client with a defensive SSE parser
    (chunk-split tolerant, content-type checked, 1 MiB cap, display scrub) and a commit-before-speech
    runner with a CAS turn lock and bounded auto-retry (stateless ⇒ safe) that degrades to
    `recovery_required`. **The opaque external-state blob lives ONLY in `InterviewSession.external_state`
    — never in a turn row, the public response, the browser, or any LLM (SPEC P3/P12).**
  - **Config.** `external_interviewer_{endpoint,api_key,user_tag}` settings (blank in CI/dev ⇒ mock
    provider) with a Fernet-encrypted key, an https/SSRF endpoint guard, env-fallback resolve, and a
    boot seed. The production key is entered by an admin in the admin UI (write-only + reveal +
    test-connection on the Connection tab); the env value is a test-only fallback.
  - **Frontend.** Persona-editor "Interview brain" selector (bank/external), the admin "External
    interview API" config card, and `InterviewPage` external phases — an awaiting overlay driven by
    the in-flight turn, a resumable recovery affordance, mic auto-pause while awaiting/stalled,
    `speech_text` TTS wiring, hidden question-progress (external exposes no count), and a completion
    card with **no local report (P12)**. Candidate copy is bilingual (zh-CN + en-US); operator
    surfaces stay English.

### Fixed
- **Keyless managed-identity deployments now get a live Voice Live credential.** The Azure voice
  provider was registered only when BOTH a Foundry endpoint AND an API key were configured, so a
  keyless client hand-off deployment (backend MI granted Cognitive Services User, no api-key env)
  silently fell back to the mock provider and the digital human never received a real credential.
  Registration now guards on the endpoint alone — `AzureVoiceProvider` is Entra-first
  (`DefaultAzureCredential` → Managed Identity), issuing a real bearer with no key; the key remains
  an optional STS fallback for key-auth-enabled resources.

### Infrastructure
- **Single static egress IP for the Container Apps environment.** A NAT gateway with one Standard
  static public IP is attached to the infra subnet, collapsing all outbound traffic onto one fixed
  address (`natEgressIp` output) that a partner API can allowlist — instead of the workload-profiles
  platform pool of 100+ mutable egress IPs.
- **`enableGithubOidc` toggle for client hand-off deployments.** The GitHub-deploy MI role grants
  (Contributor + AcrPush) are now created only when the GitHub OIDC auto-deploy path is enabled;
  a client deploying in its own tenant with no GitHub identity sets `enableGithubOidc=false` and the
  backend MI grants are still created. Dropped the now-stale MCAPS Key Vault policy notes across the
  Bicep + docs (runtime secrets are Container App native secrets).

### Tests
- **Scored-report E2E tolerates real-provider latency.** `admin-and-report.spec.ts` timed out at the
  `report-exec` assertion on any dev machine whose `.env` carries a real Foundry endpoint (boot-seed
  + config-overlay flip scoring from the harness mock to the live provider, ~24s total, past the 10s
  default expect timeout). That one wait now has a 60s budget so the real-connection run completes;
  CI's mock provider still finishes far inside it. No product code touched, no provider forced.

## 0.36.0.4 (2026-09-01)

### Added
- **Boot-time import of client bank bundles delivered via the private-blob channel.** A new
  `question_seed.seed_client_banks` imports every `*.json` bank bundle under `CLIENT_BANKS_DIR`
  (default `/app/_client_bundle/extra_banks`) on each boot, alongside the committed generic bundles
  and the rf-CSM client importer. This is how client-derived banks (e.g. the rf-CSM demo01 bank,
  which carries SOP `source_quotes`) reach the ephemeral server **without ever being committed to
  this public repo** — the private bundle zip extracts its `extra_banks/` into place and the seeder
  picks it up. Each bundle is forced non-default (the rf-CSM importer keeps the enabled-default
  slot) and imported idempotently-by-name, so re-running on every boot converges. No-op in
  public-demo mode and CI, where the directory is absent.

### Notes
- Shared the default-slot-preserving import loop between `seed_bundled_banks` (committed generic
  banks) and `seed_client_banks` (private client banks) via `_import_bank_bundles`.

## 0.36.0.3 (2026-09-01)

### Fixed
- **Admin surfaces (`/admin`, `/admin/agent`) now follow the header language selector instead of
  always showing hardcoded bilingual `中文 / English` labels.** Every user-facing string on the
  admin/content editor and the agent-editor login gate was a concatenated `"已保存 / Saved"`-style
  literal, so the selector (which drives i18n everywhere else) had no effect there. These are now
  `t()` keys under a new `admin` namespace in `i18n.ts` (en-US + zh-CN), so choosing English shows
  only English and choosing Chinese shows only Chinese — a single language, matching the rest of the
  app. Login gates, tab labels, bank/question/rubric controls, placeholders, and status messages are
  all covered. The Azure connection tab was already English-only and is unchanged.

### Notes
- No behavior change beyond copy: the same `data-testid`s and control flow are preserved. The
  role-rejection error message now renders in the selected language (English by default).

## 0.36.0.2 (2026-09-01)

### Fixed
- **The deployed server now presents the full generic bank catalogue, not just one bank.** The
  boot-time client importer seeds the rf-CSM bank as the enabled default, and the FastAPI lifespan's
  `seed_default_bank` is a no-op once any default exists — so on live the other generic banks never
  seeded and admin showed a single bank (local had several). Fix: the three generic, SOP-document-free
  banks (Demo interview bank, Deployment SOP Interview, test-demo01) are now committed as bank bundles
  under `backend/app/seeds/banks/*.json` and imported on every boot by a new
  `question_seed.seed_bundled_banks`, alongside whatever default the client importer set. The bundle
  importer writes each bank's hand-authored rubric verbatim (unlike the per-question LLM auto-draft),
  so the seeded banks are fully scoreable. All bundle content is normalized to `en-US`.

### Notes
- The seeder preserves the enabled-default slot across the import: on live the client rf-CSM bank
  stays default; in public-demo mode (no client bundle) the same-named "Demo interview bank" bundle
  replaces the programmatic default as non-default, and the seeder restores it so the interview never
  drops to the built-in fallback pair. Idempotent-by-name, so re-running on each boot converges.
- Client-derived banks are **not** committed to this public repo; they continue to arrive via the
  private-blob channel (`entrypoint.sh` → `fetch_client_bundle.py` → `import_rfcsm_bank.py`).

## 0.36.0.1 (2026-09-01)

### Fixed
- **Voice interview: a follow-up was spoken and rendered twice.** In a voice session a clarifying
  follow-up (e.g. "Could you clarify what you mean by 'First'?") appeared as two identical
  Interviewer bubbles and was read aloud twice. Root cause: two independent Azure responses voiced
  the same follow-up — the agent's own server-VAD auto-response (`create_response=True`, driven by
  the persona's "ask AT MOST ONE short follow-up" instruction) AND the frontend verbatim-reading the
  backend `build_follow_up_prompt` text. Each was a distinct `response_id`, so transcript upsert
  (keyed by `assistant-${response_id}-${item_id}`) appended two bubbles. The backend now marks the
  current question with `is_follow_up`, and the frontend suppresses its verbatim read for
  follow-ups — in voice the agent owns follow-ups (as `memory.py`'s design already intended); the
  backend follow-up text stays authoritative for the text channel + CI.

## 0.36.0.0 (2026-09-01)

### Changed
- **App-wide default interview language is now English (`en-US`) instead of Chinese (`zh-CN`), across
  all four layers, including existing stored data.** Previously every "default language" fell back to
  `zh-CN`: the agent editor's Language selector (B), the auto-seeded default persona (C), a new user's
  `preferred_language` (D), and the question-bank / question / interview-session language (E). New
  creations now default to `en-US`, and a data-backfill migration flips every existing row still on
  the old `zh-CN` default. Layer by layer:
  - **B — persona editor default locale.** `EDITOR_LOCALES` reordered to `["en-US", "zh-CN"]` so the
    load-bearing index-0 (used by `normalizeLocale`'s fallback and `emptyPersonaForm`) is English;
    `PersonaCreate.default_locale` and the `InterviewerPersona.default_locale` column
    `default`/`server_default` are `en-US`.
  - **C — seeded default persona.** `persona_seed` `_VOICE_MAP`/`_GREETING_MAP` now list `en-US`
    first (fixing the `next(iter(...))` last-resort fallback), and the seeded persona sets
    `default_locale="en-US"` explicitly.
  - **D — new user language.** `User.preferred_language` default is `en-US`.
  - **E — bank / question / session language.** `QuestionBank.language`, `Question.language`, the
    `seed_default_bank` / `create_bank` / `add_question` service defaults, the admin `BankIn` /
    `QuestionIn` schema defaults, and the bank-bundle import fallback all default to `en-US`. This
    also **corrects a pre-existing content/tag mismatch**: the demo bank's 10 questions were already
    English prose but were tagged `zh-CN`.
  - Also flipped `voice_live_metadata.FALLBACK_LOCALE` (the `resolve_voice` fallback that had been
    quietly pulling `en-US` requests back to a Chinese voice) and `build_follow_up_prompt`'s default
    `locale` to `en-US`.
  - **Existing-data migration** (`d4e5f6a7b8c9`): moves the `interviewer_personas.default_locale`
    `server_default` to `en-US` (via SQLite batch mode) and backfills `interviewer_personas`,
    `users`, `question_banks`, and `questions` rows still equal to the old `zh-CN` default → `en-US`.
    Backfill is scoped to `= 'zh-CN'`, so an operator's deliberately-chosen non-Chinese locale is
    preserved. The deployed server runs on ephemeral SQLite (reseeded per boot), so the migration
    mainly protects local/persisted DBs and makes bare `INSERT`s default to English.
  - UI chrome language (`i18n`), `voice_broker.DEFAULT_LOCALE`, the voice-live proxy locale pin, and
    the frontend voice hook were already `en-US` and are unchanged. The `zh-CN` locale remains fully
    supported — this changes only the *default*.

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
  secrets** (encrypted at rest by the platform). The secrets never enter the repo — they are passed
  as `@secure()` Bicep params from the gitignored `main.parameters.json`.
- **Boot-time self-seeding for ephemeral SQLite (no DB PaaS).** New `backend/entrypoint.sh` runs
  `alembic upgrade head` → optional private-blob client-bundle fetch + import
  (`backend/scripts/fetch_client_bundle.py`, MI auth) → `exec uvicorn` (lifespan seeds the generic
  demo bank + admin). Replaces the reference's separate bootstrap Job, which can't seed a per-replica
  ephemeral DB. `CLIENT_BUNDLE_BLOB` unset → public-demo mode (generic bank only). **This first
  deploy ships in public-demo mode:** the subscription policy force-disables the Storage account's
  public network access, so the "private blob pulled at boot"
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
