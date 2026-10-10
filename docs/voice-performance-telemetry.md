# Voice performance telemetry

Where the time goes in a voice interview, measured where the candidate experiences it (the
browser) and where the work happens (the backend). Everything lands in the deployment's
Application Insights resource and is charted by the **AI Interview — Voice performance** workbook.

Only timings, ids, counts and outcomes are recorded. No transcript, answer, question or SOP text
ever goes into telemetry, from either side. Every URL has its query string stripped before it
leaves the page (the voice WebSocket URL carries a session token), and an `HttpError` exception is
cut down to its status line (the API layer puts the response body in the message). Telemetry never
throws into the interview: every call from a WebSocket or WebRTC handler is guarded.

## How it is wired

| Side | What | Where |
|---|---|---|
| Backend | OpenTelemetry via `azure-monitor-opentelemetry`: requests, outbound calls, SQL, plus business spans (`voice.session`, `judge.call`, `external_brain.turn`, `scoring.question`) and the `voice.azure_error` span event | `backend/app/telemetry.py` |
| Browser | App Insights JS SDK: page views and page-load timings, the page's `/api` calls (correlated with the backend's traces through W3C `traceparent`), the voice WebSocket (same correlation, see below), uncaught errors, three voice timing events and the WebRTC quality samples | `frontend/src/telemetry/` |
| Dashboard | Azure Workbook on the App Insights resource | `infra/azure/workbooks/voice-performance.json`, deployed by `infra/azure/modules/voice-workbook.bicep` |

The connection string is configured once, by the deployment: `monitoring.bicep` creates App
Insights, `main.bicep` passes its connection string to `container-apps.bicep`, which sets
`APPLICATIONINSIGHTS_CONNECTION_STRING` on the backend. The browser gets the same string at run time
from `GET /client-config` (one image serves every environment, so it cannot be baked into the
bundle). Without the variable (local dev, CI) both sides send nothing.

### Who can get the connection string

`/client-config` answers only a signed-in candidate or admin (401 otherwise), so the page starts
telemetry at sign-in, or on load when a session is already stored; an expired stored session waits
for the next sign-in. The string is not a secret in Azure Monitor's own terms: it lets a client
SEND telemetry to this resource and nothing else (reading needs Entra / RBAC, and it gives no access
to the app or any candidate data). What it allows is junk data in the dashboards. The login gate
keeps it away from anonymous callers; a signed-in user can still copy it from the browser's network
panel, which is true of every browser telemetry setup.

The SDK is a separate ~80 KB (gzip) chunk, loaded only after the config says App Insights is on and
the main thread is idle (at most 5 s), so it never delays the first paint or competes with the
voice prewarm. Events recorded before it loads are buffered (up to 200) and sent once it does. A
failed config read is retried once after 10 s.

### Networks that block the ingestion endpoint

The browser posts telemetry to the `IngestionEndpoint` host in the connection string (for the
public deployment, `swedencentral-0.in.applicationinsights.azure.com`). A corporate proxy or an
ad blocker that blocks `*.applicationinsights.azure.com` drops the browser events silently; the
interview itself is unaffected. If a client network needs it, ask for that host to be allowlisted.
Backend telemetry does not depend on the candidate's network.

## Tracing the voice WebSocket

App Insights instruments `fetch` and XHR by itself, not WebSockets, and a WebSocket cannot carry
headers. So the page does it by hand (`beginWebSocketTrace` in `telemetry/appInsights.ts`):

1. When it opens `/api/voice-live/ws` it adds `traceparent` (the page's trace id and a new span id)
   to the query string.
2. The backend starts its `voice.session` span as a child of that context
   (`telemetry.parent_context`; a malformed value is ignored, never trusted), and tags it with
   `voice.interview_id`.
3. When the socket closes, the page records it as a `WebSocket` dependency with that same span id:
   duration = session length, result code = the close code, `close_reason` and `live` as
   properties. It counts as a success only if its session went live (`session.updated`) AND it
   closed normally (1000 / 1001 / 1005, not the backend's `azure_stream_ended`, not a latched fatal
   such as `mic_rate_mismatch`). A tab closed mid-interview is reported on `pagehide`, sent with the SDK's unload transport (a
beacon), because an ordinary request started while the page is going away is cancelled with it; a socket
   replaced by a reconnect or a media-mode rebuild ends as `replaced` / `rebuilt`. The dependency is
   pinned to the trace it opened in, even if the page changed route before it closed.

