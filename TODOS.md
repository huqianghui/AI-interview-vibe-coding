# TODOS

## Interview (voice)

### Interview mutation routes race on a stale session snapshot (judge/apply vs submit)

**What:** `backend/app/api/interview.py` — `answer`, `judge`, `judge/apply`, `restart` and `end`
each load the `InterviewSession` once via `_owned_interview` and later write against that snapshot;
no row lock or optimistic-concurrency token. If `judge/apply` and a `/answer` submit interleave, the
apply passes its staleness checks against the cached `current_question_index` and writes an
orphaned interviewer `follow_up` turn for a question the candidate already left (out-of-order
`turn_index`), silently consuming a `max_follow_ups` slot and a judge-budget slot. Same class of
TOCTOU for concurrent `/answer` + `/restart`.

**Why it is not urgent:** scoring is unaffected (`group_answers` reads candidate turns by
question_id only) and the page delivers `res.interview.current_question`, so nothing is spoken
twice; the damage is a wasted slot and a confusing turn ordering, scoped to one candidate's own
session. Surfaced by the v0.39.2.0 adversarial review; pre-existing, not introduced there.

**Fix shape:** re-read the session (or `SELECT … FOR UPDATE` / a version column) inside the
mutating transaction and re-run the staleness check before writing.

**Effort:** S
**Priority:** P2

### Avatar self-heal retries are not aware of Azure's avatar rate limit

**What:** `useAvatarStream.attemptRecovery` can send three `session.avatar.connect` offers with
backoffs of 500/1500/3000 ms — about 5 seconds total. Azure refuses a third avatar request inside
roughly 20 seconds (`"Avatar request was rate-limited. Retry after 43.0s."`, measured 2026-09-30), so a
link that produces two or three genuine ICE failures in quick succession can have its own recovery
attempts refused. Once the budget is spent the code stops and shows the orb, and because the getStats
sampler is torn down with the connection, the weak-network policy can never act either — the avatar is
stranded picture-less for the rest of the session with no automatic path back (voice keeps working).
The deliberate mode-switch path IS gated on `VIDEO_SWITCH_MIN_INTERVAL_MS`; the self-heal path is not.

**Why it is not urgent:** the self-heal path predates v0.40.0.0 and in practice a media drop takes one
attempt. The orb is the designed fallback, so the failure mode is degraded-but-working, not broken.

**Fix shape:** either space the recovery backoffs past the rate-limit window, or — better — when
recovery is exhausted while in video mode, ask for a downgrade to audio-only so the session is rebuilt
into a mode the link can actually carry, instead of staying stranded. Needs a decision on how self-heal
and mode-switch should share one rate-limit budget. Surfaced by the v0.40.0.0 adversarial review.

**Effort:** M
**Priority:** P2

### A media-mode rebuild resets the WS reconnect budget, which can defer a terminal error

**What:** `restartForMediaMode` calls `connect(..., isReconnect=false)`, which zeroes
`reconnectAttemptRef` and clears `fatalErrorRef`. That is deliberate — a policy switch must not spend
the three retries a real drop needs. The inverse was raised by the v0.40.0.0 adversarial review: on a
sustained bad link, repeated health-driven switches keep handing the WS a fresh budget, so a connection
that is ALSO failing for unrelated reasons may never reach the terminal "voice unavailable" state.

**Why it is not urgent:** each `connect()` still has to complete or hit its 30 s timeout, so this defers
the terminal state rather than looping forever; and the hysteresis caps automatic switches at two
restores per session. It is a UX-honesty question, not a hang.

**Fix shape:** track consecutive failed connects independently of the per-drop retry counter, so the
terminal error survives a mode switch.

**Effort:** S
**Priority:** P3

### `useInterviewVoice` has grown to ~1300 lines in one function

**What:** the hook now carries WS lifecycle, mic-rate validation, first-read gating, turn state and
the media-mode session rebuild in a single function body with 19 inlined callbacks. The sibling change
in v0.40.0.0 pulled the media *policy* out into `avatarHealth.ts`, but the voice hook itself kept
accreting. Raised by the maintainability review during v0.40.0.0 and deliberately left out of that PR:
splitting a 1300-line hook is its own change with its own regression risk, not a rider on a feature.

**Fix shape:** extract cohesive sub-hooks (the mic-rate guard; `restartForMediaMode` plus its
WS-teardown ordering) the way `avatarHealth.ts` was extracted, one at a time, each with its tests.

**Effort:** M
**Priority:** P3

