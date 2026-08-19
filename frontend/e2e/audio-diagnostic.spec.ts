/**
 * LIVE audio diagnostic (opt-in, real Azure — NOT part of CI).
 *
 * Targets the "数字人不说话" symptom: avatar VIDEO renders but no speech is heard.
 * Captures (a) whether `response.audio.delta` / `response.audio_transcript.delta` frames arrive
 * over the WS proxy, (b) the hidden avatar <audio> element's play state, and (c) the actual
 * RTP audio energy on the avatar WebRTC audio receiver (getStats audioLevel / totalAudioEnergy),
 * plus the playback AudioContext state.
 *
 * Run: LIVE_VOICE=1 npx playwright test audio-diagnostic --config=e2e/live.config.ts
 */
import { test, expect } from "@playwright/test";

const LIVE = process.env.LIVE_VOICE === "1";
const BASE = process.env.BASE || "http://localhost:5173";

test.describe("Audio diagnostic (real Azure)", () => {
  test.skip(!LIVE, "opt-in: set LIVE_VOICE=1");

  test("capture the assistant audio pipeline", async ({ page }) => {
    const frameCounts: Record<string, number> = {};
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error" || /\[voice|\[avatar/.test(msg.text())) {
        errors.push(`[${msg.type()}] ${msg.text()}`);
      }
    });
    page.on("websocket", (ws) => {
      if (!/voice-live\/ws/.test(ws.url())) return;
      ws.on("framereceived", (f) => {
        const data = typeof f.payload === "string" ? f.payload : "";
        if (!data) return;
        try {
          const msg = JSON.parse(data) as { type?: string };
          if (msg.type) frameCounts[msg.type] = (frameCounts[msg.type] ?? 0) + 1;
        } catch {
          /* non-JSON */
        }
      });
    });

    // Keep a handle on every live RTCPeerConnection so we can getStats() later.
    await page.addInitScript(() => {
      const w = window as unknown as { __pcs: RTCPeerConnection[] };
      w.__pcs = [];
      const OrigPC = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends OrigPC {
        constructor(...args: unknown[]) {
          // @ts-expect-error passthrough
          super(...args);
          w.__pcs.push(this);
        }
      } as unknown as typeof RTCPeerConnection;
    });

    await page.goto(`${BASE}/interview`);
    await page.getByRole("button", { name: /开始面试|start interview/i }).click();
    await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
    await expect(page.getByRole("textbox")).toBeVisible();
    await page.getByRole("button", { name: /语音作答|answer by voice/i }).click();

    // Wait for the agent to produce its first spoken turn (transcript deltas streaming).
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !frameCounts["response.audio_transcript.delta"]) {
      await page.waitForTimeout(1000);
    }
    // Let the speech run for a bit so audio energy accumulates.
    await page.waitForTimeout(10_000);

    const audioState = await page.evaluate(async () => {
      const w = window as unknown as { __pcs: RTCPeerConnection[] };
      const pcs = w.__pcs ?? [];
      const receivers: Array<Record<string, unknown>> = [];
      for (const pc of pcs) {
        for (const r of pc.getReceivers()) {
          if (r.track?.kind !== "audio") continue;
          const stats = await r.getStats();
          const entry: Record<string, unknown> = {
            trackReadyState: r.track.readyState,
            trackMuted: r.track.muted,
            trackEnabled: r.track.enabled,
            pcConnectionState: pc.connectionState,
          };
          stats.forEach((s) => {
            if (s.type === "inbound-rtp" && (s as { kind?: string }).kind === "audio") {
              const st = s as unknown as Record<string, unknown>;
              entry.packetsReceived = st.packetsReceived;
              entry.bytesReceived = st.bytesReceived;
              entry.audioLevel = st.audioLevel;
              entry.totalAudioEnergy = st.totalAudioEnergy;
              entry.totalSamplesReceived = st.totalSamplesReceived;
            }
          });
          receivers.push(entry);
        }
      }
      const audioEls = Array.from(document.querySelectorAll("audio")).map((a) => ({
        paused: a.paused,
        muted: a.muted,
        volume: a.volume,
        readyState: a.readyState,
        hasSrcObject: !!a.srcObject,
        currentTime: a.currentTime,
      }));
      return { receivers, audioEls, pcCount: pcs.length };
    });

    console.log("\n========== AUDIO DIAGNOSTIC ==========");
    console.log("WS frame counts:", JSON.stringify(frameCounts, null, 2));
    console.log("Avatar audio receivers:", JSON.stringify(audioState.receivers, null, 2));
    console.log("Hidden <audio> elements:", JSON.stringify(audioState.audioEls, null, 2));
    console.log("PC count:", audioState.pcCount);
    console.log("console lines:");
    errors.forEach((l) => console.log("   ", l));
    console.log("=======================================\n");

    expect(true).toBe(true);
  });
});
