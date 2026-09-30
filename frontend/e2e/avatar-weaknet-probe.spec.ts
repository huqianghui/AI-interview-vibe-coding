/**
 * LIVE avatar WEAK-NETWORK probe (opt-in, real Azure — NOT CI).
 *
 * Question it answers: does Azure's avatar sender ADAPT its video bitrate to the receiver's network
 * (RTCP REMB / transport-cc feedback), or does it push a fixed bitrate and freeze when the link is
 * narrower than that? The answer decides the deployment rule for client office networks (photo
 * avatar as a hard requirement vs. a nice-to-have).
 *
 * What it records, once per second, from the avatar `RTCPeerConnection` via `getStats()`:
 *   - inbound-rtp video: bitrate (from bytesReceived deltas), fps, frame size, packetsLost,
 *     freezeCount / totalFreezesDuration, framesDropped, nack/pli/fir counts, jitterBufferDelay
 *   - inbound-rtp audio: bitrate, packetsLost, concealedSamples (packet-loss concealment = audible glitches)
 *   - selected candidate-pair: RTT, availableIncomingBitrate (the receiver-side BWE estimate),
 *     local/remote candidate type (host / srflx / relay — TURN relay matters for office firewalls)
 *   - the main Voice Live WebSocket UPLINK byte rate (mic PCM16 base64 frames) via a WebSocket.send wrap
 * plus, once: the negotiated codec + the remote SDP's rtcp-fb / b= lines (whether REMB / transport-cc
 * were even offered/answered), and the local SDP's b= line when BAS_KBPS is set.
 *
 * Network shaping is NOT done here (Chrome DevTools throttling does not touch WebRTC's UDP media).
 * Shape at the OS level (macOS dnctl/pfctl, Network Link Conditioner) and label the run with PROFILE.
 *
 * Env:
 *   LIVE_VOICE=1      opt-in
 *   PROFILE=<label>   free-text label for the network profile in effect (default "baseline")
 *   PROBE_MS=60000    sampling window after the avatar PC connects
 *   BAS_KBPS=<n>      optional: inject `b=AS:<n>` under m=video in OUR SDP offer (receiver-declared max
 *                     bitrate) to test whether Azure honours a client-side bandwidth cap.
 *
 * Run: LIVE_VOICE=1 PROFILE=baseline npx playwright test avatar-weaknet-probe --config=e2e/live.config.ts
 * Output: e2e/output/weaknet-<PROFILE>-<timestamp>.json + a console summary table.
 */
import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { enterVoiceChannel, primeCandidateLogin, waitForInterviewStage } from "./helpers/candidateLogin";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE = process.env.LIVE_VOICE === "1";
const BASE = process.env.BASE || "http://localhost:5173";
const PROFILE = process.env.PROFILE || "baseline";
const PROBE_MS = Number(process.env.PROBE_MS || 60_000);
const BAS_KBPS = Number(process.env.BAS_KBPS || 0);
/** Mid-session experiment: at MID_AT_S seconds after the avatar PC connects, send a `session.update`
 * over the Voice Live WS setting `avatar.video.bitrate` = MID_BITRATE (bps). MID_MODE=partial sends only
 * `{avatar:{video:{bitrate}}}`; MID_MODE=full (default) re-sends the whole `session.avatar` object from the
 * last `session.updated` (minus ice_servers) with the bitrate changed. */
const MID_BITRATE = Number(process.env.MID_BITRATE || 0);
const MID_AT_S = Number(process.env.MID_AT_S || 15);
const MID_MODE = process.env.MID_MODE || "full";
/** AUDIO_ONLY_OFFER=1: drop the video transceiver from OUR SDP offer (audio recvonly only) to test whether
 * Azure's avatar endpoint will run audio-only — the in-session "turn the picture off, keep the voice"
 * degradation path. */
const AUDIO_ONLY_OFFER = process.env.AUDIO_ONLY_OFFER || ""; // "" | "1"/"drop" | "inactive"

