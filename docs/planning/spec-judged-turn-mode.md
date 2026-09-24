# Judged turn mode: an LLM judge decides nudges, follow-ups and redirects for question-bank interviews (replaces the Foundry-agent turn)

> Filed as GitHub issue [#114](https://github.com/huqianghui/AI-interview-vibe-coding/issues/114) on 2026-09-24 via `/spec` (codex quality gate 7/10, redaction scan clean, public repo). Promoted from the local gstack spec archive per the project rule that planning documents live in `docs/planning/`. Status: **spec only — not yet implemented**; next step is `/plan-eng-review` before building.

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
- `POST /candidate/interview/{id}/answer` unchanged in shape; when the persona is `judged` and a follow-up is owed, the follow-up prompt comes from the judge (or the answer is accepted). `current_question.is_follow_up` semantics unchanged. `linear` keeps today's template follow-up.
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
