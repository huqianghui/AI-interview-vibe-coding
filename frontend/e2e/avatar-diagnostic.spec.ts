/**
 * LIVE avatar diagnostic (opt-in, real Azure — NOT part of CI).
 *
 * Drives the real /interview voice path with a fake mic and captures everything needed to locate
 * WHY the digital human doesn't render: every [voice] console line, the signaling WebSocket frame
 * types (did Azure send an SDP answer? a call error?), whether a video track arrived on the
 * RTCPeerConnection, and the live <video> element's videoWidth/Height + isAvatarConnected over time.
 *
 * Run: LIVE_VOICE=1 npx playwright test avatar-diagnostic --config=e2e/live.config.ts
 */
import { test, expect } from "@playwright/test";

const LIVE = process.env.LIVE_VOICE === "1";
const BASE = process.env.BASE || "http://localhost:5173";

test.describe("Avatar diagnostic (real Azure)", () => {
  test.skip(!LIVE, "opt-in: set LIVE_VOICE=1");

  test("capture the full voice → avatar pipeline", async ({ page }) => {
    const consoleLines: string[] = [];
    const voiceLines: string[] = [];
    page.on("console", (msg) => {
      const text = `[${msg.type()}] ${msg.text()}`;
      consoleLines.push(text);
      if (msg.text().includes("[voice]") || msg.text().includes("[avatar-stream]"))
        voiceLines.push(msg.text());
    });
    page.on("pageerror", (err) => consoleLines.push(`[pageerror] ${err.message}`));

    const wsFrames: string[] = [];
    const sessionPayloads: Record<string, unknown> = {};
    const sdpFlags = { answered: false, callError: null as string | null };
    const wsSent: string[] = [];
    page.on("websocket", (ws) => {
      // Match BOTH transports: old direct /calls and the new backend proxy /voice-live/ws.
      if (!/voice-live/.test(ws.url())) return;
      ws.on("framesent", (f) => {
        const d = typeof f.payload === "string" ? f.payload : "";
        try {
          const m = JSON.parse(d) as { type?: string };
          if (m.type) wsSent.push(m.type);
        } catch {
          /* binary audio frame */
        }
      });
      ws.on("framereceived", (f) => {
        const data = typeof f.payload === "string" ? f.payload : "";
        if (!data) return;
        try {
          const msg = JSON.parse(data) as {
            type?: string;
            error?: { message?: string };
            session?: unknown;
          };
          if (msg.type) {
            wsFrames.push(msg.type);
            // WS-proxy avatar handshake success signal: server sends session.avatar.connecting
            // (carries server_sdp). Old /calls signal was rtc.call.sdp.created.
            if (msg.type === "rtc.call.sdp.created" || msg.type === "session.avatar.connecting")
              sdpFlags.answered = true;
            if (msg.type === "rtc.call.error" || msg.type === "error")
              sdpFlags.callError = msg.error?.message ?? msg.type;
            // Capture session.* payloads so we can SEE whether Azure returns avatar.ice_servers.
            if (msg.type.startsWith("session.") || msg.type.includes("avatar")) {
              sessionPayloads[msg.type] = msg.session ?? msg;
            }
          }
        } catch {
          /* non-JSON */
        }
      });
    });

    // Instrument RTCPeerConnection to see whether the NATIVE createOffer/setLocalDescription resolve
    // (bisecting the "hangs at createOffer()" symptom) + what tracks arrive.
    await page.addInitScript(() => {
      const w = window as unknown as { __trackLog: string[]; __pc: string[] };
      w.__trackLog = [];
      w.__pc = [];
      const OrigPC = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends OrigPC {
        constructor(...args: unknown[]) {
          // @ts-expect-error passthrough
          super(...args);
          w.__pc.push(
            `ctor iceServers=${JSON.stringify((args[0] as RTCConfiguration)?.iceServers ?? null)}`,
          );
          this.addEventListener("icegatheringstatechange", () =>
            w.__pc.push(`iceGatheringState=${this.iceGatheringState}`),
          );
          this.addEventListener("track", (e: RTCTrackEvent) => {
            w.__trackLog.push(
              `track kind=${e.track.kind} id=${e.track.id} streams=${e.streams.length}`,
            );
          });
        }
        async createOffer(...a: unknown[]) {
          w.__pc.push("native createOffer() called");
          try {
            // @ts-expect-error passthrough
            const o = await super.createOffer(...a);
            w.__pc.push("native createOffer() RESOLVED");
            return o;
          } catch (e) {
            w.__pc.push(`native createOffer() REJECTED: ${String(e)}`);
            throw e;
          }
        }
        async setLocalDescription(...a: unknown[]) {
          w.__pc.push("native setLocalDescription() called");
          try {
            // @ts-expect-error passthrough
            const r = await super.setLocalDescription(...a);
            w.__pc.push("native setLocalDescription() RESOLVED");
            return r;
          } catch (e) {
            w.__pc.push(`native setLocalDescription() REJECTED: ${String(e)}`);
            throw e;
          }
        }
      } as unknown as typeof RTCPeerConnection;
    });

    await page.goto(`${BASE}/interview`);
    await page.getByRole("button", { name: /开始面试|start interview/i }).click();
    await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
    await expect(page.getByRole("textbox")).toBeVisible();
    await page.getByRole("button", { name: /语音作答|answer by voice/i }).click();

    // Capture-only: wait up to 45s for a handshake signal, but DON'T fail if it never comes —
    // we want the diagnostic dump (frames seen, video state) regardless so we can see WHY.
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && !sdpFlags.answered && !sdpFlags.callError) {
      await page.waitForTimeout(1000);
    }

    // Give the avatar video track time to arrive + produce frames.
    await page.waitForTimeout(12_000);

    // Read the live <video> element state.
    const videoState = await page.evaluate(() => {
      const v = document.querySelector<HTMLVideoElement>('[data-testid="avatar-video"]');
      const view = document.querySelector('[data-testid="avatar-view"]');
      const w = window as unknown as { __trackLog?: string[] };
      return {
        videoFound: !!v,
        videoWidth: v?.videoWidth ?? -1,
        videoHeight: v?.videoHeight ?? -1,
        readyState: v?.readyState ?? -1,
        paused: v?.paused ?? null,
        muted: v?.muted ?? null,
        hasSrcObject: !!v?.srcObject,
        avatarConnected: view?.getAttribute("data-avatar-connected") ?? "?",
        orbPresent: !!document.querySelector('[data-testid="audio-orb"]'),
        trackLog: w.__trackLog ?? [],
      };
    });

    // Emit everything to the test output.
    console.log("\n========== AVATAR DIAGNOSTIC ==========");
    console.log("SDP answered:", sdpFlags.answered, "| call error:", sdpFlags.callError);
    console.log("WS frames RECEIVED:", JSON.stringify([...new Set(wsFrames)]));
    console.log("WS frames SENT (client→server):", JSON.stringify([...new Set(wsSent)]));
    console.log("session.* payloads (look for avatar.ice_servers + avatar.video):");
    console.log(JSON.stringify(sessionPayloads, null, 2).slice(0, 6000));
    const pcLog = await page.evaluate(() => (window as unknown as { __pc: string[] }).__pc);
    console.log("RTCPeerConnection native progression:", JSON.stringify(pcLog, null, 2));
    console.log("RTCPeerConnection tracks:", JSON.stringify(videoState.trackLog, null, 2));
    console.log("Video element:", JSON.stringify(videoState, null, 2));
    console.log("[voice] console lines:");
    voiceLines.forEach((l) => console.log("   ", l));
    console.log("Any page errors:");
    consoleLines.filter((l) => l.includes("pageerror") || l.includes("[error]")).forEach((l) => console.log("   ", l));
    console.log("========================================\n");

    // This test always "passes" — it's a diagnostic capture, not an assertion gate.
    expect(sdpFlags.answered || sdpFlags.callError).toBeTruthy();
  });
});