type Sample = {
  t: number;
  video: {
    kbps: number;
    fps: number | null;
    w: number | null;
    h: number | null;
    packetsLost: number;
    framesDropped: number;
    freezeCount: number;
    freezeDurS: number;
    nack: number;
    pli: number;
    fir: number;
    jbDelayMs: number | null;
    decodeMs: number | null;
    /** Cumulative frames decoded. Flat-while-bytes-flow is the shipped policy's primary trigger. */
    framesDecoded: number;
    /** Whether the decoder emitted anything during this window. */
    decoding: boolean;
  } | null;
  audio: {
    kbps: number;
    packetsLost: number;
    concealed: number;
    /** Total samples the receiver emitted, concealed ones included. */
    totalSamples: number;
    /** concealedSamples / totalSamplesReceived over this window — the metric the shipped policy
     * (`frontend/src/hooks/avatarHealth.ts`) actually thresholds on. Immune to DTX silence, unlike a
     * per-second rate. Recorded here so CONCEAL_BAD / CONCEAL_GOOD can be calibrated from real runs. */
    concealRatio: number | null;
    jitterMs: number | null;
  } | null;
  pair: { rttMs: number | null; bweKbps: number | null; local: string; remote: string; state: string } | null;
  wsUpKbps: number;
  ice: string;
  conn: string;
};