### `CONCEAL_GOOD` (the restore threshold) is still unmeasured on a real link

**What:** 5.4.1's run only proved when the picture is given UP. `CONCEAL_GOOD = 0.03` governs when it
comes BACK and has never been exercised against real Azure, because that run never let the link recover.

**Why it is not urgent:** it only affects how quickly the picture returns, never whether the voice
survives. Worst case it is too strict (picture stays off longer than needed) or too loose (one extra
~5 s rebuild, capped at two attempts per session by `MAX_RESTORE_ATTEMPTS`).

**How to measure:** one command, which shapes the link, waits for the app to drop the picture by
itself, removes the shaping at that exact point and measures the return:
`sudo frontend/e2e/scripts/verify-restore.sh` (spec: `frontend/e2e/avatar-restore-live.spec.ts`).

**Read `earned` in its output before believing a pass.** `readHealth` reports concealment 0 when NO
audio samples arrive, because DTX silence and a dead stream are indistinguishable at that layer — so a
silent interviewer also reads as healthy, and the restore can ride on a 0-of-0 reading without ever
testing `CONCEAL_GOOD`. That behaviour is defensible in production (no voice arriving means no voice to
protect, and the threshold-free trigger drops the picture again within ~4 s if the link is still bad),
but it means the threshold needs a run with audio actually flowing: pass `FAKE_AUDIO` so a turn stays
alive. The spec prints `earned: false` when the run did not exercise the threshold.

**Effort:** S
**Priority:** P3

## Completed
### Weak-network automatic downgrade verified end-to-end on a throttled link — v0.40.0.0

The policy's live trigger was the one seam unit tests could not cover. Verified 2026-09-30 under
OS-level shaping (3% loss / 800-400 kbps) via `frontend/e2e/avatar-auto-downgrade-live.spec.ts`: with no
interaction the session degraded in 41 s, logging `conceal=35.0% decoding=false rtt=933ms`, and the
rebuilt session carried zero video while audio kept flowing. Both triggers fired together, so the
threshold-free one stands on its own; 35% concealment independently reproduces the 31% the original
probe measured by another route.

**Priority:** P1
**Completed:** v0.40.0.0 (2026-09-30) — see `docs/avatar-weaknet-probe.md` §5.4.1.

### Automatic voice reconnect bypasses `cleanup()` — speak/turn refs survive a WS drop — fixed v0.39.3.1

`useInterviewVoice.ts`: the unexpected-`onclose` reconnect branch resets only `avatarStartedRef` /
`sessionLiveRef` (the avatar-handshake fix) but never `activeResponseRef`, `spokenTextRef`,
`awaitingReadResponseRef`, `readResponseIdRef` or `speakWatchRef`; `cleanup()` (which also stashes
the unconfirmed read into `resumeSpeakTextRef`) runs only on connect-timeout, mic failure and
explicit `disconnect()`. Consequences: (a) the "re-speak the unconfirmed question after reconnect"
path is dead for the most common trigger (a plain network drop); (b) an `activeResponseRef` left
`true` at drop time survives into the new session and makes the next `speakQuestion` cancel-and-queue
behind a phantom response (v0.39.2.3 fixed the same phantom on the watchdog give-up path, not here);
(c) a stale `speakWatchRef` timer can fire against a session that has not reached `session.updated`.
Fix shape: factor a shared "reset turn state" helper called from both `cleanup()` and the reconnect
branch, keeping the mic/avatar-continuity behaviour that branch intentionally preserves; cover with a
vitest reconnect case. Surfaced by the v0.39.2.3 adversarial review (INVESTIGATE).

**Priority:** P2
**Completed:** v0.39.3.1 (2026-09-28) — `resetTurnState()` shared by `cleanup()` and the reconnect branch (`keepDraft` keeps the answer so far); regression test in `useInterviewVoice.test.tsx`.

### Fallback interviewer prompt divergence — closed as obsolete, v0.39.0.0

