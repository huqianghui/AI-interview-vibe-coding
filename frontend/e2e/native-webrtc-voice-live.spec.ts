/**
 * Voice Live's native WebRTC interface (`/voice-live/realtime/calls`) — audio only, no avatar.
 *
 * This follows the documented browser sample verbatim
 * (learn.microsoft.com/azure/ai-services/speech-service/voice-live-webrtc, "Standalone browser sample").
 * An earlier improvised version of this probe negotiated fine but received nothing, and comparing it
 * against the sample line by line found four deviations, each enough on its own to explain silence:
 *
 *   1. the data channel must be named `voice-live-events` — the docs route VAD, response-lifecycle and
 *      transcription events to that NAMED channel. A channel called anything else opens and stays empty.
 *   2. the signalling WebSocket takes the `realtime` subprotocol.
 *   3. the voice config has to match the model: the `azure-realtime` model wants
 *      `{type: "azure-realtime-native"}`, other models want `{type: "azure-standard"}`. Pairing
 *      `gpt-realtime` with an Azure TTS voice is not a combination the sample ever makes.
 *   4. the client sends NO conversation or response events. Turns are driven entirely by server VAD —
 *      the sample's instruction to the user is simply "Speak into your mic".
 *
 * Because of (4) this probe needs FAKE_AUDIO: without audio going up, nothing comes back, and that
 * would say nothing about the service.
 *
 * Signalling runs in the Node test process because a browser WebSocket cannot set an Authorization
 * header; the PeerConnection lives in the page and SDP is relayed between them.
 */
import { WebSocket as NodeWebSocket } from "ws";

import { expect, test } from "@playwright/test";

import { candidateToken, finishOpenInterview } from "./helpers/candidateLogin";

const LIVE = process.env.LIVE_VOICE === "1";
const API = process.env.E2E_API || "http://127.0.0.1:8000";
const BASE = process.env.BASE || "http://localhost:5173";
/** The sample's own defaults, which are a known-good pairing. Override to probe other combinations. */
const MODEL = process.env.CALLS_MODEL || "azure-realtime";
const VOICE = process.env.CALLS_VOICE || "ava";
const API_VERSION = process.env.CALLS_API_VERSION || "2026-01-01-preview";

/** Exactly the sample's `buildVoiceConfig`. */
function buildVoiceConfig(model: string, voice: string): Record<string, string> {
  // CALLS_VOICE_TYPE forces the pairing so the model/voice-type matrix can be probed deliberately
  // rather than only in the combination the sample happens to pick.
  const forced = process.env.CALLS_VOICE_TYPE;
  if (forced) return { type: forced, name: voice };
  if (model === "azure-realtime") return { type: "azure-realtime-native", name: voice || "diya" };
  return { type: "azure-standard", name: voice || "en-US-AvaNeural" };
}

