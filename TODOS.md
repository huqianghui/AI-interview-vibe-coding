# TODOS

## Interview (voice)

### `useInterviewVoice` is 1481 lines — the planned split is DONE; what remains is a judgement call

**All five planned clusters are extracted:** answer draft (v0.40.4.0), first-read gate (v0.40.5.0),
read-delivery watch (v0.40.6.0), speak queue (v0.40.7.0), connection policy (v0.40.8.0). Every step
landed with the existing tests passing unmodified and each module mutation-checked.

**The line count barely moved on the last step and that is expected**, not a disappointment: it replaced
five refs and their scattered arithmetic with named calls of similar length. The win is that the three
limits whose DIFFERENCES carry the behaviour now sit together with tests asserting they stay distinct —
conflating any two reintroduces a shipped bug.

**What is left is `handleMessage`, ~460 lines, and the standing decision is NOT to rewrite it.** It is a
flat dispatch table on Azure event type. Each case is short; the length comes from the number of events
and from comments recording what each one cost to learn. Splitting it would spread one lookup table
across several files without reducing what a reader must hold in their head. Reopen only if a specific
case grows its own state worth owning — which is how all five extracted clusters announced themselves.

**If the file's size is still the concern**, the honest next lever is not another extraction: it is that
`useInterviewVoice` returns 19 members and is consumed by two very different callers (the interview page
and the editor Playground). Splitting by CONSUMER rather than by state is a different exercise, with a
real risk of changing behaviour, and it should be specified before it is attempted.

**Effort:** — (no action planned)
**Priority:** P4 — leave unless a case starts owning state.

## Avatar rate limit (docs/avatar-rate-limit.md)

Azure publishes **2 new avatar connections per minute** on S0; **measured, it is 3 per 60 s**, with the
60 s window confirmed by two independent `Retry after` values converging on the first request's
timestamp + 60 s. The ledger is now 3 per 60 s (v0.40.11.2); it was 2 per 20 s, both numbers wrong.

**There is no quota object to request** — verified four ways (resource usage API, Monitor metrics,
`Microsoft.Quota` provider, regional usages API: 287 items, none avatar or speech). Treat it as a fixed
service-side throttle, not an allocatable quota.

**Turning the avatar off avoids it entirely, and voice-only has no practical ceiling**: measured 40
voice-only sessions launched in 20 s (~120 new connections/minute, 4x the documented 30) with zero
failures, and zero avatar offers. That is the workaround for dense testing. What is left:

- [ ] **A rate-limit refusal should wait, not kick the candidate to text.** `useInterviewVoice`'s
      pre-connect error branch calls `policy.latchFatal()` for every error, with the reasoning that
      retrying `invalid_model` / an unsupported region is futile. Rate limiting is the opposite case:
      Azure states the delay ("Retry after 7.0s."). Today the candidate who could have had the digital
      human 7 seconds later gets a text interview instead. Needs a UX decision on what they see during
      the wait — a "queuing" state, not an error.
- [ ] **A dedicated rate-limit log.** Measured: this event is invisible on the Azure side — the usage
      API has no avatar entry, `ClientErrors` stays 0, and `Ratelimit` is a gauge of the limit rather
      than a count of refusals, because the refusal arrives in-band over the Voice Live WS and never
      becomes an HTTP 4xx on the resource. Our app is the only possible observation point.
- [ ] **The ledger is per-mount** (`avatarRequestsRef` is a `useRef`), so a reload, a second tab, the
      editor Playground alongside the interview, or a SECOND CANDIDATE on the same resource all bypass
      it. `sessionStorage` would cover the first three; two candidates needs a raised quota or
      server-side queueing. Pinned by a test that asserts today's behaviour
      (`useAvatarStream.quota.test.tsx`).
- [ ] **Verify the 5-minute idle disconnect.** Documented: the real-time avatar API disconnects after
      5 minutes idle or 30 minutes connected. A candidate thinking for over 5 minutes on one question
      would be disconnected, and the reconnect then spends from the 2/minute allowance. Not yet
      measured.
