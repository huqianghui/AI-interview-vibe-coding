/**
 * Voice Live's NATIVE WebRTC interface — audio over WebRTC with no avatar involved.
 *
 * This is the entry point the series calls "the WebRTC mode", distinct from everything measured so far:
 *
 *   - our product path: WS session (`voice-live/realtime`) + `session.avatar.connect` → WebRTC carries the
 *     AVATAR's audio+video. Dropping the picture keeps audio on that same connection, but an avatar is
 *     still allocated.
 *   - no avatar at all: zero RTCPeerConnections, reply audio as PCM on the WebSocket.
 *   - THIS: `voice-live/realtime/calls`, where the WebSocket is only a signalling/control channel and the
 *     audio rides RTP in both directions. No avatar, by design — the docs state this mode does not
 *     support one, which is exactly why the product cannot use it.
 *
 * Documented flow (learn.microsoft.com/azure/ai-services/speech-service/voice-live-webrtc):
 *   1. open a WS control channel to `voice-live/realtime/calls`
 *   2. client sends `rtc.call.sdp.create` with `sdp_offer` — RAW SDP, not base64 (the avatar path's
 *      `client_sdp` IS base64; mixing them up is an easy way to get a rejected offer)
 *   3. server answers, audio flows on RTP tracks
 *
 * Note the docs also say this mode uses GLOBAL STANDARD deployments and routes to the nearest region,
 * where our WS sessions are pinned to one region — so a latency comparison here is not apples to apples
 * and the probe prints the negotiated ICE address to make the routing visible.
 *
 * Signalling runs in the Node test process because a browser WebSocket cannot set an Authorization
 * header; the PeerConnection stays in the page. SDP is relayed between them.
 */
import { WebSocket as NodeWebSocket } from "ws";

import { expect, test } from "@playwright/test";

import { candidateToken, finishOpenInterview } from "./helpers/candidateLogin";

const LIVE = process.env.LIVE_VOICE === "1";
const API = process.env.E2E_API || "http://127.0.0.1:8000/api";
const BASE = process.env.BASE || "http://localhost:5173";

interface VoiceSessionOut {
  signaling_url: string;
  auth_token: string;
  auth_type: string;
  mode: string;
  model: string;
  session_config: Record<string, unknown>;
  avatar_enabled?: boolean;
}