test.describe("Voice Live native WebRTC (/calls), following the documented sample", () => {
  test.skip(!LIVE, "opt-in: set LIVE_VOICE=1");
  test.skip(
    !process.env.FAKE_AUDIO,
    "needs FAKE_AUDIO: turns are driven by server VAD, so silence in means silence out",
  );

  test("audio flows both ways over RTP with no avatar", async ({ page, request }) => {
    test.setTimeout(240_000);

    // --- a signalling URL + bearer from our own broker (it already targets /calls) -------------------
    const token = await candidateToken("user1");
    await finishOpenInterview(token);
    const mint = await request.post(`${API}/public/candidate/session`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(mint.ok(), `session mint failed: ${mint.status()}`).toBeTruthy();
    const anon = { "X-Anon-Session": (await mint.json()).token as string };
    const started = await request.post(`${API}/candidate/interview/start`, { headers: anon });
    expect(started.ok(), `start failed: ${started.status()}`).toBeTruthy();
    const ivId = (await started.json()).interview_session_id as string;
    const vsResp = await request.post(`${API}/candidate/interview/${ivId}/voice/session`, {
      headers: anon,
    });
    expect(vsResp.ok(), `voice/session failed: ${vsResp.status()}`).toBeTruthy();
    const vs = (await vsResp.json()) as { signaling_url: string; auth_token: string };

    // Model mode with the sample's own session config. The broker hands back an AGENT session; agent
    // params and the avatar block have no place on this transport (the docs say avatar configuration is
    // unsupported with side-band control), so they come off.
    const u = new URL(vs.signaling_url.replace(/^wss:/, "https:"));
    for (const k of [...u.searchParams.keys()]) if (k.startsWith("agent")) u.searchParams.delete(k);
    u.searchParams.set("model", MODEL);
    u.searchParams.set("api-version", API_VERSION);
    const signalingUrl = u.toString().replace(/^https:/, "wss:");
    const sessionConfig = {
      modalities: ["text", "audio"],
      instructions: "You are a helpful assistant. Respond concisely.",
      voice: buildVoiceConfig(MODEL, VOICE),
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
      },
    };
    console.log(`\n  host / path    : ${u.host}${u.pathname}`);
    console.log(`  model / voice  : ${MODEL} / ${JSON.stringify(buildVoiceConfig(MODEL, VOICE))}`);
    console.log(`  api-version    : ${API_VERSION}`);

    // --- the PeerConnection, built the way the sample builds it -------------------------------------
    await page.goto(`${BASE}/`);
    const offer = await page.evaluate(async () => {
      const w = window as unknown as {
        __pc: RTCPeerConnection;
        __dc: RTCDataChannel;
        __dcEvents: string[];
        __tracks: number;
      };
      const pc = new RTCPeerConnection();
      w.__pc = pc;
      w.__dcEvents = [];
      w.__tracks = 0;

      // Remote audio attached to an element, as the sample does.
      const audio = document.createElement("audio");
      audio.autoplay = true;
      document.body.appendChild(audio);
      pc.ontrack = (e) => {
        audio.srcObject = e.streams[0];
        w.__tracks += 1;
      };

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));

      // THE NAME MATTERS: the service forwards its events to `voice-live-events`.
      const dc = pc.createDataChannel("voice-live-events");
      w.__dc = dc;
      dc.onopen = () => w.__dcEvents.push("__open__");
      dc.onmessage = (e) => {
        try {
          w.__dcEvents.push(String((JSON.parse(String(e.data)) as { type?: string }).type ?? "?"));
        } catch {
          w.__dcEvents.push("<unparsed>");
        }
      };

      const o = await pc.createOffer();
      await pc.setLocalDescription(o);
      await new Promise<void>((r) => {
        if (pc.iceGatheringState === "complete") return r();
        pc.addEventListener("icegatheringstatechange", () => {
          if (pc.iceGatheringState === "complete") r();
        });
        setTimeout(r, 3000);
      });
      return pc.localDescription?.sdp ?? "";
    });
    expect(offer.length, "no SDP offer").toBeGreaterThan(100);

    // --- signalling: the `realtime` subprotocol, as the sample passes ------------------------------
    const wsEvents: string[] = [];
    let answerSdp = "";
    let callError = "";
    const ws = new NodeWebSocket(signalingUrl, ["realtime"], {
      headers: { Authorization: `Bearer ${vs.auth_token}` },
    });
    await new Promise<number>((resolve, reject) => {
      ws.once("open", () => resolve(Date.now()));
      ws.once("error", (e: Error) => reject(new Error(`signalling WS failed: ${e.message}`)));
      setTimeout(() => reject(new Error("signalling WS did not open in 30s")), 30_000);
    });
    ws.on("message", (raw: Buffer) => {
      try {
        const m = JSON.parse(raw.toString()) as Record<string, unknown>;
        const t = String(m.type ?? "?");
        wsEvents.push(t);
        if (t === "rtc.call.sdp.created" && m.sdp_answer) answerSdp = String(m.sdp_answer);
        if (t === "rtc.call.error" || t === "error") callError = raw.toString().slice(0, 400);
      } catch {
        wsEvents.push("<unparsed>");
      }
    });

    const tOffer = Date.now();
    ws.send(JSON.stringify({ type: "rtc.call.sdp.create", sdp_offer: offer, session: sessionConfig }));
    await expect
      .poll(() => (answerSdp ? 1 : callError ? -1 : 0), { timeout: 45_000, intervals: [250] })
      .not.toBe(0);
    if (callError) console.log(`  rtc.call.error : ${callError}`);
    expect(answerSdp, `no SDP answer. ws events: ${wsEvents.join(",")}`).not.toBe("");
    const tAnswer = Date.now();
    console.log(`  offer → answer : ${tAnswer - tOffer}ms`);

    await page.evaluate(async (sdp: string) => {
      await (window as unknown as { __pc: RTCPeerConnection }).__pc.setRemoteDescription({
        type: "answer",
        sdp,
      });
    }, answerSdp);

    const snap = async () =>
      page.evaluate(async () => {
        const w = window as unknown as {
          __pc: RTCPeerConnection;
          __dc?: RTCDataChannel;
          __dcEvents: string[];
          __tracks: number;
        };
        const pc = w.__pc;
        const out = {
          state: pc.connectionState,
          dc: w.__dc?.readyState ?? "none",
          dcEvents: w.__dcEvents.slice(),
          tracks: w.__tracks,
          level: 0,
          inBytes: 0,
          outBytes: 0,
          remote: "",
        };
        const r = await pc.getStats();
        const cands = new Map<string, Record<string, unknown>>();
        const pairs = new Map<string, Record<string, unknown>>();
        let selected = "";
        r.forEach((st) => {
          const row = st as unknown as Record<string, unknown>;
          if (row.type === "remote-candidate") cands.set(row.id as string, row);
          if (row.type === "candidate-pair") pairs.set(row.id as string, row);
          if (row.type === "transport" && typeof row.selectedCandidatePairId === "string") {
            selected = row.selectedCandidatePairId as string;
          }
          if (row.type === "inbound-rtp" && row.kind === "audio") {
            if (typeof row.audioLevel === "number") out.level = Math.max(out.level, row.audioLevel as number);
            if (typeof row.bytesReceived === "number") out.inBytes += row.bytesReceived as number;
          }
          if (row.type === "outbound-rtp" && row.kind === "audio" && typeof row.bytesSent === "number") {
            out.outBytes += row.bytesSent as number;
          }
        });
        const pair = selected ? pairs.get(selected) : undefined;
        const rc = pair ? cands.get(pair.remoteCandidateId as string) : undefined;
        if (rc) out.remote = `${rc.candidateType}/${rc.protocol} ${rc.address}:${rc.port}`;
        return out;
      });

    await expect.poll(async () => (await snap()).state, { timeout: 60_000, intervals: [250] }).toBe(
      "connected",
    );
    console.log(`  answer → connected: ${Date.now() - tAnswer}ms`);

    // --- no client events at all: server VAD drives the turn from the fake mic ----------------------
    let audibleAt: number | null = null;
    const tListen = Date.now();
    const until = tListen + 90_000;
    let last = "";
    while (Date.now() < until) {
      const s = await snap();
      if (audibleAt === null && s.level > 0.05) audibleAt = Date.now();
      const line = `${s.dcEvents.length} dc events, in ${s.inBytes}B, out ${s.outBytes}B`;
      if (line !== last && process.env.CALLS_TRACE === "1") {
        last = line;
        if (s.dcEvents.length) console.log(`  [${Math.round((Date.now() - tListen) / 1000)}s] ${line}  last: ${s.dcEvents[s.dcEvents.length - 1]}`);
      }
      if (audibleAt !== null && s.inBytes > 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const final = await snap();

    console.log("\n===== /calls, FOLLOWING THE DOCUMENTED SAMPLE =====");
    console.log(`  PC state            : ${final.state}`);
    console.log(`  data channel        : ${final.dc}`);
    console.log(`  remote audio tracks : ${final.tracks}`);
    console.log(`  negotiated remote   : ${final.remote || "(unresolved)"}`);
    console.log(`  OUTBOUND RTP audio  : ${final.outBytes} bytes`);
    console.log(`  INBOUND RTP audio   : ${final.inBytes} bytes`);
    console.log(`  voice audible       : ${audibleAt === null ? "NOT HEARD" : `${audibleAt - tListen}ms after listening started`}`);
    console.log(`  data-channel events : ${final.dcEvents.length ? [...new Set(final.dcEvents)].join(", ") : "(none)"}`);
    console.log(`  WS events           : ${[...new Set(wsEvents)].join(", ")}`);
    console.log("==================================================\n");

    ws.close();
    expect(final.outBytes, "we sent no audio, so nothing could come back").toBeGreaterThan(0);
    expect(final.dcEvents.filter((e) => e !== "__open__").length, "the service sent no events on voice-live-events").toBeGreaterThan(0);
    expect(final.inBytes, "no audio arrived over RTP").toBeGreaterThan(0);
  });
});