- [x] **~~Raising the quota~~ — settled: there is nothing to request.** The regional usages API tracks
      287 quota items for this subscription+region and not one is avatar or speech; they are model
      deployment capacity plus an account count. So a support request can only ask for a service-side
      limit to be raised, and the docs say these limits "aren't adjustable" unless otherwise specified.
      Plan around the fixed limit, not around a quota increase. Levers, both measured: turn the avatar
      off for rapid work (zero spend), and split across resources (3 per 60 s each).

## Interview (transcript UX)

### The candidate's own words do not stream onto the page

Owner, 2026-10-02: speaking produces nothing until a whole utterance finishes, then the text appears
at once. The frontend for this is already built and correctly isolated (`useInterviewVoice.ts:651`
accumulates `input_audio_transcription.delta` per item and re-emits a non-final segment; partials
never reach the submitted answer).

**Cause established by measurement (2026-10-02, real Azure).** Of the two hypotheses — (a) Azure does
not send it, (b) it sends it and our handler drops it (`:651` needs both `item_id` and `delta`) —
(a) holds and (b) is ruled out. A throwaway probe captured every frame on `/api/voice-live/ws`:
`input_audio_transcription.delta` = **0 frames**; a single `.completed` carried the whole utterance.
The frontend path is correct; nothing feeds it.

Second finding from the same run, unanticipated: `response.audio_transcript.delta` = **1** as well.
The interviewer's text also arrives in one piece, because mouth mode reads via
`pre_generated_assistant_message` (server-side TTS of our exact text, no inference) — there is nothing
to stream. So neither side streams today.

Two things are established and one is not. Established: the Voice Live reference defines
`conversation.item.input_audio_transcription.delta` as streaming partial results, across three API
versions; and this repo has never asserted that frame anywhere, so the path has never been verified
against real Azure. Not established: whether OUR configuration emits it. The code's own comment
names the suspect — "delta events off or absent, e.g. plain azure-speech configs" — and
`azure-speech` is exactly what `build_avatar_session` sends.

Voice Live lets the input transcription model be chosen, and the choice does not force a chat-model
change: with a text model like `gpt-5-mini` the alternatives are `azure-speech` (current) and
`mai-transcribe`/`mai-transcribe-2` (preview). The `gpt-4o-transcribe` family needs a multimodal chat
model, so it is off this path.

**What remains:** whether `mai-transcribe` streams deltas. Testing it means changing
`input_audio_transcription.model` in `build_avatar_session` and restarting — and that field feeds the
TRANSCRIPT, which is the scoring input. So the order is: measure whether deltas arrive; only if they
do, run a WAV word-error-rate A/B (same method as the 24→16 kHz change); switch only if both pass. `voice-live-azure.spec.ts` already
asserts on proxy frames. Reading the docs is what produced the wrong confidence in the first place.

Calibrate the expectation first: a cascaded recogniser revises phrase-sized partials, so the result
is text appearing and being rewritten, not a typewriter.

Two pieces worth doing regardless, neither needing anything from Azure: `speech_started`/
`speech_stopped` already arrive, so "listening" with a live level meter can be built today; and
`isFinal` exists on `TranscriptSegment` but `Transcript.tsx` ignores it, so there is no cue that a
line is still provisional — which is a prerequisite for the streaming version not looking like a bug.

**Effort:** the `azure-speech` half is measured (done). The `mai-transcribe` half is CC ~30 min to
measure plus a WAV A/B before it could ship.
**Priority:** P2 — the owner's stated goal is that the interview feel natural, and watching your own
words appear is a large part of that.

## E2E harness

### `admin-and-report.spec.ts` fails on any machine whose Chromium cannot capture audio

Measured 2026-10-02 on macOS: Playwright's bundled Chromium returns `NotSupportedError` from
`getUserMedia({audio:true})` — with `permissions: ["microphone"]` granted AND with
`--use-fake-device-for-media-stream`. So `initMic()` rejects, the page shows `MicPermissionDialog`,
and line 68's `expect(getByRole("textbox")).toBeVisible()` fails with "element(s) not found".

