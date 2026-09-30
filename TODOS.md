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

### The voice-damage trigger needs a metric that can separate a bad link from a good one

**What:** `USE_VOICE_DAMAGE_TRIGGER` is false. Audio concealment no longer drops the picture, because
measurement (2026-09-30, `docs/avatar-weaknet-probe.md` §5.4.4) showed it cannot tell the two conditions
apart: 16.9% audible concealment at the moment it decided to downgrade under 3% packet loss, against
8–19.3% (median ~13%) on the SAME link minutes later with the shaping removed. Its damaged range sits
inside its healthy range, so at 0.15 it fires on healthy sessions — the downgrade observed in that run
was a false positive.

**What still works, and why this is not urgent:** the primary trigger needs no threshold at all (video
bytes arriving while `framesDecoded` does not grow) and it is the path every v0.40.0.0 live verification
actually exercised. The feature's proven core is intact.

**The open question:** is there a receiver-side signal that separates "this link is damaging the
interviewer's voice" from "this is what a healthy Opus stream looks like between utterances"? Candidates
worth measuring, none yet tried: `concealmentEvents` per second rather than a sample ratio (the number of
distinct gaps may separate better than their total size); `jitterBufferDelay / jitterBufferEmittedCount`;
`packetsLost` on the audio stream alone; or the audible ratio measured ONLY across windows where speech
is actually arriving (gated on `audioLevel` or `totalAudioEnergy`) rather than every window.

**Scope limit on the measurement that retired it:** all five runs used `amira`, the 512x512 photo
avatar, because `verify-restore.sh` did not control the persona and that happened to be the machine's
default. A 512-square stream decodes fine at 3% loss, so the video load was an order of magnitude below
the 1080p case. The "cannot separate" finding is a valid within-run comparison and holds for that
condition, but it has NOT been tested on `lisa` (1080p), where the video load is far heavier and the two
distributions may well separate. So the first thing to do is repeat the measurement on lisa — the script
now defaults to it.

**How to judge a candidate metric:** it must be recorded on a shaped link AND on the same link unshaped,
and the two distributions must not overlap. That is the bar 0.15 failed on amira. `verify-restore.sh` already
captures per-window stats to `frontend/e2e/output/restore-latest.json`; extend the sampled fields rather
than writing a new harness.

**Effort:** M — it is a measurement question, not a tuning one.
**Priority:** P2


## Completed
### Avatar self-heal now shares one rate-limit ledger, and falls back instead of stranding — v0.40.1.0

Two faults, one root cause: nothing tracked how many `session.avatar.connect` offers we had sent, and
Azure refuses a third inside roughly 20 s. The self-heal backoffs (500/1500/3000 ms) put all three
attempts inside ~5 s, so attempt 3 was spent on a request Azure would never honour; and when the budget
ran out the code showed the orb and stopped, which stranded the session — the stats sampler dies with
the connection, so the weak-network policy could not act either and the candidate finished picture-less
with no automatic way back.

Now one ledger on the hook records every offer and both paths consult it: the self-heal backoff table is
a floor that the allowance can push later, and the restore path takes `max(cooldown, allowance)` so
lowering the 60 s cooldown later cannot quietly reintroduce a refused request. An exhausted **video**
self-heal asks for audio-only rather than giving up, rebuilding into the mode the link just proved it
can carry; an exhausted **audio-only** self-heal still shows the orb, so the modes cannot bounce. Also
fixed while in here: when the WS send threw, the SDP-answer promise was left armed and rejected 15 s
later with nobody listening, surfacing as an unhandled rejection mid-recovery.

**Priority:** P2
**Completed:** v0.40.1.0 — `frontend/src/hooks/useAvatarStream.rateLimit.test.tsx` (3 tests, each
verified to fail with the fix reverted).

### A media-mode rebuild no longer hides a terminal voice failure — v0.40.1.0

`restartForMediaMode` resets the per-drop reconnect budget on purpose: a policy switch is not a failure
and must not spend the retries a real drop needs. The inverse was the problem — on a link bad enough to
force switch after switch, every switch handed the socket a fresh budget, so a connection also failing
for unrelated reasons might never reach the terminal state the candidate needs to see.

A second counter now tracks connect attempts since the last session that actually reached
`session.updated`, and it is the one thing a switch does not reset. Sized at 6, above a full per-drop
exhaustion (1 + 3 retries) plus a couple of legitimate switches, so no honest flow trips it.

**Priority:** P3
**Completed:** v0.40.1.0 — covered in `useInterviewVoice.restartForMediaMode.test.tsx`, including an
assertion that it does NOT fire early enough to break an honest flow.

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
