# backend/scripts — operator probes

Stand-alone probes that measure the deployed (or local) stack the way the candidate page uses it.
They are NOT part of CI (they need a running backend with real Azure credentials) and never hit
Azure directly unless told to (`voice_turn_latency.py --direct`).

## Prerequisites (both probes)

- A **candidate** account (role `user`) dedicated to probing. `/public/candidate/session` requires a
  candidate JWT since the login gate (v0.38.0.0), so each probe logs in first via `/auth/login`.
  Pass `--username/--password` or export `PROBE_USERNAME` / `PROBE_PASSWORD`. Admin accounts are
  refused (403). Locally the seeded `user1` works — its derived password is shown in `/admin/users`.
- Each run starts a **fresh** interview: `/start` resumes an in-progress one, so a resumed session
  past question 1 is `/restart`-ed first. Unless `--no-finish`, the probe answers the remaining
  questions untimed afterwards so the account is not left mid-interview.

## `brain_turn_rtt.py` — HTTP round trips of the interview brain

`/candidate/interview/start` (first question) and `/candidate/interview/{id}/answer` (submit →
next question) per turn, single concurrency. Output: per-run JSON + median/min/max per turn.

```bash
PROBE_USERNAME=user1 PROBE_PASSWORD=... \
python scripts/brain_turn_rtt.py --server http://127.0.0.1:8000 --runs 5 --max-turns 4
```

## `voice_turn_latency.py` — Voice Live turn latency at the WS-proxy level

Streams 16 kHz PCM16 mono `u*.wav` utterances into `/voice-live/ws` exactly like the mic
(100 ms chunks, silence between), and records VAD start/stop, STT final, `response.created`,
first text/audio delta, `response.done`.

Turn contract follows the session the proxy reports on `proxy.connected`:

- **MOUTH sessions** (`linear_turns: true` — every linear/judged bank persona and every external
  persona; production default): the model never takes a turn. The probe emulates the page's real
  chain — transcript → HTTP `/answer` (**`brain_rtt`**) → read the next question with
  `response.create` + `pre_generated_assistant_message` (server-side TTS, what the page sends since
  v0.39.2.3). Q1 is read the same way right after connect (`read-q1`), and the closing "text turn"
  is a pure TTS read (`read-turn`). `gen_*` metrics are relative to that read request.
- **Agent sessions** (editor Playground persona): the original bare `response.create` / user-item
  flow.

Fidelity notes: an empty transcript is a FAILED turn (production never submits one); when the last
answer completes the interview no read is timed (production reads nothing — the page moves to
review); probe WAVs must be single continuous utterances (production joins every VAD segment since
the last commit, the probe submits on the first completed segment).

```bash
PROBE_USERNAME=user1 PROBE_PASSWORD=... \
python scripts/voice_turn_latency.py --server http://127.0.0.1:8000 \
  --audio-dir /tmp/probe-audio --runs 3
```

Caveat: with an avatar-enabled persona the assistant AUDIO rides the WebRTC track, not the WS, so
`first_audio_delta` / `audio_delta_count` stay empty in proxy mode — `first_text_delta` /
`audio_done` / `response_done` are the usable TTS markers. `--direct` (no proxy, no avatar) exposes
the audio deltas.

Making an utterance file from macOS: `say -v Samantha -o u1.aiff "…"` then
`afconvert -f WAVE -d LEI16@16000 -c 1 u1.aiff u1.wav`. (16 kHz, not 24: the session now
declares `input_audio_sampling_rate: 16000` to match the browser — see
`docs/voice-live-control-notes.md` §4. A 24 kHz file trips the frame-rate assert.)

## `export_openapi.py` — the frontend's API contract snapshot

Not a probe: it needs no backend running and no Azure. After changing a route or a request/response
model, re-export the schema and regenerate the frontend types:

```bash
cd backend && python scripts/export_openapi.py   # writes frontend/src/api/openapi.json
cd ../frontend && npm run gen:api                # regenerates frontend/src/api/schema.d.ts
npm run typecheck                                # contract.check.ts names any drifted field
```

CI enforces each step: `tests/test_openapi_snapshot.py` fails on a stale snapshot,
`schema.sync.test.ts` on a stale `schema.d.ts`, and `npm run typecheck` on a hand-written API type
that is no longer a refinement of its backend schema.
