# Judged turn mode: an LLM judge decides nudges, follow-ups and redirects for question-bank interviews (replaces the Foundry-agent turn)

> Filed as GitHub issue [#114](https://github.com/huqianghui/AI-interview-vibe-coding/issues/114) on 2026-09-24 via `/spec` (codex quality gate 7/10, redaction scan clean, public repo). Promoted from the local gstack spec archive per the project rule that planning documents live in `docs/planning/`. Status: **spec + engineering review complete (2026-09-24) — not yet implemented**; see the review addendum at the end, which supersedes conflicting sections.

## Context

Since v0.38.2.0 question-bank (bank) interviews default to **linear turns**: the digital human only reads each question and is silent while the candidate answers. Client feedback after seeing it: "数字人太冷、不像面试官" — they want an interviewer that **nudges a candidate who trails off, follows up on a thin answer, and pulls a wandering answer back**, without the old per-pause "Thank you." noise. The pre-0.38.2.0 alternative (`bank_turn_mode: "model"`, the Foundry agent speaking in its own server-VAD turn) cannot deliver that: Azure's `create_response` is a single boolean, and live runs (2026-09-24) showed the agent's instructions hijacking even the question reads. This spec moves **all** between-question decisions to the backend, which is the project's standing architecture (2026-08-10 decision: the backend state machine is the single decision maker; the model only renders).

## Current State (verified 2026-09-24, main @ ffe271b)

| Piece | Today | Gap |
|---|---|---|
| `bank_turn_mode` (`backend/app/models/persona.py:249`) | `linear` (default) / `model` | `model` is the unreliable agent-turn path; to be replaced |
| Follow-ups (`backend/app/interview/state_machine.py:182-201`) | Deterministic: if `follow_ups_asked < question.max_follow_ups`, `memory.build_follow_up_prompt()` composes "You mentioned «…» — <follow_up_prompt>" | Always asks when owed, never targets the missing rubric point, never detects off-topic |
| Follow-up language | `_infer_locale(question.prompt)` heuristic (`state_machine.py:577`) | `QuestionBank.language` exists and is authoritative |
| `max_follow_ups` | Column + `admin_questions.py:54,63,74` accept it; **no input in `AdminPage.tsx`**; the bank importer leaves it 0 | Admins cannot enable follow-ups today |
| Rubric for a question | `Question.expected_points` (JSON list) + `ChecklistItem(kind required/recommended/forbidden, text, weight)` (`models/checklist.py:41-65`) | Backend-only (P3) — exactly what a judge needs, never sent to the browser |
| LLM access | `get_llm_adapter(provider).complete(prompt, json_mode=True)` (`scoring_service.py:47-51`) | Reusable as-is |
| Voice session VAD (`voice_live_proxy.py:240`) | Hardcoded `AzureSemanticVad(create_response=not linear)`; persona `turn_detection` / `eou_detection` knobs only feed the `/calls` metadata builder | Proxy ignores EOU; SDK 1.3.0b1 has `AzureSemanticVadMultilingual` + `EouDetection` |
| Silence timer (`useInterviewVoice.ts:636-652`) | Re-armed per transcript segment; drives admin-controlled auto-submit | Second consumer (judge) not wired |
| Text channel | Same `answer_finalized`; template follow-ups apply equally | No nudge concept |

## Proposed Change

One backend **judge** (`backend/app/interview/judge.py`) answers, for the current question, "does the interviewer need to say anything, and what?" It runs in two moments with a shared output vocabulary:

```
verdict ∈ { wait | nudge }                       — PRE-COMMIT (candidate paused / stopped typing)
verdict ∈ { accept | follow_up | redirect }      — AT COMMIT (I'm done / auto-submit / text submit)
speech_text: str  (empty for wait/accept; session-language text otherwise)
reason: str       (internal, stored in judge_events, never shown)
```

- **Pre-commit** trigger: voice — an end-of-utterance transcript arrives and the candidate stays silent `judge_silence_seconds`; text — the textarea is non-empty and idle `judge_silence_seconds`. `nudge` speaks/shows one short line ("Please go on." / "请继续。" class). Capped at `judge_max_calls_per_question` **pre-commit calls** per question (commit-time judging is not counted); further pauses are silent. **Never blocks or submits anything.**
- **At commit** the explicit submit is never refused. The judge runs **only if** `follow_ups_asked < question.max_follow_ups` (so `max_follow_ups = 0` ⇒ zero judge calls at commit, today's advance). `follow_up` targets the most important missing `required` (then `recommended`) checklist item *by guiding around it*; `redirect` handles an off-topic answer with a "let's come back to the question" lead-in. Both are recorded as the existing `turn_kind="follow_up"` interviewer turn and consume one `max_follow_ups` slot. `accept` advances. When slots are exhausted the answer is accepted regardless (an off-topic answer simply scores low).
- **P3 guard**: the judge prompt forbids quoting `expected_points`/checklist text and forbids "you missed X" phrasing; a post-check normalizes both sides (lowercase, strip punctuation and whitespace) and rejects any `speech_text` that shares a 6-word run (Latin) or an 8-character run (CJK) with any `expected_points` / checklist string; rubric strings shorter than the window are matched as whole normalized substrings when ≥ 4 words / ≥ 6 CJK characters. A hit ⇒ treated as `accept` (commit) / `wait` (pre-commit) and logged as `leak_blocked`.
- **Failure policy**: adapter error, timeout (3 s), unparsable JSON, a missing or empty `speech_text` for `nudge`/`follow_up`/`redirect`, a `speech_text` over 300 characters, or a verdict outside the allowed set for that moment ⇒ `wait` (pre-commit) / `accept` (commit), logged as `verdict='error'`. Extra/unknown JSON fields are ignored. Never a template fallback (owner decision).
- **Concurrency & staleness**: `POST /judge` carries `question_id` and `follow_ups_asked`; a mismatch with the server's current question/follow-up index ⇒ `wait` without an LLM call. At most one in-flight pre-commit judge per session (frontend guard; a second concurrent request is a 409 the page treats as `wait`). Any submit (button, auto-submit, text submit) cancels the pending judge timer, and a `nudge` response that arrives after a submit was sent is discarded. The pre-commit budget is per `question_id` for the whole question (follow-up answers do not reset it). Blank/capped/stale requests consume no budget, make no LLM call, and write no `judge_events` row; every actual LLM call, `error`, and `leak_blocked` writes one row. Commit-time judging runs at every submission for the question while `follow_ups_asked < max_follow_ups` (a follow-up answer is judged again, with the prior follow-up turns as context), so commit-time calls per question ≤ `max_follow_ups`.
- **Judge decision rules** (in the prompt): *sufficient* = every `required` item is addressed at least implicitly; *incomplete* (⇒ `follow_up`) = at least one `required` item is not addressed; *off-topic* (⇒ `redirect`) = the answer does not address the question's subject at all; the target item is the unaddressed `required` item with the highest `weight` (then `recommended`), ties by `order_index`. Pre-commit `nudge` only when the draft ends mid-thought (trailing conjunction, unfinished clause, or under 12 words) — otherwise `wait`.
- **Nudge playback rules**: never speak a nudge while the interviewer is already speaking (`activeResponseRef` true ⇒ drop it); a text bubble stays until the candidate types again or 10 s elapse.
- **Transport**: bank personas in `judged` mode are a **mouth** exactly like `linear` (MODEL mode + reader prompt, `create_response=false`); `speech_text` rides the existing verbatim read (`speakQuestion` → `response.instructions`). The Foundry agent is no longer used for any bank voice turn. The proxy builds `AzureSemanticVadMultilingual(silence_duration_ms=800, remove_filler_words=true, end_of_utterance_detection=EouDetection(model="semantic_detection_v1_multilingual", threshold_level="medium", timeout_ms=1500), create_response=false, interrupt_response=true)` when `persona.eou_detection` is true (constants, not admin knobs), else today's `AzureSemanticVad`. Scope: every **mouth** session (bank `linear`, bank `judged`, external) — `create_response` stays `false` for all of them; the Playground (agent) session is untouched.

### Data model

```sql
-- interviewer_personas
ALTER TABLE interviewer_personas ADD COLUMN judge_silence_seconds INTEGER NOT NULL DEFAULT 2;      -- 1..30
ALTER TABLE interviewer_personas ADD COLUMN judge_max_calls_per_question INTEGER NOT NULL DEFAULT 2; -- 0..5, pre-commit calls only
UPDATE interviewer_personas SET bank_turn_mode = 'linear' WHERE bank_turn_mode = 'model';
-- BANK_TURN_MODES = ("linear", "judged"); default stays 'linear'. 'judged' appears only when an admin
-- selects it explicitly, so no persona changes behaviour on deploy. Downgrade maps judged → linear.

CREATE TABLE judge_events (
  id TEXT PRIMARY KEY, created_at DATETIME NOT NULL,
  interview_session_id TEXT NOT NULL REFERENCES interview_sessions(id),
  question_id TEXT NOT NULL,
  trigger TEXT NOT NULL,          -- voice_silence | text_idle | commit
  verdict TEXT NOT NULL,          -- wait | nudge | accept | follow_up | redirect | error | leak_blocked
  speech_text TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '', latency_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_judge_events_session ON judge_events(interview_session_id);
```

`interview_turns` unchanged (nudges are not turns; follow_up/redirect reuse `turn_kind='follow_up'`).

### API

- `POST /candidate/interview/{id}/judge` body `{ "draft_text": str, "trigger": "voice_silence" | "text_idle" }` → `{ "verdict": "wait" | "nudge", "speech_text": str }`. Owned (404 otherwise), 409 unless an `in_progress` bank session whose persona is in `judged` mode; enforces `judge_max_calls_per_question` (returns `wait` silently once exhausted); blank `draft_text` ⇒ `wait` without an LLM call.
- `POST /candidate/interview/{id}/answer` unchanged in shape; when the persona is `judged` and a follow-up is owed, the follow-up prompt comes from the judge (or the answer is accepted). `current_question.is_follow_up` semantics unchanged. ~~`linear` keeps today's template follow-up.~~ **Amended v0.39.2.0 (owner rule 2026-09-24):** a submit ALWAYS advances in every turn mode; the linear template-follow-up-at-submit path is retired (no route passes a `FollowUpProvider`), and `max_follow_ups` only budgets the judge's pre-submit follow-ups in `judged` sessions.
- Entry points (`start` / `GET`) add `voice_judge_silence_seconds: int | null` (0 when not `judged`; `null` on mutation responses; latched by the page like `voice_auto_submit_seconds`). `voice_linear_turns` is `true` for both `linear` and `judged`.
- Admin: `PersonaOut/Create/Update` carry `bank_turn_mode ∈ {linear, judged}` (422 otherwise, incl. legacy `model` on write), `judge_silence_seconds`, `judge_max_calls_per_question` (bounds above, explicit null 422).

### Judge prompt (backend, `judge.py`)

Inputs: bank language, question text, `expected_points`, checklist items (kind + text + weight + order_index), prior follow-up turns for this question, `follow_ups_asked/max`, the candidate text (pre-commit: buffered draft; commit: final answer), trigger. Output: strict JSON `{verdict, speech_text, reason}` via `json_mode=True`; model = persona `model` → master `model_or_deployment` → `settings.foundry_agent_model` (the same chain the scoring adapter uses). Language rule: `speech_text` in `QuestionBank.language`, never the candidate's language. Follow-ups cite the candidate's own words (keeps the F7 memory moment) and ask about **one** thing; the lead-in only *guides toward* the missing point, it never names or quotes it.

### Frontend

- `useInterviewVoice`: new options `judgeSilenceMs` / `onSilenceJudge`, a second timer beside the auto-submit one (same re-arm rules; cleared on `speech_started`, on commit, on disconnect). Both timers may coexist (judge 2 s, auto-submit e.g. 8 s).
- `InterviewPage`: on `onSilenceJudge` (voice) or textarea idle (text, same seconds), `POST /judge` with the current draft; on `nudge`, voice ⇒ `speakQuestion(speech_text)` (not latched as a question, so it may recur), text ⇒ transient interviewer bubble. Never resets the draft. Follow-up/redirect arrive as today via the answer response and are read verbatim (already shipped in 0.38.2.0).
- Configuration rail: radio labels become **Linear turns — read the question, then stay silent** / **Judged turns — nudge, follow up, or redirect when the answer needs it**; two inputs (**Silence before the judge listens (seconds)** 1–30, **Max judge checks per question, before submit** 0–5 — it limits calls, `wait` verdicts included) visible only for `judged`.
- Admin question editor (`AdminPage.tsx`): number input **Max follow-ups (0 = none)** 0–3 bound to `max_follow_ups`; the existing `follow_up_prompt` field is only used by the `linear` template path (label it so).

## Acceptance Criteria

1. Live (real Azure; fixture `answer_incomplete.wav`: 45 s silence, then a scripted answer to Q1 that covers every `required` item except one, then 90 s silence; bank `max_follow_ups = 1`, persona `judged`, `judge_silence_seconds = 2`, auto-submit OFF): after "I'm done" exactly **one** `follow_up` turn is recorded, its `speech_text` is spoken, and it relates to the omitted item without containing any ≥ 6-word run of the checklist/expected_points text.
2. Live (fixture `answer_complete.wav`: same shape, covers every `required` item, no pause over 1.5 s inside the answer; same setup): **zero** interviewer utterances between the Q1 read and the Q2 read; `judge_events` for that question contains only `wait`/`accept`.
3. Live: p50 of `judge_events.latency_ms` for `trigger='commit'` over ≥ 10 calls across ≥ 3 runs (errors excluded from latency, counted separately) < 2500 ms; per interview `count(trigger != 'commit') ≤ questions × judge_max_calls_per_question` and `count(trigger = 'commit') ≤ Σ max_follow_ups`.
4. Live (fixture `answer_pause.wav`: 45 s silence, half of the scripted answer ending mid-sentence, 6 s silence, the rest, 90 s silence): exactly one `nudge` fires during the 6 s pause (spoken "please go on" class text in the bank language) and the draft is not submitted by it.
5. `max_follow_ups = 0` ⇒ no commit-time judge call, no follow-up, interview advances as today (API test).
6. `judge_max_calls_per_question = 0` ⇒ `POST /judge` returns `wait` with no LLM call (API test with a fake adapter asserting zero invocations).
7. Judge adapter raising / timing out / returning `{"verdict":"nudge"}` at commit ⇒ answer accepted, no follow-up, `judge_events.verdict='error'` (API tests).
8. A `speech_text` that trips the leak guard as specified (6-word / 8-CJK run, or a whole short rubric string) is blocked (`verdict='leak_blocked'`, treated as accept/wait) — unit test with a crafted adapter response.
9. `bank_turn_mode='judged'` sessions connect in MODEL mode with `create_response=false` and, when `eou_detection` is true, `turn_detection.type='azure_semantic_vad_multilingual'` with the EOU block (proxy shape tests); `linear` sessions get the same VAD/EOU shape and remain `create_response=false`; the Playground session is unchanged; writing `model` is a 422; the migration converts existing `model` rows to `linear`.
10. Text channel: an idle draft triggers the same `/judge` call and renders a nudge bubble; submit is never blocked (page test).
11. Admin rail shows the two judge inputs only for `judged`; the question editor edits `max_follow_ups` round-trip (rail/page/API tests).
12. All existing suites green; CHANGELOG, `docs/IMPLEMENTATION-STATUS.md` (F6/F9 rows), `SPEC.md` F6 follow-up hook note updated; version bump to 0.39.0.0.

## Testing Plan

| Layer | What | Count |
|---|---|---|
| Unit (backend) | `judge.py` prompt builder (language, no-leak guard, allowed-verdict filter per moment, JSON parse, timeout → fallback), `linear_turns_for_persona`/`is_mouth_persona` for `judged`, VAD/EOU session shape | +12 |
| Integration (API, fake adapter) | `/judge` wait/nudge/cap/blank/404/409; `/answer` judged follow_up / redirect / accept / max 0 / adapter failure; `judge_events` rows; admin persona knobs + 422s; question `max_follow_ups` round-trip; migration up/down | +14 |
| Frontend (vitest) | hook second timer arm/re-arm/clear; page voice nudge → `speakQuestion`; page text idle → bubble, submit unblocked; rail radios/inputs; form mappers; admin question editor input | +10 |
| Live (opt-in, real Azure) | new `bank-judged-live.spec.ts` beside `bank-linear-restart-live.spec.ts`: three WAVs (incomplete / complete / pause-then-continue) covering AC 1–4 | +1 spec, 3 cases |

## Rollback Plan

Admin-level: set the persona back to `Linear turns` (no deploy). Code-level: revert the PR; the migration downgrade drops the two columns and `judge_events` and maps `judged` → `linear`.

## Effort Estimate

| Component | human | CC + gstack |
|---|---|---|
| Migration + models + admin persona schemas | 0.5 d | 20 min |
| `judge.py` (prompt, parse, guard, fallback) + unit tests | 1.5 d | 45 min |
| `state_machine` / `interview.py` integration (`/judge`, commit path, flags, `judge_events`) + API tests | 1.5 d | 60 min |
| Proxy VAD/EOU + mouth for `judged` + shape tests | 0.5 d | 20 min |
| Frontend hook timer + page (voice/text nudge) + rail + question editor + tests | 2 d | 75 min |
| Live spec (3 WAVs) + live validation + docs | 1 d | 60 min |
| **Total** | **~7 d** | **~4.5 h** |

## Files Reference

| File | Change |
|---|---|
| `backend/alembic/versions/<rev>_judged_turn_mode.py` | 2 persona columns, `model` → `linear` data fix, `judge_events` table |
| `backend/app/models/persona.py:130-140,249-268` | `BANK_TURN_MODES=("linear","judged")`, 2 knobs, `linear_turns_for` true for both |
| `backend/app/models/judge_event.py` | new model |
| `backend/app/interview/judge.py` | new: judge prompt/parse/guard/fallback, `run_judge(...)` |
| `backend/app/interview/state_machine.py:182-201` | commit-time judge when policy is `judged`; template path kept for `linear`; language from `QuestionBank.language` |
| `backend/app/api/interview.py` | `POST /{id}/judge`; `voice_judge_silence_seconds` on entry points; pass the turn policy into `answer_finalized` |
| `backend/app/api/admin_personas.py:38-70,120-175` | knob fields + validators + `PersonaOut` |
| `backend/app/services/voice_live_proxy.py:130-160,240` | `judged` ⇒ mouth; EOU/multilingual VAD when `eou_detection` |
| `frontend/src/hooks/useInterviewVoice.ts:94-108,636-652` | `judgeSilenceMs` / `onSilenceJudge` second timer |
| `frontend/src/pages/InterviewPage.tsx` | latch seconds, voice + text nudge trigger, bubble |
| `frontend/src/api/client.ts` | `judgeInterview()`, `voice_judge_silence_seconds` |
| `frontend/src/api/personas.ts`, `pages/agentEditorForm.ts`, `components/agent-editor/ConfigurationRail.tsx` | `judged` value, 2 inputs |
| `frontend/src/pages/AdminPage.tsx`, `api/admin.ts` | `max_follow_ups` input |
| `frontend/src/i18n.ts` | nudge/redirect UI strings, rail/editor labels (en + zh) |
| `frontend/e2e/bank-judged-live.spec.ts`, `e2e/live.config.ts` | live spec + registration |
| `backend/tests/test_judge.py`, `test_interview_api.py`, `test_admin_personas_api.py`, `test_voice_live_proxy.py`, `test_voice_live_plan.py` | tests above |
| `CHANGELOG.md`, `VERSION`, `docs/IMPLEMENTATION-STATUS.md`, `SPEC.md` | 0.39.0.0 |

## Out of Scope

- External-brain sessions (their workflow already owns nudges/follow-ups).
- Judge-driven **auto-advance** to the next question (v2 candidate; explicit submit / admin auto-submit stay the only advance paths).
- Any change to scoring, rubric authoring, or the report.
- Making the four EOU parameters admin knobs (constants in v1).
- Editor Playground behaviour (keeps the Foundry agent conversation).
- Updating the client's private bank bundle: `max_follow_ups` is set by the client's admin in the UI.

## Related

- v0.38.2.0 / v0.38.3.1 (`bank_turn_mode`, mouth mode) — PRs #111, #113
- 2026-08-10 decision: backend state machine is the single decision maker
- #104 (open): default-bank switch strands in-progress interviews — unrelated but touches the same `answer_finalized` path; sequence after it or rebase carefully

---

## Engineering review addendum (2026-09-24, `/plan-eng-review`)

**This addendum supersedes the sections above wherever they conflict.** Decisions D2–D16 were made by the owner during the review; implementers work from this addendum plus the unchanged parts of the spec.

### Amended design in one diagram

```
                       candidate speaks / types
                                 │
          voice: EOU + silence ≥ judge_silence_seconds      text: textarea idle ≥ judge_silence_seconds
                                 └──────────────┬──────────────┘
                                                ▼
                        POST /candidate/interview/{id}/judge
                        {question_id, follow_ups_asked, draft_text, trigger}
                                                │  session.turn_mode != judged → wait (no LLM)
                                                │  stale ids / blank draft / budget used → wait (no LLM)
                                                │  in-flight already → 409 (page treats as wait)
                                                ▼
                     judge.run(contract ⊕ persona prompt_fragment ⊕ rubric ⊕ <<<CANDIDATE>>>draft)
                                                │  timeout 3 s / bad JSON / bad verdict / leak → wait
                    ┌──────────────┬────────────┴───────────┬──────────────────┐
                  wait           nudge                  follow_up            redirect
                (silent)   speech_text spoken     writes interviewer turn   writes interviewer turn
                            or shown as bubble    turn_kind=follow_up,      turn_kind=follow_up,
                            nothing written       consumes max_follow_ups   consumes max_follow_ups
                                                  header → is_follow_up     header → is_follow_up
                                                  speech_text spoken        speech_text spoken
                                                │
                    every LLM call → judge_events row (trigger, verdict, latency, model)
                                                │
                 candidate clicks "I'm done" / auto-submit / text submit  ──►  POST /answer
                        NO LLM CALL. Records the single candidate turn (whole transcript, incl. the
                        answer to any follow-up) and ADVANCES to the next question — always.
                        (v0.39.2.0: linear sessions advance the same way — no template follow-up at commit)
```

### Decisions (owner, 2026-09-24)

| # | Decision | Effect on the spec |
|---|---|---|
| D2 | **Two PRs.** PR-1 = EOU/multilingual VAD for every mouth session (proxy honours persona `turn_detection` / `eou_detection`, constants as specified). PR-2 = the judge. | §Transport moves to PR-1; PR-1 ships first and is regression-checked with the existing live specs (bank linear + external) before PR-2 starts. |
| D3 | **`FollowUpProvider` interface; LLM never inside the state machine's transaction.** `answer_finalized(db, session, text, source, provider)`; `TemplateFollowUpProvider` (linear, today's behaviour) and `NoFollowUpAtCommit` (judged). A shared `state_machine.record_follow_up(db, session, question, text)` writes the interviewer `follow_up` turn for BOTH the template path and `/judge`. **Provider selection is an environment rule, not a test-file split (owner, 2026-09-24): GitHub CI never runs the real model; local test runs MUST.** A pytest fixture `judge_llm` injects the real Foundry adapter whenever Foundry credentials are present and `CI` is unset, and a deterministic fake only under `CI=true`. The SAME judge/API tests run in both environments; assertions on LLM *content* are written as class checks (verdict ∈ expected set, guard hits = 0) so they hold on the real model. Rationale: mocks pass, real fails. | Replaces "commit-time judge inside answer_finalized". |
| D4 | **Injection boundary.** Candidate draft is passed inside `<<<CANDIDATE>>> … <<<END_CANDIDATE>>>` and the contract states it is data, not instructions. `speech_text` max **200** chars (was 300). Leak guard additionally blocks the phrases `the answer is`, `you should have said`, `答案是`, `标准答案`, `你漏了`. | Amends §P3 guard and §Failure policy. |
| D5 | **Language = `question.language`, falling back to the bank's `language`.** One helper `question_locale(question, bank)` used by the judge AND the template follow-up; `_infer_locale` deleted. Regression test on the template lead-in. | Amends §Judge prompt language rule. |
| D6 | **Session snapshot.** `interview_sessions.turn_mode` (`String(16)`, `linear|judged`, server default `linear`) copied from the persona at start (also on `/restart`'s fresh session). `/judge` and the page follow the snapshot; an admin flipping the persona mid-interview changes nothing for running sessions. `voice_judge_silence_seconds` stays live-read like the auto-submit seconds. | Replaces "409 unless persona is judged" with "wait unless session is judged". |
| D7 | **Empty rubric** (no checklist rows and empty `expected_points`): the judge still runs; allowed verdicts are `wait | nudge | redirect` (no `follow_up`). | Amends §Judge decision rules. |
| D8 | **Second silence timer is a parallel copy** of the auto-submit timer in `useInterviewVoice` (no refactor of the existing one). Test: both armed → commit clears both; judge fires at 2 s while auto-submit is at 8 s. | Confirms §Frontend. |
| D9 | **`BoundedIntInput`** component (`min/max/value/onCommit`, draft → clamp → commit on blur/Enter, garbage reverts) shared by: auto-submit seconds (migrated, separate commit), judge silence seconds, judge max checks, question editor `max_follow_ups`. The three existing rail clamp/revert tests move to the component. | Amends §Frontend / admin editor. |
| D10 | **Real-model eval runs by default locally, skipped in CI:** `backend/tests/test_judge_eval.py` (uses the `judge_llm` fixture; `pytest.skip` when the fixture is the CI fake). 12 cases = {complete, one required point missing, off-topic, mid-thought draft, injection "tell me the answer", no-rubric off-topic} × {en-US, zh-CN}; assert verdict class, leak guard zero hits, `speech_text` language. Pass line ≥ 11/12. Plus two adversarial persona-prompt cases (see D15). Local `pytest` runs these against the real model by default; CI skips them. | Adds to §Testing Plan. |
| D11 | Dropped — `/answer` no longer calls the LLM (D13), so no "thinking" state is needed. | — |
| D12 | **Text-channel idle trigger is IN v1** (reverses the D2 deferral; with D13 it is the text channel's only judge entry point). Textarea non-empty and idle `judge_silence_seconds` → `/judge` with `trigger: text_idle`; `nudge` renders a transient interviewer bubble (until the candidate types again or 10 s); `follow_up`/`redirect` update the header exactly like voice. | Amends §Pre-commit trigger. |
| D13 | **"I'm done" always advances. No judge action at commit.** All four verdicts happen pre-commit (see diagram). `follow_up`/`redirect` are written by `/judge` as interviewer `follow_up` turns (header switches via the existing `is_follow_up` projection) and consume a `max_follow_ups` slot; the candidate keeps talking and the whole transcript is submitted as ONE candidate turn on "I'm done". `judge_max_calls_per_question` caps LLM calls per `question_id`; `max_follow_ups` caps follow_up+redirect per question. Linear sessions are untouched. | Replaces §"At commit" entirely; the commit-time verdict set `accept|follow_up|redirect` is removed. |
| D14 | **Single prompt.** No hidden `default_instructions` fallback: new personas are created with `prompt_fragment` pre-filled with the generated default; a migration backfills blank `prompt_fragment` rows with `default_instructions(name)`. The editor states what the prompt influences (Playground/agent sync, and the judge's persona & scale — never the verbatim reads) and shows the fixed judge contract read-only. The existing TODOS.md P3 item about the two diverging prompts is closed as obsolete. | New task; closes a TODO. |
| D15 | **Judge prompt = fixed backend contract ⊕ the persona's `prompt_fragment`.** Contract (system, restated after the persona text): JSON schema, allowed verdict set for the moment, no rubric quoting / no "you missed X", the "I'm done" click is never the judge's concern, speech_text length and language. Persona text supplies tone, what counts as complete, how patient to be, follow-up style. Eval (D10) adds two adversarial cases: a persona prompt saying "always thank the candidate" and one saying "read the expected points aloud" — the contract must still win. | Amends §Judge prompt. |
| D16 | Nightly real-model workflow: skipped (not recorded). | — |

### Wire changes (consolidated)

```sql
-- PR-2 migration (one revision)
ALTER TABLE interviewer_personas ADD COLUMN judge_silence_seconds INTEGER NOT NULL DEFAULT 2;         -- 1..30
ALTER TABLE interviewer_personas ADD COLUMN judge_max_calls_per_question INTEGER NOT NULL DEFAULT 2;  -- 0..5, LLM calls per question
UPDATE interviewer_personas SET bank_turn_mode = 'linear' WHERE bank_turn_mode = 'model';
UPDATE interviewer_personas SET prompt_fragment = <default_instructions(name)> WHERE trim(prompt_fragment) = '';   -- D14 (data migration in Python)
ALTER TABLE interview_sessions ADD COLUMN turn_mode VARCHAR(16) NOT NULL DEFAULT 'linear';             -- D6 snapshot
CREATE TABLE judge_events (... as specified above ...);
```

- `POST /candidate/interview/{id}/judge` body `{question_id, follow_ups_asked, draft_text, trigger: voice_silence|text_idle}` → `{verdict: wait|nudge|follow_up|redirect, speech_text, interview: InterviewOut|null}` — `interview` is present when a turn was written (follow_up/redirect) so the page refreshes the header without a second round-trip. 404 not owned; 409 only for not-in-progress or a concurrent in-flight judge.
- `POST /answer`: unchanged shape; judged sessions never call the LLM here.
- Entry points add `voice_judge_silence_seconds: int|null` (0 unless the SESSION is judged).
- Admin persona: `bank_turn_mode ∈ {linear, judged}`, `judge_silence_seconds`, `judge_max_calls_per_question`; `PersonaOut` also exposes `judge_contract` (read-only string) for the editor.

### Acceptance criteria — amendments

- AC1 → the follow-up is produced **during a pause** (fixture `answer_incomplete.wav`: 45 s silence, the incomplete answer, then a 6 s pause, then 90 s silence): exactly one `follow_up` turn written during the pause, spoken, header switched; "I'm done" then advances without any further utterance.
- AC2 unchanged (complete answer → zero utterances, `judge_events` only `wait`).
- AC3 → p50 latency over `judge_events` (all triggers) < 2500 ms; per interview `count(*) ≤ questions × judge_max_calls_per_question`; `count(verdict in (follow_up, redirect)) ≤ Σ max_follow_ups`.
- AC4 unchanged (mid-thought pause → exactly one `nudge`).
- AC5 → `max_follow_ups = 0` ⇒ verdict set at pre-commit is `wait|nudge` only; `/answer` never calls the LLM in any mode.
- AC7 → judge failure ⇒ `wait`, `judge_events.verdict='error'`; the interview is unaffected.
- AC9 → migration converts `model` → `linear`, adds `sessions.turn_mode`, backfills blank `prompt_fragment`; a session started under `judged` stays judged after the persona is flipped (API test).
- AC10 → text channel: idle draft → `/judge`; `nudge` bubble; `follow_up` switches header; submit always advances.
- AC13 (new) → local `pytest` (real model via the `judge_llm` fixture) passes with `test_judge_eval.py` ≥ 11/12 and the two adversarial persona-prompt cases; output attached to the PR. CI runs the same suite with the fake and skips the eval file.
- AC14 (new) → PR-1 alone: `bank-linear-restart-live.spec.ts` and `external-voice-live.spec.ts` pass on real Azure with the new VAD/EOU shape.

### NOT in scope (considered, deferred)

- Judge-driven auto-advance — owner rule: only the candidate's explicit submit (or the admin auto-submit) advances.
- Any judge action at commit time — removed by D13.
- Nightly / CI real-model eval workflow — D16 skipped.
- EOU parameters as admin knobs — constants.
- Editor Playground changes — keeps the agent conversation.
- Semantic (LLM) second-pass leak review — D4 chose structural isolation.
- `judge_events` retention/cleanup — volume is bounded by the two caps; revisit if it grows.
- Unifying the two prompts for Playground purposes beyond D14 — the persona prompt is the only prompt.

### What already exists (reused, not rebuilt)

| Sub-problem | Existing code | Reuse |
|---|---|---|
| Follow-up as an interviewer turn + header switch | `state_machine.py:182-201` (`turn_kind=follow_up`), `get_current_question` `is_follow_up` | `/judge` writes the same turn via the new shared `record_follow_up` |
| Verbatim speech | `speakQuestion` → `response.instructions` (mouth mode, v0.38.3.1) | nudge/follow_up/redirect text spoken through it |
| Silence detection | `useInterviewVoice.ts:636-652` auto-submit timer | copied as the judge timer (D8) |
| LLM access | `get_llm_adapter().complete(json_mode=True)` | judge uses it with `asyncio.wait_for(…, 3.0)` |
| Per-session latch of admin knobs | `voice_auto_submit_seconds` in `InterviewPage` | `voice_judge_silence_seconds` follows it |
| Per-engine admin knob pattern | PR #109 | judge knobs follow it |
| Bounded int input | `AutoSubmitControls` draft/clamp logic | extracted to `BoundedIntInput` (D9) |
| Mouth-mode plan | `is_mouth_persona()` | `judged` ⇒ mouth |
| Live spec recipe | `bank-linear-restart-live.spec.ts` (FAKE_AUDIO wav%noloop) | judged WAV fixtures follow it |

### Failure modes (new code paths)

| Path | Realistic failure | Test | Handling | Candidate sees |
|---|---|---|---|---|
| `/judge` LLM call | timeout / 5xx / bad JSON | ✅ API tests | `wait` + `error` event | nothing (silence) |
| `/judge` after question advanced (stale ids) | late timer fires post-submit | ✅ API test | `wait`, no write | nothing |
| `/judge` concurrent | two pauses within one LLM round-trip | ✅ API + page test | 409 → page `wait` | nothing |
| `follow_up` turn written, candidate immediately clicks done | follow-up never answered | ✅ API test (advance) | advance; follow-up stays on record | next question |
| nudge arrives while interviewer speaking | overlapping audio | ✅ page test | dropped (`activeResponseRef`) | nothing |
| leak guard false positive | legitimate follow-up shares 6 common words with rubric | ⚠️ eval case | `wait`, `leak_blocked` logged | no follow-up (safe side) |
| persona prompt fights the contract | "always thank the candidate" | ✅ eval adversarial case | contract restated last; eval gate | — |
| migration backfill of blank `prompt_fragment` | long text into Text column | ✅ migration test | — | — |
| text idle timer while voice also armed | double trigger | ✅ page test: one in-flight guard | second → 409 → wait | one nudge at most |
| `judge_events` insert fails | DB error | ✅ API test | logged, verdict still returned | unaffected |

No critical gap: every path has a test and a handler, and every silent outcome is the safe direction (no speech).

### Worktree parallelization

| Step | Modules | Depends on |
|---|---|---|
| S1 PR-1 proxy VAD/EOU + shape tests | `backend/app/services/voice_live_proxy.py`, `backend/tests/` | — |
| S2 migration + models + admin persona schemas + `judge_events` + `turn_mode` snapshot + prompt backfill | `backend/alembic/`, `backend/app/models/`, `backend/app/api/admin_personas.py` | — |
| S3 `judge.py` + `FollowUpProvider` + `record_follow_up` + `/judge` route + `/answer` provider wiring + API tests + `test_judge_live.py` | `backend/app/interview/`, `backend/app/api/interview.py`, `backend/tests/` | S2 |
| S4 `BoundedIntInput` + rail + question editor + form mappers + tests | `frontend/src/components/`, `frontend/src/pages/AdminPage.tsx`, `agentEditorForm.ts` | — |
| S5 hook judge timer + page voice/text triggers + nudge bubble + header refresh + tests | `frontend/src/hooks/`, `frontend/src/pages/InterviewPage.tsx`, `frontend/src/api/client.ts` | S3 (API shape) |
| S6 live WAV spec + docs + CHANGELOG/VERSION | `frontend/e2e/`, `docs/`, root | S3, S5 |

Lanes: **Lane A** S1 (PR-1, ship first). **Lane B** S2 → S3 (backend). **Lane C** S4 (frontend admin, independent). **Lane D** S5 after S3's API shape is fixed. Then S6. Conflict flag: S4 and S5 both touch `frontend/src/` but different directories (`components/agent-editor`, `pages/AdminPage.tsx` vs `hooks/`, `pages/InterviewPage.tsx`); `i18n.ts` is shared — coordinate or land S4 first.

### Implementation Tasks

- [ ] **T1 (P1, human ~0.5d / CC ~20min)** — proxy — PR-1: build `AzureSemanticVadMultilingual` + `EouDetection` constants when `persona.eou_detection`, for every mouth session; shape tests; run both live specs. Surfaced by: Step 0 / D2. Files: `voice_live_proxy.py`, `tests/test_voice_live_proxy.py`. Verify: live specs green.
- [ ] **T2 (P1, human ~0.5d / CC ~20min)** — models/migration — knobs, `model→linear`, `sessions.turn_mode`, `judge_events`, blank `prompt_fragment` backfill; admin schemas incl. `judge_contract`. Surfaced by: D6, D14. Verify: `alembic upgrade/downgrade` tests, admin API tests.
- [ ] **T3 (P1, human ~1.5d / CC ~45min)** — `judge.py` — contract ⊕ persona prompt, `<<<CANDIDATE>>>` delimiter, verdict filter per rubric presence, JSON parse, 200-char cap, leak guard (n-gram + phrases), `asyncio.wait_for(3.0)`, `judge_events` write. Surfaced by: D4, D5, D7, D15. Verify: unit tests with crafted adapter outputs.
- [ ] **T4 (P1, human ~1d / CC ~40min)** — state machine/API — `FollowUpProvider`, `record_follow_up`, `question_locale`, delete `_infer_locale`; `/judge` route (stale/blank/budget/concurrency/snapshot rules, returns InterviewOut on write); `/answer` provider wiring; `voice_judge_silence_seconds`. Surfaced by: D3, D13, D6. Verify: API tests incl. template-path regression.
- [ ] **T5 (P1, human ~1d / CC ~40min)** — real-model eval — `judge_llm` fixture (real locally / fake under `CI=true`), `backend/tests/test_judge_eval.py` 12 cases + 2 adversarial persona cases, ≥ 11/12, skipped in CI; PR template line "attach local pytest output (real model)". Surfaced by: D10, D15. Verify: real Azure run.
- [ ] **T6 (P1, human ~0.5d / CC ~20min)** — frontend admin — `BoundedIntInput` (+ migrate auto-submit input, separate commit), rail radios `linear|judged`, two knobs, prompt-scope hint + read-only contract, question editor `max_follow_ups`. Surfaced by: D9, D14. Verify: rail/editor/form tests.
- [ ] **T7 (P1, human ~1.5d / CC ~60min)** — frontend interview — hook judge timer (copy), text idle timer, `/judge` call with ids, one-in-flight guard, cancel on submit, discard late nudge, drop nudge while speaking, bubble, header refresh from returned `interview`, latch seconds. Surfaced by: D8, D12, D13. Verify: page + hook tests incl. both-timers case.
- [ ] **T8 (P1, human ~1d / CC ~60min)** — live WAV spec — `bank-judged-live.spec.ts` with `answer_incomplete/complete/pause.wav` per amended AC1/2/4. Surfaced by: Test review. Verify: real Azure run attached to PR.
- [ ] **T9 (P2, human ~1h / CC ~10min)** — docs — CHANGELOG (PR-1 0.38.4.0, PR-2 0.39.0.0), IMPLEMENTATION-STATUS F6/F9, SPEC.md F6 hook note, TODOS.md close the prompt-divergence item. Surfaced by: D14.
- [ ] **T10 (P2, human ~30min / CC ~10min)** — regression — assert `bank-linear-restart-live` + `external-voice-live` green after PR-1 and PR-2; template follow-up lead-in test updated for `question_locale`. Surfaced by: IRON RULE.

_No new tasks from Performance review (D11 dropped)._

### Implementation notes (v0.39.0.0, 2026-09-24)

- Shipped as PR-1 v0.38.4.0 (EOU/multilingual VAD) and PR-2 v0.39.0.0 (judge). Tasks T1–T10 done.
- **AC3 revised by measurement:** gpt-5-mini needs `reasoning.effort=low` + a warm client to reach
  1.6–7.5 s per judge call (median ≈3.5 s); the 2.5 s p50 target is not met and the judge timeout is
  10 s. `minimal` effort was faster but misjudged off-topic answers; gpt-4.1-mini was no faster and
  misjudged two cases. Owner decision pending: accept ≈3.5 s, or revisit the model.
- **Eval acceptance:** Azure's jailbreak prompt filter rejects injection attempts outright (400
  `content_filter`) and the leak guard silences a Chinese follow-up that quoted a rubric item verbatim;
  both are counted as correct silence. 12/12 on the real model.
- `judge_events` also records `error` / `leak_blocked`; blank / stale / capped requests write nothing.
- **D17 (owner, 2026-09-24, after shipping):** judge reasoning OFF (`minimal`), output capped and
  shortened; the LLM round-trip is a fixed ≈2–3 s per call regardless of prompt size, so the page now
  PREFETCHES at end of utterance (`/judge` `dry_run`) and applies at the end of the silence window
  (`/judge/apply`) — perceived delay ≈1 s. Budget counts delivered verdicts only (`judge_events.applied`);
  raw LLM calls bounded at 3× the budget. Reasoning-off needed the contract rewritten as an ordered
  procedure with a per-required-item quote check (the model otherwise read a pause as "still speaking"
  and stretched sentences to cover missing items); follow-ups must be open questions that never name the
  rubric's subject. Output cap 320 tokens, timeout 10 s. Eval 12/12; all three live WAV cases pass.
  Shipped as v0.39.1.0.
- **v0.39.2.0 amendment:** linear sessions no longer receive the authored template follow-up at
  submit. A question with `max_follow_ups > 0` under a linear persona used to hand the candidate a
  "You mentioned … Can you walk me through …" probe instead of question 2, contradicting the
  editor's "no follow-ups" promise. `answer_finalized` now advances unconditionally unless a
  provider is explicitly passed (none is); `max_follow_ups` is judged-only.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 (this spec) | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | unavailable | outside voice (Claude subagent) exceeded its 5-min budget and was stopped; codex refuses this repo (gstack gate) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN, SCOPE_REDUCED) | 9 issues, 0 critical gaps; 19 test gaps folded into the plan; 4 mandatory regressions |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 (this spec) | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 (this spec) | — | — |

- **VERDICT:** ENG CLEARED — ready to implement (PR-1 first, then PR-2 per the addendum). Outside voice did not run; no cross-model signal available.

NO UNRESOLVED DECISIONS