In App Insights the browser's socket and the backend's session are then one parent / child pair in
the page's trace, and Azure Voice Live errors raised in the session (`voice.azure_error`, avatar
rate limit included) hang under it. A socket opened before the SDK has loaded is still recorded,
just not linked; the session is still findable by `voice.interview_id`.

The WebRTC media itself (avatar video and voice) runs browser ↔ Azure's TURN relay and never passes
the backend, so no server-side trace of it is possible: it is measured in the browser instead
(`voice.media`, below).

## The browser events

Every event carries `interview_id` (`playground` in the editor), `avatar`, `audio_path`
(`webrtc` when the interviewer's voice rides the avatar's WebRTC track, `ws` for voice-only PCM
over the WebSocket) and `linear_turns`. Measurements come in two forms: `t_<mark>` is the offset
of a mark from the event's first mark (for a waterfall), and the named durations below.

### `voice.setup`: one per voice connection

Starts when the page opens the voice WebSocket. Sent when the first interviewer audio is heard
(`outcome = heard`), on teardown (`closed`), when a reconnect starts a new setup (`superseded`), or
after 60 s (`timeout`).

| Measurement | From → to |
|---|---|
| `ws_open_ms` | WebSocket created → open |
| `proxy_connected_ms` | → the backend's `proxy.connected` frame (backend connected to Azure) |
| `session_updated_ms` | → Azure's `session.updated` (the Voice Live session is configured) |
| `first_video_frame_ms` | → the avatar's first painted frame |
| `media_ready_ms` | → media can carry the voice (first frame, or the audio track in audio-only mode) |
| `first_audible_ms` | → the candidate first hears the interviewer (question 1) |

### `voice.avatar`: one per avatar WebRTC handshake

The first connect (`label = initial`) and every recovery rebuild (`label = recovery`) each send one;
a media-mode switch is a new voice session, so its handshake is a new `initial`. `outcome`:

| Outcome | Ended by |
|---|---|
| `frame` | the first painted frame |
| `audio` | an audio-only session's connection coming up (ICE + DTLS); there is no frame to wait for |
| `ice_failed` | ICE `failed` |
| `no_frame` | ICE connected but no frame painted within 20 s |
| `sdp_timeout` | no SDP answer from Azure within 15 s |
| `handshake_failed` | the offer/answer exchange threw (createOffer, sending the offer, applying the answer) |
| `rebuilt` | a recovery rebuild replaced this connection before it finished |
| `superseded` | a newer handshake started while this one waited for the rate-limit allowance |
| `closed` | the voice session ended first |

| Measurement | From → to | Meaning |
|---|---|---|
| `hold_ms` | peer connection created → handshake start | waiting out Azure's avatar request allowance (3 per 60 s, `docs/avatar-rate-limit.md`); 0 unless reconnecting fast |
| `create_offer_ms` | handshake start → offer created | browser work |
| `first_host_ms` | offer created → first `host` candidate | local interfaces enumerated |
| `stun_srflx_ms` | offer created → first `srflx` candidate | **STUN**: the STUN server answered with our public address |
| `turn_relay_ms` | offer created → first `relay` candidate | **TURN**: the TURN allocation succeeded |
| `ice_gather_ms` | offer created → offer sent | our ICE gate (see `docs/avatar-latency-ice-gathering.md`) |
| `sdp_answer_ms` | offer sent → Azure's SDP answer | signalling round trip through the backend + Azure avatar setup |
| `ice_connect_ms` | answer applied → ICE `connected` | connectivity checks |
| `pc_connect_ms` | answer applied → peer connection `connected` | ICE + DTLS |
| `first_track_ms` | SDP answer received → first media track | the browser fires it while applying the answer |
| `first_frame_ms` | ICE connected → first painted frame | decode + first keyframe |
| `total_ms` | handshake start → first painted frame | the avatar's whole handshake, without the hold |
| `total_audio_ms` | handshake start → connection up | audio-only sessions |
| `rtt_ms` | | RTT of the selected candidate pair, from `getStats()` |

