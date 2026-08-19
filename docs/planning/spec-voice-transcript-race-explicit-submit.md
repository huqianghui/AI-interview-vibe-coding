# 面试流程修复 — 语音答案等转录落地 + 空答拦截 + 显式"提交并评测"

> Promoted from the approved gstack plan (`fluffy-puzzling-hammock`). Shipped **v0.30.0.0**.
> Branch `fix/voice-transcript-race-explicit-submit`. This is the "why + what" behind the F9 flow
> change recorded in [`../IMPLEMENTATION-STATUS.md`](../IMPLEMENTATION-STATUS.md).

## Context (why)

A live on-device interview produced a report with two defects, both traced to **one frontend race**:

1. **A voice answer was submitted before its transcript landed** → the report showed "未作答"
   (unanswered).
2. **The evaluation order did not match the question bank** (Q1 blank, Q2 showed Q1's answer, Q3
   showed Q2's — the whole thing shifted by one).

**Root cause (confirmed by two Explore agents + direct code read):** STT transcription is
**async**. The user's transcript arrives only via Azure Voice Live's
`conversation.item.input_audio_transcription.completed` event, on a server round-trip. But
`InterviewPage.tsx`'s `onVoiceDone` read the `segments` state **synchronously** right after
`voice.commitAnswer()` and POSTed immediately — before this turn's transcript had arrived — so each
question submitted the **previous** turn's transcript (empty for Q1), then auto-advanced. That single
race produced both the "未作答" blank and the off-by-one misalignment.

**The backend was never wrong**: every answer is paired to its question by explicit `question_id`
at every hop (the turn carries `question_id`; grouping/scoring join on it), so a positional shift is
structurally impossible. Fixing the frontend race makes the ordering defect disappear on its own.

Two additional flow requirements from the owner:

3. **Every question must be answered** — empty content cannot pass (front- and backend gates).
4. **Finishing the last question ≠ scoring.** The candidate must explicitly click **提交并评测** to
   start scoring, so they can review the whole set holistically first — instead of the last answer
   auto-triggering `getReport`.

Goal: minimal, robust fix. No backend refactor (scoring was already deferred to `POST /{id}/report`).

## Implementation

### 1. `useInterviewVoice.ts` — a "wait for transcript" primitive

`commitAnswer(): Promise<string>` now resolves **this turn's** finalized user transcript (multi-part
joined; `""` on empty/timeout). A `pendingCommitRef` is armed on commit (empty parts + an 8s
`COMMIT_TRANSCRIPT_TIMEOUT_MS` timer), then `response.create` is sent. The
`…transcription.completed` handler keeps its existing `emit(...)` (the Transcript panel still shows
the bubble) **and** resolves the pending commit on the first completed event. `cleanup()` settles any
pending commit (resolves accumulated text) across disconnect / unmount / reconnect, so an awaited
`commitAnswer()` never hangs when the WS drops. Timeout resolves the accumulated `parts.join(" ").
trim()` (usually `""`) — **fail-closed, never hangs the UI**.

### 2. `InterviewPage.tsx` — await the transcript, reject empty, then submit

`onVoiceDone` awaits `voice.commitAnswer()`, rejects a blank (`!spoken.trim()` → shows
`voice.emptyAnswer`, does not advance, retryable), else `submitAnswer(…, spoken, "voice")`. Because
the transcript `emit` runs before the promise resolves, the panel already shows the bubble when we
submit ("displayed on the page before submitting"). `busy` disables "我说完了" during the guard
(no double-submit). This exits the synchronous `collectVoiceAnswer`/`submittedSegmentIds` path (the
Promise is now the authoritative per-turn text); `interviewVoiceAnswer.ts` is retained as a pure
helper + unit test, off the live path.

### 3. Explicit "Submit & evaluate" (requirement 4)

No backend change (`answer_finalized` already sets `completed` without scoring; scoring is only
`POST /{id}/report`). Frontend: new `review` phase in `Phase`. `advanceOrComplete` on `completed`
no longer auto-scores — it enters `review` and calls `voice.disconnect()` (releases the mic).
`GET /{id}/review` returns every question + finalized answer in bank order; `ReviewView` renders one
card per answer with a primary **提交并评测** button. `onSubmitAndEvaluate` → `scoring` → `getReport`
→ `scored`.

### 4. Empty-answer rejection — three layers (requirement 3)

- **Frontend voice**: the `!spoken.trim()` branch above.
- **Frontend text**: submit button `disabled={busy || !answer.trim()}` (already present).
- **Backend Pydantic**: `AnswerIn` `@field_validator("text")` → blank raises → FastAPI 422.
- **Backend defensive**: `answer_finalized` raises `InterviewStateError` on empty `content` → 409.
  This also fixes a real bug: a `verbal_cue` message that is only the cue (e.g. "我答完了") strips to
  empty and used to pass silently.

### 5. i18n (`i18n.ts`, zh-CN + en-US)

`voice.emptyAnswer` + a `review` block (`title` / `body` / `action` = 提交并评测 / Submit & evaluate).

## Tests

- `useInterviewVoice.test.tsx`: completed event resolves the transcript; 8s timeout resolves `""`;
  disconnect settles a pending commit; no cross-turn leak (turn 2 resolves turn 2's text).
- `InterviewPage.test.tsx`: full flow lands on `review` with `getReport` **not** called, then the
  explicit click scores; empty voice answer rejected (no submit, notice shown, stays put); await-then-
  submit race regression (submits exactly the resolved text).
- `test_interview_api.py`: empty text → 422; verbal-cue-strips-to-empty → 409; `/review` requires
  completion (409); `/review` returns answers in bank order (candidate-safe, no rubric leak);
  `/review` ownership 404.
- `test_interview_state_machine.py`: `answer_finalized` rejects empty + verbal-cue-empty;
  `review_answers` pairs by `question_id` in bank order.

## Risks (accepted)

- Transcript event never arrives → 8s timeout resolves `""` → treated as empty answer, fail-closed.
- Disconnect mid-await → `cleanup()` settles pending, never hangs (the key defense).
- Multi-segment in one turn → resolve-on-first (minimal, targets the reported bug); if multi-segment
  loss is seen in the field, add a quiet-period debounce as a follow-up (not pre-designed).
- `response.done` is an assistant-turn signal, **not** a user-transcript signal — left untouched.

## Verification

1. `cd frontend && npx tsc --noEmit && npx eslint src --max-warnings=0`
2. `cd frontend && npx vitest run`
3. `cd backend && ruff format --check . && ruff check . && pytest`
4. Manual (dev server / on-device voice): answer Q1 by voice → bubble appears before submit, report
   Q1 has content and order aligns; say nothing then "我说完了" → notice, no advance; finish the last
   question → **提交并评测** appears, scoring starts only on click.