**The failure names the wrong thing.** The real cause is "this browser has no audio capture"; the
message a developer sees is "no textbox", which sends them into the layout code. CI is green
(Linux Chromium does support it), so this only ever bites locally — which is exactly when a
developer is trying to decide whether their own change broke something. It cost a bisect run and a
standalone `getUserMedia` probe to clear this branch.

**Fix:** before the textbox assertion, dismiss the dialog when it is present — the page already
offers the affordance (`Use text instead`), so the test should take the same path a candidate
without a mic takes. One conditional, and the spec then exercises the documented F9 AC #4 fallback
on EVERY machine instead of only on machines that happen to lack a mic by accident.

**Effort:** CC ~10 min.
**Priority:** P3 — local-only, but it mislabels its own cause, which is the expensive part.

## Completed
### Narrow viewports: question readable without scrolling — v0.40.9.0

Two changes, both measured before and after. The voice-status strip explained all four states at once
(248 of the first 486 pixels on a 390px phone); only the live state explains itself now, and below the
900px breakpoint only the live state shows at all — 248 → 68 pixels. And the stacked layout put the
stage before the question, so the question's TEXT was 144 pixels off an iPhone 14 and 76 off a desktop
window dragged under 900px; narrow screens now order the question first.

Worth recording: this was never a phone problem. A desktop window at 899px was just as broken, which is
what the width sweep showed and what a "mobile layout" framing would have missed.

Also worth recording: my first measurement said the question sat at y=319 and was fine. The selector was
case-insensitive and had matched the progress bar's "Question 1 of 2" instead of the card heading, and
the number disagreed with the screenshot. Taking both at the same moment, with a case-sensitive
leaf-only selector, gave 808 for the heading and 860-988 for the text.

**Priority:** P2
**Completed:** v0.40.9.0 — verified readable at 390x844, 899x800 and 1280x800.

### Connection policy extracted — the planned split is complete — v0.40.8.0

Step five, and the last of the planned clusters. `useConnectionPolicy.ts` owns who may open a session,
how often a drop is retried, and when to stop and surface a terminal error: five refs whose DIFFERENCES
carry the behaviour. Each was separately a shipped bug — a media-mode rebuild spending the retries a real
drop needs, that same reset hiding a terminal failure for ever, and two clicks on a deliberately
always-clickable affordance opening rival sessions sharing one set of refs.

The socket itself stayed in the hook on purpose: this owns the policy, not the resource. Routing `send`
through a module would have been a bigger, riskier change in the wrong direction.

Two test gaps found by mutation, both the same class — inputs with no discriminating power. A
single-entry backoff table cannot tell "hold the last interval" from "restart at the first", and one
counted attempt cannot tell whether teardown cleared a ceiling of six. Both replaced with inputs that
discriminate, and both mutations re-verified as caught.

Also fixed: two comments still named `intentionalCloseRef` after it ceased to exist. Dead names in live
prose are how a reader gets a wrong model — the same failure this release recorded for
`record_follow_up`.

**Priority:** P3
**Completed:** v0.40.8.0 — 1485 → 1481 lines, 481 frontend tests, and the 457 that existed before pass
UNMODIFIED. Cumulative across five steps: 1682 → 1481.

### Speak queue and idempotency guard extracted — v0.40.7.0

Step four. `useSpeakQueue.ts` owns which question text may be sent to be read, which waits behind an
in-flight response, and which was last attempted — three refs that cross-referenced each other from five
places. Each rule it now holds exists because of a shipped bug: the per-text guard stops the same
question being read two or three times (several routes reach the read path and every `response.done`
fires the flush), the single retry after a collision stops that same guard blocking the one legitimate
re-send, and latest-wins queueing stops a question the candidate has already left being read.

Two things worth recording. My first test for the rejection path asserted a contract that does not
exist — nothing tracks per-text rejections, here or in the original code; there is one outstanding
attempt and the rejection is about that. The wrong version looked reasonable, so it is rewritten as the
real contract with a note rather than quietly deleted. And one mutation could not be caught: making the
guard-clear unconditional is provably equivalent, because the guard is only ever set equal to the
attempt or to null, so a differing non-null value cannot arise. The proof is in the test file so a
future reader who mutates it and sees nothing fail knows why.

