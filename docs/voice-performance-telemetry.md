# Voice performance telemetry

Where the time goes in a voice interview, measured where the candidate experiences it (the
browser) and where the work happens (the backend). Everything lands in the deployment's
Application Insights resource and is charted by the **AI Interview — Voice performance** workbook.

Only timings, ids, counts and outcomes are recorded. No transcript, answer, question or SOP text
ever goes into telemetry, from either side, and every URL has its query string stripped before it
leaves the page (the voice WebSocket URL carries a session token).

## How it is wired

| Side | What | Where |
|---|---|---|
| Backend | OpenTelemetry via `azure-monitor-opentelemetry`: requests, outbound calls, SQL, plus business spans (`voice.session`, `judge.call`, `external_brain.turn`, `scoring.question`) and the `voice.azure_error` span event | `backend/app/telemetry.py` |
| Browser | App Insights JS SDK: page views, the page's `/api` calls (correlated with the backend's traces through W3C `traceparent`), uncaught errors, and three voice timing events | `frontend/src/telemetry/` |
| Dashboard | Azure Workbook on the App Insights resource | `infra/azure/workbooks/voice-performance.json`, deployed by `infra/azure/modules/voice-workbook.bicep` |

The connection string is configured once, by the deployment: `monitoring.bicep` creates App
Insights, `main.bicep` passes its connection string to `container-apps.bicep`, which sets
`APPLICATIONINSIGHTS_CONNECTION_STRING` on the backend. The browser gets the same string at run time
from `GET /public/client-config` (one image serves every environment, so it cannot be baked into the
bundle). Without the variable (local dev, CI) both sides send nothing.

The SDK is a separate ~80 KB (gzip) chunk, loaded only after the config says App Insights is on, so
it never delays the first paint or the voice prewarm. Events recorded before it loads are buffered
and sent once it does.

### Networks that block the ingestion endpoint

The browser posts telemetry to the `IngestionEndpoint` host in the connection string (for the
public deployment, `swedencentral-0.in.applicationinsights.azure.com`). A corporate proxy or an
ad blocker that blocks `*.applicationinsights.azure.com` drops the browser events silently; the
interview itself is unaffected. If a client network needs it, ask for that host to be allowlisted.
Backend telemetry does not depend on the candidate's network.

## The three browser events

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

The first connect (`label = initial`), every recovery rebuild and every media-mode switch each send
one. `outcome` is `frame`, `audio` (audio-only session), `ice_failed`, `sdp_timeout`, `superseded`
or `closed`.

| Measurement | From → to | Meaning |
|---|---|---|
| `create_offer_ms` | peer connection created → local offer set | browser work |
| `first_host_ms` | offer set → first `host` candidate | local interfaces enumerated |
| `stun_srflx_ms` | offer set → first `srflx` candidate | **STUN**: the STUN server answered with our public address |
| `turn_relay_ms` | offer set → first `relay` candidate | **TURN**: the TURN allocation succeeded |
| `ice_gather_ms` | offer set → offer sent | our ICE gate (see `docs/avatar-latency-ice-gathering.md`) |
| `sdp_answer_ms` | offer sent → Azure's SDP answer | signalling round trip through the backend + Azure avatar setup |
| `ice_connect_ms` | answer applied → ICE `connected` | connectivity checks |
| `pc_connect_ms` | answer applied → peer connection `connected` | ICE + DTLS |
| `first_track_ms` | answer applied → first media track | |
| `first_frame_ms` | ICE connected → first painted frame | decode + first keyframe |
| `total_ms` | peer connection created → first painted frame | the avatar's whole handshake |
| `total_audio_ms` | peer connection created → audio track live | audio-only sessions |
| `rtt_ms` | | RTT of the selected candidate pair, from `getStats()` |

Dimensions: `local_candidate` / `remote_candidate` (`host`, `srflx`, `prflx`, `relay`),
`protocol` (`udp` / `tcp`), `relay_protocol` (`udp` / `tcp` / `tls`, for a relay), `video`.

The browser has no "STUN finished" event of its own. The first server-reflexive candidate is the
moment a STUN binding response arrived, which is what the STUN timing means in practice. The same
goes for TURN and the first relay candidate.

### `voice.turn`: one per interviewer response

A turn is everything from the end of the previous interviewer response to the end of this one, so
an answered turn holds the candidate's answer and the next question's read. `kind = opening` is a
read with no answer before it (question 1); `kind = answer` is the rest. `heard` says whether the
candidate's audio was detected at all.

| Measurement | From → to | Meaning |
|---|---|---|
| `speaking_ms` | first `speech_started` → last `speech_stopped` | the candidate talking (server VAD) |
| `stt_ms` | last `speech_stopped` → last transcript | speech-to-text |
| `commit_wait_ms` | "I'm done" (or silence auto-submit) → `/answer` sent | waiting for the transcript to land |
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
arrive, a jitter buffer (tens of ms) ahead of the speaker.

Two rules keep the turn honest, both unit-tested in `voiceTimeline.test.ts`:

* Azure finishes sending a response's audio seconds before it finishes playing, so the previous
  question can still be audible after its `response.done`. A sound only counts as this turn's first
  audible sample once this turn's `response.created` exists.
* A turn is sent when its first audible sample and `response.done` have both happened, or 8 s after
  `response.done` if nothing is heard, or as soon as the candidate starts the next turn.

## The workbook

Azure portal → the App Insights resource → **Workbooks** → **AI Interview — Voice performance**.
Sections: connection setup, avatar handshake (stages, selected candidate path, outcomes, first-frame
trend), turns (answered-turn stages, opening reads, the candidate-felt latency trend, a per-turn
table for one interview picked from the **Interview** parameter), and the backend spans, routes,
outbound calls and Azure errors.

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
not name an output column `kind`.

For the server side of a slow `answer_http_ms`, the `/answer` request and its child spans
(`judge.call`, `external_brain.turn`, Azure OpenAI and SQL dependencies) are one trace in
**Transaction search**, joined to the browser's request by the same operation id.