**Outcome:** the premise ("the prompt is the only control over bank-mode voice follow-ups") no longer
holds. Since v0.38.3.1 bank voice sessions are a MOUTH (model mode + verbatim reads — the Foundry agent's
instructions never produce a spoken turn), and since v0.39.0.0 follow-ups are decided by the backend
judge (`judged` mode) or the authored template (`linear` mode), never by the agent prompt. There is
also only ONE prompt now (issue #114 review D14): a blank `prompt_fragment` is pre-filled with the
generated default on create and back-filled by migration `f2a3b4c5d6e7`, so the two texts cannot
diverge for a persona. The editor states what the prompt influences (agent sync, Playground, judge
tone) and shows the judge contract read-only.

<details><summary>Original item</summary>

### Fallback interviewer prompt still allows one follow-up (diverges from the seeded persona)

**What:** `backend/app/models/persona.py` `default_instructions()` — the prompt used when a persona
leaves `prompt_fragment` blank — still says "after they answer, you may ask AT MOST ONE short
follow-up". The seeded persona's guidance was changed to strictly linear / no follow-ups in
v0.37.4.7 (`27fe9d6`, `persona_seed.py`). The two now point in opposite directions, so whether the
digital human may follow up depends on which prompt a persona happens to fall back to.

**Why it matters now:** since `linear_turns` is settled as engine-decided (see Completed), the PROMPT
is the only remaining control over bank-mode follow-ups — this divergence is the actual switch.

**Why it was not fixed alongside the `linear_turns` closure:** tightening the fallback reverses the
v0.37.4.7 owner instruction for one path; loosening the seed reverses strict linearity for the other.
Picking a direction is an owner call, not a side effect of a rename. No data risk either way:
`max_follow_ups` defaults to 0 (`backend/app/models/question.py`) and the state machine drives
progression (`state_machine.py`), so a stray spoken follow-up never changes flow or records a
question — only what the candidate hears.

**Effort:** XS (one prompt string, once the direction is chosen)
**Priority:** P3
**Depends on:** owner decision

</details>

### Bank-mode "silent advance" / `linear_turns` — resolved by design, v0.38.1.1

**Outcome: closed without a new setting — this was never missing code.** The original proposal was a
per-persona `linear_turns` bool (default on) so bank mode could also run the silent turn contract.
Exploration showed the interesting middle ground it was reaching for does not exist:

1. **`create_response` is a single boolean.** The turn Azure auto-creates when the candidate stops
   speaking is simultaneously the source of a "Thank you." acknowledgment and of an unwanted
   follow-up. There is no protocol-level way to keep one and forbid the other, so the flag could only
   ever be "all reaction" vs. "total silence" — not "acknowledge but don't ask".
2. **Agent mode rejects overriding `instructions` in `response.create`** (live-verified; see
   `frontend/src/hooks/useInterviewVoice.ts`, emitSpeak branch), so a scoped one-off "acknowledge
   only, ask nothing" turn cannot be constructed for a bank persona either.
3. **Owner decision (2026-09-23):** bank mode stays under **model + prompt** control
   (`prompt_fragment`); external mode is linear because it supplies no brain at all. A structural
   kill-switch for bank would trade away every bit of reaction between questions.

So the engine decides it, and the shipped behavior already matched the decision. v0.38.1.1 is
clarification only, zero behavior change: renamed the frontend option `externalMode` → `linearTurns`
(the two bare-`response.create` guards in `commitAnswer`), and recorded the three reasons above in
`voice_live_proxy.py` beside `create_response=not is_external` and in the hook's option doc — so the
next reader does not re-file this as a quick win. Regression guards: `test_voice_live_proxy.py`
(bank ⇒ `create_response=True`, external ⇒ `False`) and the `linear turns: commitAnswer never fires
a bare response.create` hook test.

**Not to be confused with** the OTHER `response.create` in the hook — the one paired with an assistant
item in `emitSpeak`. That is the verbatim read trigger, keyed off `readDirectiveRef`, and it must keep
firing under linear turns or the question is never spoken at all.

The abruptness trade-off noted with the owner on 2026-09-22 (zero reaction between questions feels
cold, mitigable with a verbatim "Thank you. Next question:" lead-in) no longer applies to bank mode,
which keeps its reaction. See `CHANGELOG.md` 0.38.1.1.

### Admin-configurable voice silence auto-submit, per engine — v0.38.1.0

Shipped as two independent per-engine setting pairs (`{bank,external}_auto_submit_enabled` /
`{bank,external}_auto_submit_silence_seconds`, 1–60s) surfaced in the `/admin/agent` Configuration
rail's "Answer submission (voice)" block, replacing the hardcoded `EXTERNAL_SILENCE_AUTOCOMMIT_MS`
constant. Bank defaults off (a fixed 3s window fired while candidates were still thinking); external
defaults on at 3s. This was the `silence_autocommit_seconds` half of the bank-mode silent-advance
item; the `linear_turns` half is resolved by design in v0.38.1.1 (next entry). See `CHANGELOG.md`
0.38.1.0 and `SPEC.md`.