23 tests, 15 of 16 mutations caught, the sixteenth proved equivalent.

**Priority:** P3
**Completed:** v0.40.7.0 — 1505 → 1485 lines, 457 frontend tests, and the 434 that existed before pass
UNMODIFIED.

### Read-delivery watch extracted from the voice hook — v0.40.6.0

Step three. `useQuestionReadWatch.ts` owns making sure a question handed to the voice session actually
got read: the retry budget and its timer, the response-id claim that proves delivery, and the
text-similarity fallback for paths that carry no id.

That fallback is where the "read twice" regression lived, twice. A prefix-only check never confirmed a
paraphrase, so the watchdog re-read a question the candidate had already heard. It is now a plain
exported function with eight tests of its own.

One design correction found while wiring it: arming the watchdog and expecting a response are
*different* moments — `speakQuestion` arms before deciding how to deliver, and `emitSpeak` sets the
expectation when the request actually goes out. My first version collapsed them, which would have
claimed a response for a read that was never sent. Split into `arm` and `expectResponse`, with a test
asserting arming alone expects nothing.

36 tests. Fifteen deliberate mutations: thirteen caught, and the two misses were chased to a cause
rather than assumed — one was a real gap (my short-question case left an EMPTY word list, so it could
not tell whether the guard existed; replaced with a two-word case that discriminates) and one was a
genuine equivalent mutant, recorded in the test file instead of papered over.

**Priority:** P3
**Completed:** v0.40.6.0 — 1565 → 1505 lines, 434 frontend tests, and the 398 that existed before pass
UNMODIFIED.

### First-read gate extracted from the voice hook — v0.40.5.0

The rule that holds the opening question until the digital human can be heard: four pieces of state read
from `speakQuestion`, the readiness effect and the turn reset, with the precedence between them spread
across all three. Two shipped bugs came out of that spread — the opening words clipped because the read
beat the audio track, and every audio-only session sitting out the full timeout in silence because the
gate waited for painted frames rather than media readiness.

It owns one more thing worth naming: at teardown it RETURNS the text it was holding instead of dropping
it, because the page has already latched that question as spoken and will never ask again.

18 tests, and all ten deliberate mutations of the module were caught — including the two that matter
most, holding a read a second time after the bound elapsed, and losing the held text at teardown.

**Priority:** P3
**Completed:** v0.40.5.0 — 1602 → 1565 lines, 398 frontend tests, and the 380 that existed before pass
UNMODIFIED.

### Answer-draft cluster extracted from the voice hook — v0.40.4.0

Step one of the split. `useAnswerDraft.ts` now owns the candidate's in-progress answer: the buffered
segments, the streaming partials, an armed commit's promise, and the two end-of-utterance timers. The
`keepDraft` rule — the one that lived in two functions 700 lines apart and cost v0.40.0.0 a
deterministic draft loss — has one owner and 29 unit tests.

Two deliberate deviations from the plan, both only visible once the code was in hand. `commitAnswer`
did NOT move: it also depends on `activeResponseRef` and `linearTurns`, which are WebSocket turn
protocol rather than draft state, so moving it would have hidden the coupling instead of removing it.
The boundary landed at "the module owns state and its invariants, the hook owns protocol decisions",
which is why the module needs no `send` and no session refs. And `assistantLiveTranscriptRef` was
excluded: it accumulates the INTERVIEWER's transcript, so it is not part of the candidate's answer.

The test suite was mutation-checked rather than assumed: nine deliberate breakages, seven caught
immediately. Of the two that were not, one was a bad mutation on my part (the real call still ran) and
the other was an equivalent mutant — removing the commit's `clearTimeout` is invisible through
`resolve`, because the stray timer finds nothing armed. Two timer-count assertions were added so it is
detectable, since a leaked timeout per turn is a real leak across a long interview.

**Priority:** P3
**Completed:** v0.40.4.0 — 1682 → 1602 lines, 380 frontend tests, and the 351 that existed before pass
UNMODIFIED.

### `connect()` re-entrancy guarded, without breaking the paths that re-enter on purpose — v0.40.3.0

