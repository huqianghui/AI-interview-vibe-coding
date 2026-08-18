/**
 * TEMP LIVE avatar STABILITY probe (opt-in, real Azure — NOT CI, delete after diagnosis).
 *
 * The one-shot avatar-diagnostic proves INITIAL connect works. This probe instead watches a LIVE
 * session over a long window to catch the reported instability: does the avatar PC self-drop
 * (iceConnectionState disconnected/failed, track ended, isConnected flip to false → orb), and does
 * it EVER recover? Samples once/sec for ~150s and dumps a timeline of every state transition.
 *
 * Run: LIVE_VOICE=1 npx playwright test avatar-stability-probe --config=e2e/live.config.ts
 */
import { test, expect } from "@playwright/test";

const LIVE = process.env.LIVE_VOICE === "1";
const BASE = process.env.BASE || "http://localhost:5173";
const PROBE_MS = Number(process.env.PROBE_MS || 150_000);

test.describe("Avatar stability probe (real Azure)", () => {
  test.skip(!LIVE, "opt-in: set LIVE_VOICE=1");
  test.setTimeout(PROBE_MS + 60_000);

  test("watch a live avatar session for self-drops and recovery", async ({ page }) => {
    const voiceLines: { t: number; line: string }[] = [];
    const start = Date.now();
    page.on("console", (msg) => {
      const txt = msg.text();
      if (txt.includes("[voice]") || txt.includes("[avatar-stream]"))
        voiceLines.push({ t: Math.round((Date.now() - start) / 1000), line: txt });
    });
    page.on("pageerror", (err) =>
      voiceLines.push({ t: Math.round((Date.now() - start) / 1000), line: `[pageerror] ${err.message}` }),
    );

    // Instrument the avatar PC to record ICE/connection transitions + track-ended with timestamps.
    await page.addInitScript(() => {
      const w = window as unknown as { __evt: { t: number; e: string }[]; __t0: number };
      w.__t0 = Date.now();
      w.__evt = [];
      const push = (e: string) => w.__evt.push({ t: Math.round((Date.now() - w.__t0) / 1000), e });
      const OrigPC = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends OrigPC {
        constructor(...args: unknown[]) {
          // @ts-expect-error passthrough
          super(...args);
          this.addEventListener("iceconnectionstatechange", () => push(`ice=${this.iceConnectionState}`));
          this.addEventListener("connectionstatechange", () => push(`conn=${this.connectionState}`));
          this.addEventListener("track", (e: RTCTrackEvent) => {
            push(`track+ ${e.track.kind}`);
            e.track.addEventListener("ended", () => push(`track-ended ${e.track.kind}`));
            e.track.addEventListener("mute", () => push(`track-mute ${e.track.kind}`));
            e.track.addEventListener("unmute", () => push(`track-unmute ${e.track.kind}`));
          });
        }
      } as unknown as typeof RTCPeerConnection;
    });

    await page.goto(`${BASE}/interview`);
    await page.getByRole("button", { name: /开始面试|start interview/i }).click();
    await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
    await expect(page.getByRole("textbox")).toBeVisible();
    await page.getByRole("button", { name: /语音作答|answer by voice/i }).click();

    // Sample the live <video> + orb + avatar-connected flag once per second.
    const samples: string[] = [];
    let prev = "";
    const deadline = Date.now() + PROBE_MS;
    while (Date.now() < deadline) {
      const s = await page.evaluate(() => {
        const v = document.querySelector<HTMLVideoElement>('[data-testid="avatar-video"]');
        const view = document.querySelector('[data-testid="avatar-view"]');
        return {
          w: v?.videoWidth ?? -1,
          h: v?.videoHeight ?? -1,
          rs: v?.readyState ?? -1,
          paused: v?.paused ?? null,
          conn: view?.getAttribute("data-avatar-connected") ?? "?",
          orb: !!document.querySelector('[data-testid="audio-orb"]'),
        };
      });
      const sig = `${s.w}x${s.h} rs=${s.rs} paused=${s.paused} avatarConnected=${s.conn} orb=${s.orb}`;
      if (sig !== prev) {
        const secs = Math.round((Date.now() - start) / 1000);
        samples.push(`  t=${secs}s  ${sig}`);
        prev = sig;
      }
      await page.waitForTimeout(1000);
    }

    const pcEvents = await page.evaluate(() => (window as unknown as { __evt: unknown[] }).__evt);

    console.log("\n========== AVATAR STABILITY PROBE (" + Math.round(PROBE_MS / 1000) + "s) ==========");
    console.log("VIDEO/ORB state changes (only transitions shown):");
    samples.forEach((s) => console.log(s));
    console.log("\nPC event timeline (ice/conn/track):");
    console.log(JSON.stringify(pcEvents, null, 2));
    console.log("\n[voice]/[avatar-stream] timeline:");
    voiceLines.forEach((l) => console.log(`  t=${l.t}s  ${l.line}`));
    console.log("=========================================================\n");

    expect(true).toBe(true);
  });
});