test.describe("Voice Live native WebRTC (/calls) — audio only, no avatar", () => {
  test.skip(!LIVE, "opt-in: set LIVE_VOICE=1");

  test("negotiates audio over RTP and times the first spoken reply", async ({ page, request }) => {
    test.setTimeout(240_000);

    // --- 1. a voice session: the backend mints the signalling URL + a short-lived bearer -------------
    const token = await candidateToken("user1");
    await finishOpenInterview(token);
    const mint = await request.post(`${API}/public/candidate/session`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(mint.ok(), `session mint failed: ${mint.status()}`).toBeTruthy();
    const anon = { "X-Anon-Session": (await mint.json()).token as string };
    const started = await request.post(`${API}/candidate/interview/start`, { headers: anon });
    expect(started.ok(), `start failed: ${started.status()} ${await started.text()}`).toBeTruthy();
    const ivId = (await started.json()).interview_session_id as string;
    const vsResp = await request.post(`${API}/candidate/interview/${ivId}/voice/session`, {
      headers: anon,
    });
    expect(vsResp.ok(), `voice/session failed: ${vsResp.status()} ${await vsResp.text()}`).toBeTruthy();
    const vs = (await vsResp.json()) as VoiceSessionOut;
    // MODEL mode on purpose, when asked: the broker returns an AGENT session (model empty), and agent
    // mode is the leading suspect for a connection that negotiates but returns no media. Rebuilding the
    // URL with a bare `model=` isolates the transport from the agent. Same endpoint, same bearer.
    if (process.env.CALLS_MODEL) {
      const u = new URL(vs.signaling_url.replace(/^wss:/, "https:"));
      for (const k of [...u.searchParams.keys()]) {
        if (k.startsWith("agent")) u.searchParams.delete(k);
      }
      u.searchParams.set("model", process.env.CALLS_MODEL);
      vs.signaling_url = u.toString().replace(/^https:/, "wss:");
      vs.mode = "model";
      vs.model = process.env.CALLS_MODEL;
      // A minimal session for model mode: no avatar, no agent-specific fields.
      vs.session_config = {
        modalities: ["text", "audio"],
        instructions: "You are a helpful assistant. Reply in one short sentence.",
        voice: { type: "azure-standard", name: "en-US-AvaNeural" },
        turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
      };
      console.log(`  FORCED model mode    : ${process.env.CALLS_MODEL}`);
    }
    const host = new URL(vs.signaling_url.replace(/^wss:/, "https:")).host;
    console.log(`\n  signalling host : ${host}`);
    console.log(`  path            : ${new URL(vs.signaling_url.replace(/^wss:/, "https:")).pathname}`);
    console.log(`  mode / model    : ${vs.mode} / ${vs.model}`);
    console.log(`  auth_type       : ${vs.auth_type}  (token ${vs.auth_token.length} chars, not printed)`);
    console.log(`  avatar_enabled  : ${vs.avatar_enabled ?? false}`);
    expect(
      vs.signaling_url,
      "this probe is about the /calls endpoint; the broker returned something else",
    ).toContain("/voice-live/realtime/calls");

    // --- 2. the PeerConnection lives in the page ----------------------------------------------------
    await page.goto(`${BASE}/`);
    const offer = await page.evaluate(async () => {
      const w = window as unknown as { __pc: RTCPeerConnection };
      const pc = new RTCPeerConnection();
      w.__pc = pc;
      // Audio both ways: Azure needs a track to send into, and we need one to receive.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // addTrack ALONE. Adding a transceiver as well produced a second m=audio line, and a two-audio-line
      // offer negotiated fine yet carried no media — a malformed offer that fails silently, not a
      // limitation of the transport.
      for (const t of stream.getAudioTracks()) pc.addTrack(t, stream);
      // The docs put response-lifecycle events on a WebRTC data channel in this mode, so create one
      // before the offer and record what arrives on it.
      const w2 = window as unknown as { __dcLog: string[]; __dc?: RTCDataChannel };
      w2.__dcLog = [];
      const dc = pc.createDataChannel("realtime");
      w2.__dc = dc;
      dc.addEventListener("open", () => w2.__dcLog.push("open"));
      dc.addEventListener("message", (e) => w2.__dcLog.push(String((e as MessageEvent).data).slice(0, 160)));
      const o = await pc.createOffer();
      await pc.setLocalDescription(o);
      // Wait for gathering so the offer is complete (this mode has no trickle path here).
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === "complete") return resolve();
        const t = setTimeout(resolve, 5000);
        pc.addEventListener("icegatheringstatechange", () => {
          if (pc.iceGatheringState === "complete") {
            clearTimeout(t);
            resolve();
          }
        });
      });
      return pc.localDescription?.sdp ?? "";
    });
    expect(offer.length, "no SDP offer was produced in the page").toBeGreaterThan(100);
    const mLines = offer.split(/\r?\n/).filter((l) => l.startsWith("m="));
    console.log(`  offer m= lines  : ${mLines.join(" | ")}`);

    // --- 3. signalling from Node, which can set the Authorization header ----------------------------
    const events: string[] = [];
    let answerSdp = "";
    let rtcError = "";
    const ws = new NodeWebSocket(vs.signaling_url, {
      headers: { Authorization: `Bearer ${vs.auth_token}` },
    });
    const tOpen = await new Promise<number>((resolve, reject) => {
      ws.once("open", () => resolve(Date.now()));
      ws.once("error", (e: Error) => reject(new Error(`signalling WS failed: ${e.message}`)));
      setTimeout(() => reject(new Error("signalling WS did not open in 30s")), 30_000);
    });
    ws.on("message", (raw: Buffer) => {
      const text = raw.toString();
      try {
        const m = JSON.parse(text) as Record<string, unknown>;
        const t = String(m.type ?? "?");
        events.push(t);
        if (t === "rtc.call.sdp.created") answerSdp = String(m.sdp_answer ?? m.sdp ?? "");
        if (t === "rtc.call.error" || t === "error") rtcError = text.slice(0, 400);
      } catch {
        events.push("<unparsed>");
      }
    });

    const { avatar: strippedAvatar, ...audioOnlySession } = vs.session_config as Record<string, unknown>;
    console.log(`  avatar in session_config stripped: ${strippedAvatar !== undefined}`);

    const tOffer = Date.now();
    ws.send(
      JSON.stringify({
        type: "rtc.call.sdp.create",
        sdp_offer: offer, // RAW SDP — the avatar path's base64 would be rejected here
        // Strip `avatar` — this transport does not support one, and leaving it in asks Azure for a video
        // avatar on a connection that has no video m-line. The broker fills it in because the persona has
        // a character; that is correct for the WS path and wrong here.
        session: audioOnlySession,
      }),
    );
    await expect
      .poll(() => (answerSdp ? 1 : rtcError ? -1 : 0), { timeout: 45_000, intervals: [250] })
      .not.toBe(0);
    console.log(`  WS open → offer sent : ${tOffer - tOpen}ms`);
    if (rtcError) console.log(`  rtc error            : ${rtcError}`);
    expect(answerSdp, `no SDP answer. events: ${events.join(",")} ${rtcError}`).not.toBe("");
    const tAnswer = Date.now();
    console.log(`  offer → SDP answer   : ${tAnswer - tOffer}ms`);
    // Does the ANSWER keep the data channel? If Azure answers without m=application, the channel can
    // never open and the conversation events have nowhere to go but the signalling WS.
    const answerM = answerSdp.split(/\r?\n/).filter((l) => l.startsWith("m="));
    console.log(`  answer m= lines      : ${answerM.join(" | ")}`);
    console.log(`  answer keeps datachannel: ${answerM.some((l) => l.startsWith("m=application"))}`);

    await page.evaluate(async (sdp: string) => {
      const w = window as unknown as { __pc: RTCPeerConnection };
      await w.__pc.setRemoteDescription({ type: "answer", sdp });
    }, answerSdp);

    const stats = async () =>
      page.evaluate(async () => {
        const w = window as unknown as { __pc: RTCPeerConnection };
        const pc = w.__pc;
        const out = {
          state: pc.connectionState,
          level: 0,
          audioBytes: 0,
          videoBytes: 0,
          remote: "",
          // Outbound too: if we are sending nothing, server VAD has nothing to react to and a silent
          // reply says more about this probe than about the transport.
          sentBytes: 0,
          sentPackets: 0,
          micLevel: 0,
        };
        const r = await pc.getStats();
        const locals = new Map<string, Record<string, unknown>>();
        r.forEach((st) => {
          const row = st as unknown as Record<string, unknown>;
          if (row.type === "remote-candidate") locals.set(row.id as string, row);
          if (row.type === "inbound-rtp" && row.kind === "audio") {
            if (typeof row.audioLevel === "number") out.level = Math.max(out.level, row.audioLevel as number);
            if (typeof row.bytesReceived === "number") out.audioBytes += row.bytesReceived as number;
          }
          if (row.type === "inbound-rtp" && row.kind === "video" && typeof row.bytesReceived === "number") {
            out.videoBytes += row.bytesReceived as number;
          }
          if (row.type === "outbound-rtp" && row.kind === "audio") {
            if (typeof row.bytesSent === "number") out.sentBytes += row.bytesSent as number;
            if (typeof row.packetsSent === "number") out.sentPackets += row.packetsSent as number;
          }
          if (row.type === "media-source" && typeof row.audioLevel === "number") {
            out.micLevel = Math.max(out.micLevel, row.audioLevel as number);
          }
          if (row.type === "candidate-pair" && (row.nominated === true || row.state === "succeeded")) {
            const rc = locals.get(row.remoteCandidateId as string);
            if (rc) out.remote = `${rc.candidateType}/${rc.protocol} ${rc.address}:${rc.port}`;
          }
        });
        return out;
      });

    await expect.poll(async () => (await stats()).state, { timeout: 60_000, intervals: [250] }).toBe(
      "connected",
    );
    const tConnected = Date.now();
    console.log(`  answer → PC connected: ${tConnected - tAnswer}ms`);
    console.log(`  negotiated remote    : ${(await stats()).remote || "(not resolved)"}`);

    // --- 4. make it speak, and time until the voice is audible --------------------------------------
    // Give the channel real time to open instead of reading its state the instant the PC connects.
    const dcOpened = await page
      .waitForFunction(
        () => (window as unknown as { __dc?: RTCDataChannel }).__dc?.readyState === "open",
        undefined,
        { timeout: 20_000 },
      )
      .then(() => true)
      .catch(() => false);
    const dcState = await page.evaluate(() => {
      const w = window as unknown as { __dc?: RTCDataChannel; __dcLog: string[] };
      return { state: w.__dc?.readyState ?? "none", log: w.__dcLog };
    });
    console.log(`  data channel         : ${dcState.state} (opened: ${dcOpened})  messages: ${dcState.log.length}`);

    const ask = {
      item: {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Say exactly: the connection is working." }],
        },
      },
      go: { type: "response.create" },
    };
    const tAsk = Date.now();
    // Try the data channel first (what the docs describe), and send on the WS too — whichever the service
    // honours, the measurement is the same; which one worked is visible in the events below.
    const sentOnDc = await page.evaluate((payload: { item: unknown; go: unknown }) => {
      const w = window as unknown as { __dc?: RTCDataChannel };
      if (w.__dc?.readyState !== "open") return false;
      w.__dc.send(JSON.stringify(payload.item));
      w.__dc.send(JSON.stringify(payload.go));
      return true;
    }, ask);
    console.log(`  ask sent on          : ${sentOnDc ? "data channel (WS used only for SDP)" : "NOWHERE — data channel never opened"}`);
    if (!sentOnDc) {
      // Deliberately NOT falling back to the WS: the point of this probe is the WebRTC path. Falling
      // back would measure the thing already measured and hide whichever half is actually missing.
      console.log("  (no WS fallback on purpose — this probe is about the WebRTC path)");
    }

    // With FAKE_AUDIO the fake mic is already streaming the answer into the RTP track, so server VAD can
    // drive the turn on its own — which is how this mode is meant to be used. Without it, the only trigger
    // is the data-channel request above.
    console.log(`  fake mic             : ${process.env.FAKE_AUDIO ? "streaming (server VAD can trigger)" : "none"}`);
    let audibleAt: number | null = null;
    const until = Date.now() + (process.env.FAKE_AUDIO ? 90_000 : 60_000);
    while (Date.now() < until && audibleAt === null) {
      if ((await stats()).level > 0.05) audibleAt = Date.now();
      else await new Promise((r) => setTimeout(r, 100));
    }
    const final = await stats();

    console.log("\n===== VOICE LIVE NATIVE WebRTC (/calls), AUDIO ONLY =====");
    console.log(`  OUTBOUND RTP audio      : ${final.sentBytes} bytes / ${final.sentPackets} packets  (mic level ${final.micLevel.toFixed(4)})`);
    console.log(`  inbound RTP audio bytes : ${final.audioBytes}`);
    console.log(`  inbound RTP video bytes : ${final.videoBytes}`);
    console.log(`  ask → voice audible     : ${audibleAt === null ? "NOT HEARD" : `${audibleAt - tAsk}ms`}`);
    console.log(`  total WS open → audible : ${audibleAt === null ? "—" : `${audibleAt - tOpen}ms`}`);
    console.log(`  events seen             : ${[...new Set(events)].join(", ") || "(none)"}`);
    const dcAfter = await page.evaluate(() => (window as unknown as { __dcLog: string[] }).__dcLog);
    console.log(`  data-channel messages   : ${dcAfter.length}`);
    dcAfter.slice(0, 6).forEach((m) => console.log(`      ${m}`));
    if (rtcError) console.log(`  rtc error               : ${rtcError}`);
    console.log("=========================================================\n");

    ws.close();
    expect(
      final.audioBytes,
      "no audio arrived over RTP on the /calls transport — negotiation succeeded, media did not",
    ).toBeGreaterThan(0);
    expect(audibleAt, "the reply never became audible").not.toBeNull();
  });
});