Two affordances reach `connect()` and are deliberately never disabled: the mic-permission dialog's
Retry and the top-bar voice pill, whose comment says it must stay retryable. Two clicks each
overwrote `wsRef` and `micReadyRef`, orphaning the earlier socket with its handlers still armed — it
could schedule its own reconnect and, if it still saw `session.updated`, run the connected-state and
avatar-handshake side effects through the same refs while `send()` pointed at the other socket. Two
logically distinct sessions live against one ref set, plus a second avatar offer against Azure's
rate limit.

A blanket "one connect at a time" would have been wrong, which is why this sat filed rather than
fixed: `restartForMediaMode` and the onclose retry both re-enter `connect()` legitimately, and
de-duplicating them would silently drop a media-mode switch. Intent is now explicit — those two
callers pass `replaceInFlight` and have already torn the old socket down, while a second click is
handed the in-flight promise and joins it. Joining is the right answer for a double-click: the
candidate wants voice, not two sessions, and superseding would spend an extra avatar request.

The marker is set synchronously, before the first await, because a connect does real async work
(unlocking autoplay, fetching a token, starting the mic) before it ever assigns `wsRef` — so checking
for an existing socket would have missed the race entirely. `connect`'s three flags also became a
named options object, since `connect(locale, false, true, true)` is how the fourth one gets set wrong.

**Priority:** P2
**Completed:** v0.40.3.0 — regression test verified in BOTH directions: removing the dedup makes the
double-click open two sockets, and making the dedup unconditional makes the mode-switch test fail.
### Interview mutation routes race on a stale session snapshot — fixed v0.40.2.0

**Outcome:** guarded the two bank-engine mutators that actually write against a cached snapshot —
`answer_finalized` and `abandon_interview` (`backend/app/interview/state_machine.py`) — with the
same optimistic-concurrency token already proven for the external engine
(`external_runner._reserve_turn`): `InterviewSession.turn_version` is now bumped by BOTH engines, so
it is a single unified freshness signal. `answer_finalized` takes a guarded
`UPDATE ... WHERE turn_version = :seen AND status = 'in_progress'` before writing any turn; zero
rows means a concurrent `/answer` or `/restart` already committed, and it raises
`InterviewStateError` (→ 409) rather than write beside or on top of that commit — a candidate must
retry, since blindly re-reading and continuing could write against a question they were never
shown. `abandon_interview` instead retries the same CAS in a bounded loop, because restart's intent
("abandon whatever is live") is content-independent and therefore safe to just re-attempt against
fresh state; it never surfaces a spurious 409 to a candidate who was simply unlucky in the race.
`/judge` and `/judge/apply` (`backend/app/api/interview.py`) got a lighter guard: a shared
`_turn_version_changed(db, session)` helper, checked immediately before each route's write (after
`/judge`'s LLM call returns, and right before `/judge/apply` marks an event applied) — on staleness
both return `verdict="wait"`, never a 409, because judging is invisible background pacing the
candidate never asked for and never sees fail. `/end` and `/recover` were deliberately left
unguarded: `/end`'s bank branch is a pure no-op and its external branch already goes through
`external_runner.end`'s own CAS; `/recover` is entirely delegated to the already-guarded
`external_runner.recover` and was never named by the TODO. No new migration — `turn_version` already
existed on `InterviewSession`; this only extends its use to the bank engine.

**Correction to the original TODO's framing:** the TODO describes `judge/apply`'s failure mode as
writing "an orphaned interviewer `follow_up` turn" for a stale question. That write path no longer
exists in current code — the nudge-only judged-turn refactor (`98f835e`, v0.39.3.0, 2026-09-28)
retired the `follow_up`/`redirect` verdicts, and `state_machine.record_follow_up` (the function that
would perform such a write) has zero callers anywhere in `app/` or `tests/` today. `judge_apply` now
only flips `JudgeEvent.applied` and returns text — it never touches `InterviewSession` or writes an
`InterviewTurn`. The underlying TOCTOU class the TODO is naming is still real, though: a stale
`judge`/`judge/apply` call can still consume a `judge_events` row and a budget slot for a question
the candidate already left, and a stale `/answer` vs `/answer` or `/answer` vs `/restart` race can
still land two writes that should never have both landed. That class is what this fix closes; the
specific "orphaned turn" mechanic the TODO named is stale documentation, not a live bug.