Dimensions: `local_candidate` / `remote_candidate` (`host`, `srflx`, `prflx`, `relay`),
`protocol` (`udp` / `tcp`), `relay_protocol` (`udp` / `tcp` / `tls`, for a relay), `video`.

The candidate timings are measured from the moment the offer is created, right before
`setLocalDescription` (the call that starts ICE gathering). The browser has no "STUN finished" event
of its own. The first server-reflexive candidate is the
moment a STUN binding response arrived, which is what the STUN timing means in practice. The same
goes for TURN and the first relay candidate.

### `voice.turn`: one per interviewer response

A turn is everything from the end of the previous interviewer response to the end of this one, so
an answered turn holds the candidate's answer and the next question's read. `kind`:

* `answer`: the candidate submitted (`/answer`), and this response is the next read.
* `aside`: the candidate spoke but did not submit, so the response was a judge nudge (or, in the
  editor Playground, a model turn).
* `opening`: a read with nothing before it, i.e. question 1, or a reconnect's re-read.

`heard` says whether the candidate's audio was detected at all.

| Measurement | From → to | Meaning |
|---|---|---|
| `speaking_ms` | first `speech_started` → last `speech_stopped` | the candidate talking (server VAD) |
| `stt_ms` | last `speech_stopped` → last transcript | speech-to-text |
| `commit_wait_ms` | last "I'm done" (or silence auto-submit) → `/answer` sent | waiting for the transcript to land; a click refused for an empty answer is replaced by the next one |
| `answer_http_ms` | `/answer` sent → returned | the backend: persistence, judge or external brain; the backend spans say which |
| `answer_to_read_ms` | `/answer` returned → read requested | page work before the next question is read |
| `read_to_created_ms` | read requested (`response.create`) → `response.created` | Azure accepting the read |
| `created_to_first_text_ms` | `response.created` → first transcript delta | |
| `created_to_first_audio_delta_ms` | `response.created` → first audio delta | TTS first byte (WS path only; on the avatar path audio rides WebRTC) |
| `created_to_audible_ms` | `response.created` → first audible sample | TTS + delivery + playback start |
| `response_ms` | `response.created` → `response.done` | |
| `click_to_audible_ms` | "I'm done" → first audible sample | **what the candidate feels** |
| `stop_to_audible_ms` | last `speech_stopped` → first audible sample | the same, from the end of speech |

"First audible" is measured per audio path. On the WS path the playback worklet posts `started`
the moment it renders a response's first sample. On the avatar path the receiver's `audioLevel` is
polled every 50 ms and a rise after 300 ms of silence counts; that reading is taken as packets
arrive, a jitter buffer (tens of ms) ahead of the speaker. Neither path sees a new response that
starts while the previous one is still playing (no silence in between): such a turn reports
`heard = false`.

Two rules keep the turn honest, both unit-tested in `voiceTimeline.test.ts`:

* Azure finishes sending a response's audio seconds before it finishes playing, so the previous
  question can still be audible after its `response.done`. A sound only counts as this turn's first
  audible sample once this turn's `response.created` exists.
* A turn is sent when its first audible sample and `response.done` have both happened, or 8 s after
  `response.done` if nothing is heard, or as soon as the candidate starts the next turn.

### `voice.media`: WebRTC quality, every 15 s

Sampled from the avatar connection's `getStats()` (the health sampler already reads it every 2 s;
`telemetry/mediaQuality.ts` adds no polling) and sent with the SDK's normal batch. Counters are
rates over the window, gauges the window's last reading. Properties: the event context above plus
`mode` (`video` / `audio-only`), `window_index` and `resolution`.

