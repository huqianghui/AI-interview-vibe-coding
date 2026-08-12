# SPEC — Azure Voice Live agent-mode contract (interviewer digital-human voice)

**Status:** Authoritative, live-verified against real Azure (`avarda-demo-prj`, swedencentral,
2026-08-12). Shipped in v0.23.1.0 on branch `feat/foundry-avatar-parity`.

**Why this document exists.** Getting the `/interview` "语音作答" (Answer by voice) path to actually
connect the interviewer's Foundry **prompt agent** over WebRTC — so the Lisa digital-human appears
and the agent speaks — took a long, layered debugging session. Nearly every layer had a subtle,
undocumented-or-mis-documented requirement, and several of the errors Azure returns are **misleading**
(they point at the wrong cause). This spec captures the *exact* working contract plus every trap, so
the feature stays working and any future regression is diagnosable in minutes, not days.

If voice breaks again, **start with §7 (the copy-paste checklist)** and §8 (error → cause table).

---

## 0. TL;DR — the one thing that mattered most

Azure Voice Live agent-mode signaling requires **hyphenated** query keys:
`agent-name`, `agent-project-name`, `agent-version` — **NOT** the underscore forms
`agent_id` / `agent_project_name`. With the underscore forms a normal browser WebRTC offer fails
`agent_initialization_failed`; with the hyphenated forms the *same* offer completes the full
`session.created → session.updated → rtc.call.sdp.created` handshake. Every other "fix" we tried
(codec limiting, stripping the BUNDLE line, audio-only offers, dropping the datachannel) was a **red
herring** caused by the wrong key casing. This was found by cross-referencing the sibling
**AI-Coach-vibe-coding** project's working implementation
(`docs/microsoft-agent-framework/02-model-vs-agent-mode.md`).

---

## 1. Architecture (who does what)

```
Browser (candidate)                    Backend (token broker)              Azure Voice Live
──────────────────                     ─────────────────────               ────────────────
click "语音作答"
  │  POST /candidate/interview/{id}/voice/session
  │ ───────────────────────────────────>  create_voice_session()
  │                                          - resolve default persona
  │                                          - P5 gate: agent_sync_status == "synced"
  │                                          - build compact session_config
  │                                          - mint Entra bearer (ai.azure.com scope)
  │                                          - build signaling URL (hyphenated keys)
  │  <─────────────────────────────────── 200 { signaling_url, auth_token, session_config, … }
  │
  │  getUserMedia({audio:true})  ── mic
  │  new RTCPeerConnection() + addTrack(mic) + addTransceiver(video,recvonly) + createDataChannel
  │  createOffer() → setLocalDescription → wait ICE gather
  │
  │  ws = new WebSocket(signaling_url + "&Authorization=Bearer%20<token>")
  │  ws.send({type:"rtc.call.sdp.create", sdp_offer, session: session_config})
  │ ─────────────────────────────────────────────────────────────────────>  agent init + SDP
  │  <── {type:"session.created"}
  │  <── {type:"session.updated"}
  │  <── {type:"rtc.call.sdp.created", sdp_answer}
  │  pc.setRemoteDescription(answer)  ──  WebRTC media flows (mic↑, TTS audio↓, avatar video↓)
  │  <══ RTP audio track  +  RTP avatar video track  +  datachannel events (transcripts/VAD)
```

**Boundary invariants (SPEC F9 / P4):** audio/video never transit the backend. The backend is a pure
**token broker** — it hands the browser a short-lived bearer + the signaling URL, nothing else. The
browser connects **directly** to Azure over WebRTC.

Key backend files:
- `backend/app/services/voice_broker.py` — `create_voice_session()` + `build_signaling_url()`.
- `backend/app/services/voice_providers.py` — `AzureVoiceProvider.issue_credential()` (token mint).
- `backend/app/services/agents/voice_live_metadata.py` — `build_session()` (runtime config) +
  `build_agent_metadata_session()` (compact agent-metadata config) + `build_voice_live_metadata()`.
- `backend/app/services/agents/adapters/azure_agent_sync.py` — creates/updates the Foundry agent.

Key frontend file:
- `frontend/src/hooks/useInterviewVoice.ts` — the whole WebRTC bootstrap + signaling.

---

## 2. The signaling URL contract (the core fix)

Built by `voice_broker.build_signaling_url()`. Emit EXACTLY this shape for agent mode:

```
wss://{host}/voice-live/realtime/calls
    ?api-version=2026-01-01-preview
    &agent-name=<bare agent id>
    &agent-project-name=<foundry project name>
    &agent-version=<version>          # only when known
```

Then the browser appends the auth token as a query param (browsers can't set WS headers):
```
    &Authorization=Bearer%20<entra-bearer-token>
```

**Every element matters — the traps:**

| Element | Correct value | Wrong value we shipped first | Symptom of the wrong value |
|---|---|---|---|
| Endpoint path | `/voice-live/realtime/calls` | `/voice-live/realtime` | works for the WS upgrade but is the model/websocket path, not the WebRTC-call path |
| api-version | `2026-01-01-preview` | `2026-07-15` (GA) | `404` on `/calls`; also `2026-04-10`+ reject classic agents |
| Agent id key | **`agent-name`** (hyphen) | `agent_id` / `agent_name` (underscore) | **`agent_initialization_failed`** on a real browser offer |
| Project key | **`agent-project-name`** (hyphen) | `project_name` / `project_id` / `agent_project_name` | "Missing required agent project name" (underscore) |
| Version key | **`agent-version`** (hyphen) | `agent_version` | ignored / init failure |
| Agent id value | **bare name** (`interviewer-<uuid>`) | `name:version` (`interviewer-…:2`) | the SDK returns `id` as `name:version`; the `:version` suffix must be stripped before it goes in the URL |
| Host | `…cognitiveservices.azure.com` | `…services.ai.azure.com` | Voice Live requires the `cognitiveservices` host, not the Foundry account host |

**Model mode** (fallback, not used for the interviewer — kept for completeness): same path +
api-version, but `?…&model=<realtime-model>` instead of the agent keys. Note `gpt-5.4-mini` is NOT a
Voice Live realtime model in swedencentral ("not supported in this region"); the realtime models are
`gpt-realtime` / `gpt-realtime-mini` (`gpt-4o-realtime-preview` is retired).

---

## 3. Authentication (Entra bearer, NOT API key / NOT STS)

Agent mode authorizes against the **AI Agent service**. Facts (live-verified + confirmed by the
AI-Coach POC table):

- **Entra ID bearer works.** Mint with scope **`https://ai.azure.com/.default`** (FOUNDRY_SCOPE), via
  `DefaultAzureCredential` (`az login` locally / Managed Identity in prod). This is what
  `AzureVoiceProvider.issue_credential(scope=FOUNDRY_SCOPE)` returns for agent mode.
- **API-key auth is rejected in agent mode** ("Key authentication is not supported in Agent mode").
- **STS-issued token (`/sts/v1.0/issueToken`) does NOT work** — it's wrapped as a Bearer but Azure
  validates via the Entra pipeline; STS is not Entra-signed → **401**. (AI-Coach's code uses STS, but
  its POC table shows STS=401; on our shared resource key auth is disabled anyway, so STS returns
  `403 AuthenticationTypeDisabled`.)
- **Scope split by mode:** the broker passes `FOUNDRY_SCOPE` (`ai.azure.com`) for **agent** mode and
  `COGNITIVE_SERVICES_SCOPE` (`cognitiveservices.azure.com`) for **model** mode. A cognitiveservices
  token on an agent session is rejected "Unauthorized to AI Agent service".
- **Token passed as `Authorization=Bearer%20<token>` query param** (browsers can't set WS headers;
  a bare `api-key`/`access_token` query is rejected 401 on this endpoint).

**RBAC (Azure-side, not code):** the signed-in identity needs the **Foundry User** role (formerly
"Azure AI User") on the Foundry project. Without it, agent init fails with the *misleading*
`agent_initialization_failed` "check … the identity permissions". This is granted in the Azure portal
→ project → Access control (IAM). One-time setup, not something code can fix.

---

## 4. The Foundry agent itself (created by agent-sync)

The persona syncs to a real Foundry **prompt agent** via
`AzureAgentSyncAdapter.sync_persona()` → `client.agents.create_version(PromptAgentDefinition(...))`.
Requirements for that agent to be voice-capable:

1. **Must be a NEW-type agent, not "classic".** Our `create_version` produces new-type agents (they
   resolve via `client.agents.get()`); pre-existing portal agents like `avarda-demo-agent` may be
   stale **classic** agents (they appear in `list()` but 404 on `get()`). Classic agents are rejected
   by api-version `2026-04-10`+. Fix if stale: **re-sync the persona** (retry-sync) to mint a fresh
   new-type agent, then the persona's `agent_id` points at it.

2. **Voice mode is enabled via agent metadata** — `microsoft.voice-live.enabled: "true"` +
   `microsoft.voice-live.configuration: <json>`.

3. **The metadata config MUST fit in ONE metadata value (≤512 chars).** This is the second-biggest
   trap. Azure caps a metadata value at ~512 chars. Our full config (~690 chars) was chunked into
   `microsoft.voice-live.configuration` + `microsoft.voice-live.configuration.1`, and **Voice Live
   does NOT reassemble a split value → `agent_initialization_failed`** (and the portal shows the
   agent's voice mode as OFF). Fix: `build_agent_metadata_session()` emits a **compact** config
   (~226 chars, single key): `voice` + `turn_detection` + `avatar` + `proactive_engagement` only. The
   verbose runtime knobs (transcription / EOU / noise / echo / interim) are applied at *runtime* via
   `session.update`, not baked into the agent metadata. **Never let the metadata config exceed one
   key** — a regression test guards this (`test_agent_metadata_config_is_single_key_and_compact`).

---

## 5. The WebRTC offer + session config (runtime)

### 5.1 The browser offer is STANDARD — do not munge it

Once the query keys are hyphenated, a **vanilla Chromium offer works**: BUNDLE group, datachannel
m-line, full codec list, recvonly video transceiver — all fine. During debugging we wrongly added
codec-limiting, `ondatachannel`-only, and BUNDLE-stripping workarounds; **all were reverted.** The
current hook (`useInterviewVoice.ts`) does the normal thing:

- `pc.addTrack(micTrack, micStream)` — bidirectional audio.
- `pc.addTransceiver("video", { direction: "recvonly" })` — so the avatar video track isn't dropped.
- `pc.createDataChannel("voice-live-events")` before `createOffer` — carries transcripts / VAD /
  response lifecycle.
- `createOffer()` → `setLocalDescription` → wait for ICE gathering (5s cap) → open WS → send
  `rtc.call.sdp.create` with `sdp_offer` + inline `session` config.

### 5.2 The runtime `session.update` must be trimmed for agent + avatar

The broker's `session_config` (what the browser sends in `session.update` / inline `session`) is
built by `build_session()` then trimmed in `create_voice_session()` for agent+avatar mode. **Drop
these fields** or Azure rejects the session:

| Field dropped | Azure error if left in |
|---|---|
| `voice` | "Cannot update voice when avatar is configured" (voice is fixed at agent/avatar level) |
| `proactive_engagement` | "'session.proactive_engagement' unexpected (extra fields not permitted)" |
| `interim_response` | same "unexpected field" class |

These three are **agent-metadata-level** settings (set at sync time in §4), not runtime-session
fields. What remains in the runtime config: `turn_detection`, `input_audio_transcription`,
`input_audio_noise_reduction`, `input_audio_echo_cancellation`, and `modalities: ["text","audio","avatar"]`.

### 5.3 `speakQuestion` must not override instructions

The interviewer must speak the **backend-authoritative** question text, not an agent-generated one.
Do it by injecting the question as an assistant conversation item + firing a **bare**
`response.create`. Do **NOT** put `instructions` in `response.create` — agent mode rejects it
("Overriding instructions in response.create is not supported").

---

## 6. End-to-end success signal

A working connection produces this signaling event sequence (verified via Playwright fake-mic):

```
session.created → session.updated → rtc.call.sdp.created
→ response.audio_transcript.delta (×N)   ← the agent is speaking
```

Observable UI state: `avatar-view[data-avatar-connected="true"]`, the 静音 / 我答完了 controls
enabled (they're disabled until `connectionState === "connected"`), and NO "语音不可用" notice.

---

## 7. Copy-paste verification checklist (run this if voice regresses)

Prereqs: real `.env` (Foundry endpoint/key/project), `az login` done, backend + frontend running,
the default persona `agent_sync_status == "synced"`.

1. **Backend brokers a 200 with the right URL shape.** Confirm the signaling URL is
   `…/voice-live/realtime/calls?api-version=2026-01-01-preview&agent-name=<bare>&agent-project-name=<proj>&agent-version=<v>`
   (hyphens! bare agent id! `/calls`!).
2. **Token audience is `ai.azure.com`** for agent mode (decode the JWT `aud`).
3. **Agent is new-type + voice-enabled + single-key metadata.** `client.agents.get(name)` resolves
   (not 404 = not classic); its metadata has `microsoft.voice-live.enabled=true` and exactly ONE
   `microsoft.voice-live.configuration` key (no `.1`).
4. **RBAC:** identity has **Foundry User** on the project.
5. **Live browser probe** (fake mic, no human):
   ```
   LIVE_VOICE=1 BASE=http://localhost:5173 npx playwright test --config=e2e/live.config.ts
   ```
   (or the standalone `voice-live-azure.spec.ts`). Expect `sdpCreated=true`, `avatarConnected=true`,
   `response.audio_transcript.delta` frames, no "语音不可用".

**Direct WS probe from Python** (bypasses the browser; catches contract regressions fast). Note the
venv often lacks a CA bundle — use `ssl.create_default_context(cafile=certifi.where())` — and Azure
throws transient `ClientOSError 54` resets, so retry 8–15×. A stub SDP fails at SDP-parse *before*
agent-init, so a stub reaching "allocate client error" means the agent+auth+URL are all good.

---

## 8. Error → cause quick reference (Azure's messages are misleading)

| Azure error (WS frame) | Real cause | Fix |
|---|---|---|
| `Missing required agent project name` | project key wrong/absent | use `agent-project-name` (hyphen) |
| `Classic foundry agent is not supported in API version 2026-04-10 and above` | agent is classic OR api-version too new | api-version `2026-01-01-preview`; re-sync persona to a new-type agent |
| `Authentication error to AI Agent service: Unauthorized` | token scope wrong | mint with `ai.azure.com` scope, not `cognitiveservices` |
| `agent_initialization_failed` / "check … identity permissions" | **misleading** — several causes: (a) underscore query keys, (b) split (>512) metadata config, (c) missing Foundry User RBAC | (a) hyphenate keys; (b) compact single-key metadata; (c) grant Foundry User |
| `allocate client error: Remote client allocation failed` (with `SDP inconsistent` / fake ICE) | expected for a STUB SDP (no real ICE) — means agent-init PASSED | use a real browser offer |
| `Cannot update voice when avatar is configured` | runtime `session.update` carried `voice` while avatar on | drop `voice` from runtime config |
| `'session.proactive_engagement' unexpected` | runtime config carried an agent-metadata-level field | drop `proactive_engagement` / `interim_response` from runtime config |
| `Overriding instructions in response.create is not supported` | `speakQuestion` set `instructions` | fire a bare `response.create` |
| `403 AuthenticationTypeDisabled` on `/sts/v1.0/issueToken` | key auth disabled on the resource | don't use STS; use Entra bearer |
| WS handshake `404` | wrong endpoint/api-version combo | `/voice-live/realtime/calls` + `2026-01-01-preview` |
| WS handshake `401` | token expired or wrong param name / scope | fresh token, `Authorization=Bearer%20…` query |

---

## 9. Reference: the sibling project that unblocked this

`/Users/huqianghui/Downloads/1.github/AI-Coach-vibe-coding` has a working agent-voice implementation.
Most useful sources when this contract needs revisiting:
- `docs/microsoft-agent-framework/02-model-vs-agent-mode.md` — the auth POC table (Entra vs API key
  vs STS) and the hyphenated query-key convention.
- `backend/app/services/voice_live_webrtc.py` — its `create_webrtc_session_config()` broker.
- `frontend/src/hooks/use-voice-live-webrtc.ts` — its WebRTC bootstrap (standard offer, no munging).

Note that project's resource is the **same** `ai-foundary-hu-sweden-central2` — so its region/model
constraints match ours exactly.

---

## 10. What NOT to do (reverted dead ends — don't reintroduce)

- ❌ Don't limit offered audio codecs (`setCodecPreferences` to Opus-only). Unnecessary.
- ❌ Don't strip the `a=group:BUNDLE` line from the offer. It's required; stripping it breaks media
  allocation ("Required BUNDLE group attribute is missing").
- ❌ Don't avoid creating the datachannel on the offer PC (the `ondatachannel`-only workaround).
  Standard `createDataChannel` before the offer is correct.
- ❌ Don't send an audio-only offer / skip the recvonly video transceiver — the avatar needs it.
- ❌ Don't chunk the agent-metadata voice config across `…configuration.1` keys — keep it ≤512 in one
  key.
- ❌ Don't use API-key or STS auth for agent mode. Entra `ai.azure.com` bearer only.
- ❌ Don't bump `voice_live_api_version` to `2026-07-15`/GA without re-verifying — it 404s on `/calls`
  and rejects classic agents.