**Tests:** `backend/tests/test_interview_concurrency.py` — genuine interleaving via a file-backed
(not `:memory:`/`StaticPool`) aiosqlite DB with two independent `AsyncSession`s racing through
`asyncio.gather`, mirroring the pattern already established in `test_external_interview.py`:
two concurrent `answer_finalized` calls on one session (exactly one wins, one raises
`InterviewStateError`); a concurrent `answer_finalized` vs `abandon_interview` (restart always
eventually lands regardless of ordering, and the answer either lands cleanly first or is cleanly
rejected — never both landing in a corrupt order); and `_turn_version_changed` observing, from a
separate connection, a commit made by a genuinely concurrent `answer_finalized` while its own
"slow step" (an `asyncio.sleep` standing in for the real outbound LLM call) is in flight.

**Priority:** P2
**Completed:** v0.40.2.0 (2026-09-30) — see `backend/app/interview/state_machine.py`,
`backend/app/api/interview.py`, `backend/tests/test_interview_concurrency.py`.

### Voice-damage trigger: CLOSED by owner decision, not deferred

**Decision (owner, 2026-09-30):** the scenario it would cover — the interviewer's voice damaged while the
video decodes perfectly well — does not occur, so the trigger is not coming back. Recorded here so the
"gap" is not rediscovered and re-litigated: it was considered, measured, and deliberately left closed.

**The evidence behind the decision:** on the 1080p avatar under 3% packet loss the picture stops decoding
at the same time as the audio degrades, so "video bytes arriving while `framesDecoded` does not grow" —
which needs no threshold at all — already represents the whole link's condition. There is no measured
case of audio degrading on its own.

**What the alternative would have cost:** the concealment metric's healthy baseline is per-avatar (0.3-0.5%
on `lisa` 1080p, 8-19.3% on `amira` 512²; see `docs/avatar-weaknet-probe.md` §5.4.6), so a single global
threshold fires on healthy photo-avatar sessions. The shape that would have avoided a per-avatar threshold
table was a conjunction — concealment may only speak while the video is genuinely consuming bandwidth — so
a cheap stream is silent for free. Not implemented, and now not wanted.

**If this is ever reopened,** the bar is a real case: a session where the voice is measurably damaged while
`framesDecoded` keeps growing. Adding a trigger without one is what the six calibration runs argued
against.

**Status:** closed, no action.

### Picture restore verified end-to-end on a recovering link — v0.40.1.0

The run the whole calibration effort was for. Under OS-level shaping with the 1080p avatar, the session
dropped the picture by itself at 16 s on the threshold-free trigger (`decoding=false rtt=872ms`), the
shaping was removed at that moment, and the picture came back **64 seconds later** into a session that
genuinely decodes (`framesDecoded` 357, 3.0 MB of video across 10 post-restore windows). `earned: true`
— 2.83 M audio samples arrived during the hold, so `CONCEAL_GOOD` was exercised rather than ridden past
on silence: 0.475% audible concealment against a 3% threshold.

It also caught the desync fix doing its job in production, by one second: the first restore decision was
vetoed with `1s left on the Azure avatar rate-limit cooldown`, and the retry two seconds later landed.
Before that fix the policy would have recorded itself as being in video mode at that first decision and
never asked again, which is exactly why four earlier runs ended with the picture gone for good.

Six runs were needed, and five of them were inconclusive for reasons that were mine: a placeholder audio
path Chromium accepted silently, a metric that counted silence as damage, `__dirname` in an ESM spec, and
— the expensive one — not pinning the avatar, so every run used a 512² stream whose video decodes fine at
3% loss and therefore could never exercise the trigger under test.

**Priority:** P1
**Completed:** v0.40.1.0 (2026-09-30) — `frontend/e2e/avatar-restore-live.spec.ts`, report at
`frontend/e2e/output/restore-latest.json`, write-up in `docs/avatar-weaknet-probe.md` §5.4.5.

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