| Measurement | What |
|---|---|
| `window_s` | the window's length (about 15 s) |
| `rtt_ms` | RTT of the selected candidate pair |
| `audio_jitter_ms` | interarrival jitter of the audio stream |
| `jitter_buffer_ms` | average time audio waited in the jitter buffer |
| `audio_loss_pct` / `video_loss_pct` | packets lost / (lost + received) in the window |
| `audio_concealed_pct` | audio invented by AUDIBLE loss concealment (silence fill excluded) |
| `audio_kbps` / `video_kbps` | received bitrate |
| `available_in_kbps` | the browser's estimate of the downlink |
| `video_fps` | frames decoded per second |
| `video_frames_dropped`, `video_freezes`, `video_freeze_ms` | in the window |

A measurement the connection cannot provide (video on an audio-only connection, RTT before ICE
reports one) is left out rather than sent as 0. A cumulative counter that goes down (the stream
restarted) starts a fresh window instead of producing an invented rate. When the connection ends
(teardown, recovery rebuild, media-mode switch, or the tab closing) the partial window is sent if it is at least 5 s
long, marked `partial = true`: it is often the degraded stretch that made the connection end.

### Voice-only playback gaps (on `voice.turn`)

Without an avatar, the interviewer's audio is PCM on the WebSocket and plays through the page's
jitter buffer. Each time it runs dry mid-speech the turn the candidate heard it in counts it:
`playback_gaps` (how many) and `playback_gap_ms_total` (how long, summed), from the playback
worklet's own running totals. Gap time is only the silence between a gap's start and playback
resuming; the normal pause between utterances is not part of it.

## The workbook

Azure portal → the App Insights resource → **Workbooks** → **AI Interview — Voice performance**.
Sections:

* **End to end for one interview** (picked from the **Interview** parameter): every browser call,
  REST and the voice WebSocket, with the backend request or session it caused, the network gap
  (browser time minus server time), the backend's direct children (Azure OpenAI, SQL, judge,
  external brain), the Azure errors in the voice session, and the `operation_Id` for
  **Transaction search**; the interview's voice events in order; its WebRTC RTT / jitter, loss and
  video charts over the session.
* **Connection setup**, **avatar handshake** (stages, selected candidate path, outcomes,
  first-frame trend) and **turns** (answered-turn stages, opening reads, the candidate-felt latency
  trend, a per-turn table).
* **Voice WebSocket sessions**: by close code, how many are linked to a backend session, session
  length; backend sessions with Azure errors and avatar rate-limit hits.
* **WebRTC media quality**: p50 / p95 per media mode, freezes and dropped frames, RTT and loss
  trends, resolution received.
* **Voice-only playback gaps**, **page load** (browser timings), **API latency as the browser sees
  it** (browser vs server vs network, per route).
* **Scoring, judge and external brain**: per-question scoring trend, whole-report times, judge
  verdicts and latency, external brain turns; plus the backend spans, slowest routes, outbound
  calls and Azure errors.

`main.bicep` deploys it with the monitoring module. To deploy or update only the workbook, against
an existing App Insights resource:

```bash
az deployment group create -g <resource-group> \
  -f infra/azure/modules/voice-workbook.bicep -p appInsightsName=<app-insights-name>
```

## Querying directly

```kusto
// Answered-turn stages, one row per measurement
customEvents
| where name == "voice.turn" and tostring(customDimensions.kind) == "answer"
| mv-expand bagexpansion=array m = customMeasurements
| extend metric = tostring(m[0]), value = todouble(m[1])
| where metric endswith "_ms"
| summarize n = count(), p50 = percentile(value, 50), p95 = percentile(value, 95) by metric
```

`kind` and `last` are reserved words in KQL: read the dimension as `customDimensions.kind`, but do
not name an output column `kind`. And `countif(success)` is refused: write `countif(success == true)`.

For the server side of a slow `answer_http_ms`, the `/answer` request and its child spans
(`judge.call`, `external_brain.turn`, Azure OpenAI and SQL dependencies) are one trace in
**Transaction search**, joined to the browser's request by the same operation id.