test.describe("Avatar weak-network probe (real Azure)", () => {
  test.skip(!LIVE, "opt-in: set LIVE_VOICE=1");
  test.setTimeout(PROBE_MS + 120_000);

  test(`sample avatar RTP stats under network profile "${PROFILE}"`, async ({ page }) => {
    const consoleLines: { t: number; line: string }[] = [];
    const t0 = Date.now();
    page.on("console", (msg) => {
      const txt = msg.text();
      if (txt.includes("[voice]") || txt.includes("[avatar-stream]"))
        consoleLines.push({ t: Math.round((Date.now() - t0) / 1000), line: txt });
    });

    // Instrument: collect every RTCPeerConnection, its SDPs, and the Voice Live WS uplink bytes.
    await page.addInitScript(
      ({ basKbps, audioOnly }) => {
        const w = window as unknown as {
          __pcs: RTCPeerConnection[];
          __sdp: { local?: string; remote?: string }[];
          __wsUp: { bytes: number; frames: number };
        };
        w.__pcs = [];
        w.__sdp = [];
        w.__wsUp = { bytes: 0, frames: 0 };

        /** `session.avatar.ice_servers` carries Azure's TURN relay username+credential. This probe
         * writes its events to a JSON file and prints them, so strip those before they are ever
         * captured — redacting at the sink would still leave them in the page's memory and in any
         * future consumer of `__wsEvents`. Everything else about the avatar block is kept: the
         * bitrate/codec/resolution echo is the whole point of the probe. */
        const redactAvatar = (avatar: unknown): unknown => {
          if (!avatar || typeof avatar !== "object") return avatar;
          const { ice_servers: iceServers, ...rest } = avatar as Record<string, unknown> & {
            ice_servers?: { urls?: unknown }[];
          };
          if (!Array.isArray(iceServers)) return rest;
          return {
            ...rest,
            ice_servers: iceServers.map((server) => ({ urls: server?.urls, credentials: "<redacted>" })),
          };
        };

        const OrigPC = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends OrigPC {
          constructor(...args: unknown[]) {
            // @ts-expect-error passthrough
            super(...args);
            w.__pcs.push(this);
            w.__sdp.push({});
          }
        } as unknown as typeof RTCPeerConnection;

        // Patch the prototype (not the subclass) so the overload signatures stay intact.
        const proto = OrigPC.prototype as unknown as {
          createOffer: (this: RTCPeerConnection, ...a: unknown[]) => Promise<RTCSessionDescriptionInit>;
          setLocalDescription: (this: RTCPeerConnection, d?: RTCLocalSessionDescriptionInit) => Promise<void>;
          setRemoteDescription: (this: RTCPeerConnection, d: RTCSessionDescriptionInit) => Promise<void>;
        };
        if (audioOnly) {
          const origAddTransceiver = OrigPC.prototype.addTransceiver;
          OrigPC.prototype.addTransceiver = function (
            this: RTCPeerConnection,
            trackOrKind: MediaStreamTrack | string,
            init?: RTCRtpTransceiverInit,
          ) {
            if (trackOrKind === "video") {
              if (audioOnly === "inactive") return origAddTransceiver.call(this, trackOrKind, { direction: "inactive" });
              // Skip the video m-line entirely; return a dummy so the caller's code keeps working.
              return { direction: "inactive" } as unknown as RTCRtpTransceiver;
            }
            return origAddTransceiver.call(this, trackOrKind, init);
          };
        }
        const origCreateOffer = proto.createOffer;
        const origSetLocal = proto.setLocalDescription;
        const origSetRemote = proto.setRemoteDescription;
        proto.createOffer = async function (this: RTCPeerConnection, ...args: unknown[]) {
          const offer = await origCreateOffer.apply(this, args);
          if (basKbps > 0 && offer.sdp) {
            // Insert a receiver-declared bandwidth cap right after the m=video section's c= line.
            const lines = offer.sdp.split("\r\n");
            const out: string[] = [];
            let inVideo = false;
            for (const line of lines) {
              out.push(line);
              if (line.startsWith("m=")) inVideo = line.startsWith("m=video");
              else if (inVideo && line.startsWith("c=")) {
                out.push(`b=AS:${basKbps}`);
                out.push(`b=TIAS:${basKbps * 1000}`);
              }
            }
            offer.sdp = out.join("\r\n");
          }
          return offer;
        };
        proto.setLocalDescription = function (this: RTCPeerConnection, desc?: RTCLocalSessionDescriptionInit) {
          const i = w.__pcs.indexOf(this);
          if (desc?.sdp && i >= 0) w.__sdp[i].local = desc.sdp;
          return origSetLocal.call(this, desc);
        };
        proto.setRemoteDescription = function (this: RTCPeerConnection, desc: RTCSessionDescriptionInit) {
          const i = w.__pcs.indexOf(this);
          if (desc?.sdp && i >= 0) w.__sdp[i].remote = desc.sdp;
          return origSetRemote.call(this, desc);
        };

        // Record every WebSocket + the server events we care about (session.updated / error / avatar).
        const ww = window as unknown as {
          __wss: WebSocket[];
          __wsEvents: { t: number; type: string; detail?: unknown }[];
          __lastSession?: Record<string, unknown>;
          __t0: number;
        };
        ww.__wss = [];
        ww.__wsEvents = [];
        ww.__t0 = Date.now();
        const OrigWS = window.WebSocket;
        const WrappedWS = function (this: WebSocket, url: string | URL, protocols?: string | string[]) {
          const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
          ww.__wss.push(ws);
          ws.addEventListener("message", (ev: MessageEvent) => {
            if (typeof ev.data !== "string") return;
            try {
              const msg = JSON.parse(ev.data) as { type?: string; session?: Record<string, unknown>; error?: unknown };
              const type = msg.type || "?";
              if (type === "session.updated" && msg.session) ww.__lastSession = msg.session;
              if (type === "session.updated" || type === "session.created" || type === "error" || type.startsWith("session.avatar"))
                ww.__wsEvents.push({
                  t: Math.round((Date.now() - ww.__t0) / 1000),
                  type,
                  detail:
                    type === "error"
                      ? msg.error
                      : type === "session.updated"
                        ? { avatar: redactAvatar((msg.session as { avatar?: unknown })?.avatar) }
                        : undefined,
                });
            } catch {
              /* non-JSON frame */
            }
          });
          return ws;
        } as unknown as typeof WebSocket;
        WrappedWS.prototype = OrigWS.prototype;
        Object.defineProperty(WrappedWS, "CONNECTING", { value: OrigWS.CONNECTING });
        Object.defineProperty(WrappedWS, "OPEN", { value: OrigWS.OPEN });
        Object.defineProperty(WrappedWS, "CLOSING", { value: OrigWS.CLOSING });
        Object.defineProperty(WrappedWS, "CLOSED", { value: OrigWS.CLOSED });
        window.WebSocket = WrappedWS;

        const origSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
          const n =
            typeof data === "string"
              ? data.length
              : data instanceof Blob
                ? data.size
                : (data as ArrayBuffer).byteLength ?? 0;
          w.__wsUp.bytes += n;
          w.__wsUp.frames += 1;
          return origSend.call(this, data);
        };
      },
      { basKbps: BAS_KBPS, audioOnly: AUDIO_ONLY_OFFER },
    );

    await primeCandidateLogin(page);
    await page.goto(`${BASE}/interview`);
    await page.getByRole("button", { name: /开始面试|start interview/i }).click();
    await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
    await waitForInterviewStage(page);
    await enterVoiceChannel(page);

    // Wait for an avatar PC to reach `connected` (up to 60s — includes the Azure handshake).
    const connectDeadline = Date.now() + 60_000;
    let pcIndex = -1;
    while (Date.now() < connectDeadline && pcIndex < 0) {
      pcIndex = await page.evaluate(() => {
        const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs;
        return pcs.findIndex((pc) => pc.connectionState === "connected");
      });
      if (pcIndex < 0) await page.waitForTimeout(500);
    }
    const connectedAt = Math.round((Date.now() - t0) / 1000);
    if (pcIndex < 0) {
      const diag = await page.evaluate(() => {
        const w = window as unknown as {
          __pcs: RTCPeerConnection[];
          __sdp: { local?: string; remote?: string }[];
          __wsEvents: unknown[];
        };
        return {
          pcs: w.__pcs.map((pc) => ({ ice: pc.iceConnectionState, conn: pc.connectionState, sig: pc.signalingState })),
          sdps: w.__sdp.map((x) => ({
            localM: (x.local || "").split("\r\n").filter((l) => l.startsWith("m=")),
            remoteM: (x.remote || "").split("\r\n").filter((l) => l.startsWith("m=")),
            hasRemote: !!x.remote,
          })),
          wsEvents: w.__wsEvents,
        };
      });
      console.log("[probe] NOT CONNECTED — diagnostics:", JSON.stringify(diag));
      console.log("[probe] console lines:", JSON.stringify(consoleLines.slice(-25)));
    }
    expect(pcIndex, "an avatar RTCPeerConnection reached connected").toBeGreaterThanOrEqual(0);

    // Negotiation facts (once).
    const nego = await page.evaluate((i) => {
      const w = window as unknown as { __sdp: { local?: string; remote?: string }[] };
      const pick = (sdp: string | undefined, re: RegExp) =>
        (sdp || "")
          .split("\r\n")
          .filter((l) => re.test(l))
          .slice(0, 40);
      const remote = w.__sdp[i]?.remote;
      const local = w.__sdp[i]?.local;
      return {
        remoteRtcpFb: pick(remote, /^a=rtcp-fb:/),
        remoteBandwidth: pick(remote, /^b=/),
        remoteRtpmap: pick(remote, /^a=rtpmap:/),
        remoteFmtp: pick(remote, /^a=fmtp:/),
        remoteExtmap: pick(remote, /^a=extmap:/),
        localBandwidth: pick(local, /^b=/),
        localRtcpFb: pick(local, /^a=rtcp-fb:/),
        localMedia: pick(local, /^m=/),
        remoteMedia: pick(remote, /^m=/),
      };
    }, pcIndex);

    // Sample loop.
    const samples: Sample[] = [];
    let midSent = false;
    let midSentAtS = -1;
    let prev: {
      t: number;
      vBytes: number;
      aBytes: number;
      wsBytes: number;
      concealed: number;
      totalSamples: number;
      framesDecoded: number;
    } | null = null;
    const deadline = Date.now() + PROBE_MS;
    while (Date.now() < deadline) {
      const raw = await page.evaluate(async (i) => {
        const w = window as unknown as { __pcs: RTCPeerConnection[]; __wsUp: { bytes: number } };
        const pc = w.__pcs[i];
        const report = await pc.getStats();
        const stats: Record<string, unknown>[] = [];
        report.forEach((s) => stats.push(s as unknown as Record<string, unknown>));
        return {
          now: Date.now(),
          ice: pc.iceConnectionState,
          conn: pc.connectionState,
          wsBytes: w.__wsUp.bytes,
          stats,
        };
      }, pcIndex);

      const byId = new Map(raw.stats.map((s) => [s.id as string, s]));
      const inV = raw.stats.find((s) => s.type === "inbound-rtp" && s.kind === "video");
      const inA = raw.stats.find((s) => s.type === "inbound-rtp" && s.kind === "audio");
      const transport = raw.stats.find((s) => s.type === "transport");
      const pair =
        (transport && byId.get(transport.selectedCandidatePairId as string)) ||
        raw.stats.find((s) => s.type === "candidate-pair" && s.nominated === true && s.state === "succeeded");
      const num = (v: unknown) => (typeof v === "number" ? v : 0);
      const opt = (v: unknown) => (typeof v === "number" ? v : null);

      const vBytes = num(inV?.bytesReceived);
      const aBytes = num(inA?.bytesReceived);
      const t = Math.round((raw.now - t0) / 1000);
      const dt = prev ? (raw.now - (t0 + prev.t * 1000)) / 1000 : 0;
      const kbps = (cur: number, last: number) => (prev && dt > 0 ? Math.round(((cur - last) * 8) / dt / 1000) : 0);

      const framesDecoded = num(inV?.framesDecoded);
      const totalSamples = num(inA?.totalSamplesReceived);
      const concealed = num(inA?.concealedSamples);
      const dSamples = prev ? totalSamples - prev.totalSamples : 0;
      const concealRatio = dSamples > 0 ? (concealed - (prev?.concealed ?? 0)) / dSamples : null;
      const totalDecodeTime = num(inV?.totalDecodeTime);
      const jbDelay = num(inV?.jitterBufferDelay);
      const jbEmitted = num(inV?.jitterBufferEmittedCount);

      samples.push({
        t,
        video: inV
          ? {
              kbps: kbps(vBytes, prev?.vBytes ?? 0),
              fps: opt(inV.framesPerSecond),
              w: opt(inV.frameWidth),
              h: opt(inV.frameHeight),
              packetsLost: num(inV.packetsLost),
              framesDropped: num(inV.framesDropped),
              freezeCount: num(inV.freezeCount),
              freezeDurS: Math.round(num(inV.totalFreezesDuration) * 10) / 10,
              nack: num(inV.nackCount),
              pli: num(inV.pliCount),
              fir: num(inV.firCount),
              jbDelayMs: jbEmitted > 0 ? Math.round((jbDelay / jbEmitted) * 1000) : null,
              decodeMs: framesDecoded > 0 ? Math.round((totalDecodeTime / framesDecoded) * 1000 * 10) / 10 : null,
              framesDecoded,
              decoding: prev ? framesDecoded - prev.framesDecoded > 0 : false,
            }
          : null,
        audio: inA
          ? {
              kbps: kbps(aBytes, prev?.aBytes ?? 0),
              packetsLost: num(inA.packetsLost),
              concealed,
              totalSamples,
              concealRatio: concealRatio === null ? null : Math.round(concealRatio * 1000) / 1000,
              jitterMs: typeof inA.jitter === "number" ? Math.round(inA.jitter * 1000) : null,
            }
          : null,
        pair: pair
          ? {
              rttMs: typeof pair.currentRoundTripTime === "number" ? Math.round(pair.currentRoundTripTime * 1000) : null,
              bweKbps: typeof pair.availableIncomingBitrate === "number" ? Math.round(pair.availableIncomingBitrate / 1000) : null,
              local: String((byId.get(pair.localCandidateId as string) || {}).candidateType ?? "?"),
              remote: String((byId.get(pair.remoteCandidateId as string) || {}).candidateType ?? "?"),
              state: String(pair.state),
            }
          : null,
        wsUpKbps: kbps(raw.wsBytes, prev?.wsBytes ?? 0),
        ice: raw.ice,
        conn: raw.conn,
      });
      prev = { t, vBytes, aBytes, wsBytes: raw.wsBytes, concealed, totalSamples, framesDecoded };

      if (MID_BITRATE > 0 && !midSent && t - connectedAt >= MID_AT_S) {
        midSent = true;
        midSentAtS = t;
        const sent = await page.evaluate(
          ({ bitrate, mode }) => {
            const ww = window as unknown as { __wss: WebSocket[]; __lastSession?: Record<string, unknown> };
            const ws = [...ww.__wss].reverse().find((w) => w.readyState === WebSocket.OPEN && /voice-live/.test(w.url));
            if (!ws) return { ok: false, why: "no open voice-live WS" };
            let avatar: Record<string, unknown>;
            if (mode === "partial") {
              avatar = { video: { bitrate } };
            } else {
              const cur = (ww.__lastSession?.avatar as Record<string, unknown> | undefined) ?? {};
              const rest = { ...cur };
              // ice_servers dropped deliberately: Azure re-issues them, and they carry TURN credentials
              // we must not echo back or log. Deleted rather than destructured-and-ignored so the
              // intent is the statement itself, not an unused binding.
              delete rest.ice_servers;
              const video = { ...((rest.video as Record<string, unknown>) ?? {}), bitrate };
              avatar = { ...rest, video };
            }
            const payload = { type: "session.update", session: { avatar } };
            ws.send(JSON.stringify(payload));
            return { ok: true, payload };
          },
          { bitrate: MID_BITRATE, mode: MID_MODE },
        );
        console.log(`[probe] mid-session session.update sent at t=${t}s:`, JSON.stringify(sent));
      }
      await page.waitForTimeout(1000);
    }
    const wsEvents = await page.evaluate(() => (window as unknown as { __wsEvents: unknown[] }).__wsEvents);

    // Aggregate.
    const body = samples.slice(1); // first sample has no delta
    const vk = body.map((s) => s.video?.kbps ?? 0);
    const ak = body.map((s) => s.audio?.kbps ?? 0);
    const up = body.map((s) => s.wsUpKbps);
    const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
    const max = (xs: number[]) => (xs.length ? Math.max(...xs) : 0);
    const min = (xs: number[]) => (xs.length ? Math.min(...xs) : 0);
    const last = samples[samples.length - 1];
    const first = samples[0];
    const summary = {
      profile: PROFILE,
      basKbps: BAS_KBPS || null,
      connectedAtS: connectedAt,
      windowS: Math.round(PROBE_MS / 1000),
      video: {
        kbpsAvg: avg(vk),
        kbpsMin: min(vk),
        kbpsMax: max(vk),
        fpsAvg: avg(body.map((s) => s.video?.fps ?? 0)),
        frame: last?.video ? `${last.video.w}x${last.video.h}` : "?",
        packetsLost: (last?.video?.packetsLost ?? 0) - (first?.video?.packetsLost ?? 0),
        framesDropped: (last?.video?.framesDropped ?? 0) - (first?.video?.framesDropped ?? 0),
        freezeCount: (last?.video?.freezeCount ?? 0) - (first?.video?.freezeCount ?? 0),
        freezeDurS: Math.round(((last?.video?.freezeDurS ?? 0) - (first?.video?.freezeDurS ?? 0)) * 10) / 10,
        nack: (last?.video?.nack ?? 0) - (first?.video?.nack ?? 0),
        pli: (last?.video?.pli ?? 0) - (first?.video?.pli ?? 0),
        jbDelayMsLast: last?.video?.jbDelayMs ?? null,
      },
      /** Windows where video bytes arrived but nothing decoded — the shipped policy's threshold-free
       * downgrade trigger. Non-zero here means the picture was pure waste. */
      wastedWindows: body.filter((s) => (s.video?.kbps ?? 0) > 0 && s.video?.decoding === false).length,
      concealRatioAvg:
        Math.round(
          (body.map((s) => s.audio?.concealRatio).filter((r): r is number => r !== null).reduce((a, b) => a + b, 0) /
            Math.max(1, body.filter((s) => s.audio?.concealRatio !== null).length)) * 1000,
        ) / 1000,
      concealRatioMax:
        Math.round(
          Math.max(0, ...body.map((s) => s.audio?.concealRatio ?? 0)) * 1000,
        ) / 1000,
      audio: {
        kbpsAvg: avg(ak),
        packetsLost: (last?.audio?.packetsLost ?? 0) - (first?.audio?.packetsLost ?? 0),
        concealedSamples: (last?.audio?.concealed ?? 0) - (first?.audio?.concealed ?? 0),
        jitterMsLast: last?.audio?.jitterMs ?? null,
      },
      pair: {
        rttMsAvg: avg(body.map((s) => s.pair?.rttMs ?? 0).filter((x) => x > 0)),
        bweKbpsAvg: avg(body.map((s) => s.pair?.bweKbps ?? 0).filter((x) => x > 0)),
        bweKbpsMin: min(body.map((s) => s.pair?.bweKbps ?? 0).filter((x) => x > 0)),
        path: last?.pair ? `${last.pair.local}->${last.pair.remote}` : "?",
      },
      wsUpKbpsAvg: avg(up),
      iceStates: Array.from(new Set(samples.map((s) => s.ice))),
      midUpdate:
        MID_BITRATE > 0
          ? {
              bitrate: MID_BITRATE,
              mode: MID_MODE,
              sentAtS: midSentAtS,
              videoKbpsBefore: avg(body.filter((s) => s.t <= midSentAtS).map((s) => s.video?.kbps ?? 0)),
              videoKbpsAfter5s: avg(body.filter((s) => s.t > midSentAtS + 5).map((s) => s.video?.kbps ?? 0)),
              frameAfter: last?.video ? `${last.video.w}x${last.video.h}` : "?",
            }
          : null,
    };

    mkdirSync(join(HERE, "output"), { recursive: true });
    const outPath = join(HERE, "output", `weaknet-${PROFILE}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(outPath, JSON.stringify({ summary, negotiation: nego, wsEvents, samples, consoleLines }, null, 2));

    console.log(`\n========== AVATAR WEAK-NET PROBE  profile=${PROFILE}  window=${summary.windowS}s ==========`);
    console.log("negotiation (remote SDP):");
    console.log("  rtcp-fb :", nego.remoteRtcpFb.join(" | ") || "(none)");
    console.log("  b=      :", nego.remoteBandwidth.join(" | ") || "(none)");
    console.log("  rtpmap  :", nego.remoteRtpmap.join(" | "));
    console.log("  extmap  :", nego.remoteExtmap.join(" | ") || "(none)");
    console.log("  local m=:", nego.localMedia.join(" | "));
    console.log("  remote m=:", nego.remoteMedia.join(" | "));
    if (BAS_KBPS) console.log("  local b=:", nego.localBandwidth.join(" | ") || "(none)");
    console.log("summary:", JSON.stringify(summary, null, 2));
    console.log("WS server events (session.*/error):", JSON.stringify(wsEvents));
    console.log("per-second (t, videoKbps, fps, WxH, lost, freezes/durS, nack, pli, audioKbps, concealed, rtt, bwe, wsUpKbps, ice):");
    for (const s of samples) {
      console.log(
        `  t=${String(s.t).padStart(3)}s v=${String(s.video?.kbps ?? 0).padStart(5)}k fps=${String(s.video?.fps ?? "-").padStart(2)} ` +
          `${s.video?.w ?? "?"}x${s.video?.h ?? "?"} lost=${s.video?.packetsLost ?? 0} frz=${s.video?.freezeCount ?? 0}/${s.video?.freezeDurS ?? 0}s ` +
          `nack=${s.video?.nack ?? 0} pli=${s.video?.pli ?? 0} dec=${s.video?.decoding ? "y" : "n"} ` +
          `a=${String(s.audio?.kbps ?? 0).padStart(3)}k cr=${s.audio?.concealRatio ?? "-"} ` +
          `rtt=${s.pair?.rttMs ?? "-"}ms bwe=${s.pair?.bweKbps ?? "-"}k up=${String(s.wsUpKbps).padStart(4)}k ice=${s.ice}`,
      );
    }
    console.log(`written: ${outPath}`);
    console.log("=====================================================================================\n");

    expect(samples.length).toBeGreaterThan(5);
  });
});
