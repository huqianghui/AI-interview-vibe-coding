/**
 * Per-turn speak-start latency: turn 1, 2 and 3, not just the first one.
 *
 * Series 03 §6 reported "多轮无退化" from a WS-level probe on a direct, avatar-less session. This measures
 * the product's own path turn by turn, in the browser, ending at AUDIBILITY — so it answers what the
 * candidate experiences on their second and third answer, not only their first.
 *
 * Two configurations, both carrying the reply audio over WebRTC:
 *   MODE=avatar  the default path — avatar video + audio on one WebRTC connection
 *   MODE=audio   the audio-only downgrade — the SAME WebRTC connection with the video m-line marked
 *                a=inactive. Audio still rides an RTP track, so getStats() can see it directly.
 *
 * An earlier revision made MODE=audio mean "a persona with no avatar at all", where the reply comes back
 * as PCM on the WebSocket and plays through WebAudio. getStats() is blind there, and the probe reported
 * silence that a frame count disproved. That path is a real product fallback but it is NOT the WebRTC
 * audio-only mode, and conflating the two is what produced an unreadable measurement.
 *
 * Needs a looping FAKE_AUDIO WAV so every turn has an answer to submit.
 */
import { expect, test } from "@playwright/test";

import { enterVoiceChannel, primeCandidateLogin, waitForInterviewStage } from "./helpers/candidateLogin";

const LIVE = process.env.LIVE_VOICE === "1";
const BASE = process.env.BASE || "http://localhost:5173";
const MODE = process.env.MODE === "audio" ? "audio" : "avatar";
const TURNS = Number(process.env.TURNS ?? 3);

test.describe(`Per-turn speak-start, MODE=${MODE} (real Azure)`, () => {
  test.skip(!LIVE, "opt-in: set LIVE_VOICE=1");
  test.skip(!process.env.FAKE_AUDIO, "needs a looping FAKE_AUDIO WAV: every turn needs an answer");

  test(`times the voice starting on each of ${TURNS} turns`, async ({ page }) => {
    test.setTimeout(90_000 + TURNS * 150_000);

    let heard = "";
    let heardCount = 0;
    const errors: string[] = [];
    page.on("websocket", (ws) => {
      if (!/voice-live\/ws/.test(ws.url())) return;
      ws.on("framereceived", (f) => {
        const d = typeof f.payload === "string" ? f.payload : "";
        if (!d) return;
        try {
          const m = JSON.parse(d) as Record<string, unknown>;
          if (m.type === "conversation.item.input_audio_transcription.completed") {
            heard = String((m as { transcript?: string }).transcript ?? "");
            heardCount += 1;
          }
          if (m.type === "error") errors.push(d.slice(0, 200));
        } catch {
          /* binary */
        }
      });
    });

    await page.addInitScript(() => {
      const w = window as unknown as { __pcs: RTCPeerConnection[] };
      w.__pcs = [];
      const O = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends O {
        constructor(...a: unknown[]) {
          // @ts-expect-error passthrough
          super(...a);
          w.__pcs.push(this);
        }
      } as unknown as typeof RTCPeerConnection;
    });

    /** Audible level, whichever transport carries the reply.
     *
     *  With an avatar it is the WebRTC inbound audio track, read via getStats. Without one the audio
     *  arrives as PCM on the WebSocket and is played through WebAudio, where getStats knows nothing — so
     *  that path is measured from the page's own output analyser instead. Measuring only the WebRTC side
     *  would have reported "never audible" for MODE=audio and looked like a product failure. */
    /** Audible level on the inbound WebRTC audio track. Both modes keep that track, so this one reading
     *  serves both. The 0.05 floor is measured, not guessed: through the silence before a voice, level
     *  sits at 0.0000-0.0010; once speech starts it jumps to 0.09-0.47. */
    const level = async (): Promise<number> =>
      page.evaluate(async () => {
        const w = window as unknown as { __pcs: RTCPeerConnection[] };
        let best = 0;
        for (const pc of w.__pcs) {
          if (pc.connectionState !== "connected") continue;
          const r = await pc.getStats();
          r.forEach((st) => {
            const row = st as unknown as Record<string, unknown>;
            if (row.type === "inbound-rtp" && row.kind === "audio" && typeof row.audioLevel === "number") {
              best = Math.max(best, row.audioLevel as number);
            }
          });
        }
        return best;
      });

    const waitForVoice = async (budgetMs: number): Promise<number | null> => {
      const until = Date.now() + budgetMs;
      while (Date.now() < until) {
        if ((await level()) > 0.05) return Date.now();
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    };
    const waitForQuiet = async (budgetMs: number): Promise<void> => {
      const until = Date.now() + budgetMs;
      let quiet = 0;
      while (Date.now() < until && quiet < 6) {
        quiet = (await level()) <= 0.05 ? quiet + 1 : 0;
        await new Promise((r) => setTimeout(r, 100));
      }
    };

    await primeCandidateLogin(page);
    await page.goto(`${BASE}/interview`);
    await page.getByRole("button", { name: /开始面试|start interview/i }).click();

    const t0 = Date.now();
    await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
    await waitForInterviewStage(page);
    await enterVoiceChannel(page);

    const results: { turn: number; from: string; ms: number | null }[] = [];

    // The cold start is always a video session: the downgrade can only be requested once the avatar is up.
    // Reported separately for that reason, rather than being labelled a turn of whichever mode follows.
    const firstVoice = await waitForVoice(120_000);
    const coldStartMs = firstVoice === null ? null : firstVoice - t0;
    await waitForQuiet(60_000);

    if (MODE === "audio") {
      const view = page.locator('[data-testid="avatar-view"]');
      await expect(view).toHaveAttribute("data-avatar-connected", "true", { timeout: 90_000 });
      const tToggle = Date.now();
      await page.getByTestId("voice-video-toggle").click();
      await expect(view).toHaveAttribute("data-media-mode", "audio-only", { timeout: 60_000 });
      // Azure honours session.avatar.connect once per session, so dropping the picture rebuilds the whole
      // session. Wait for audio to flow on the NEW connection before timing anything on it.
      const samplesNow = async (): Promise<number> =>
        page.evaluate(async () => {
          const w = window as unknown as { __pcs: RTCPeerConnection[] };
          let n = 0;
          for (const pc of w.__pcs) {
            if (pc.connectionState !== "connected") continue;
            const r = await pc.getStats();
            r.forEach((st) => {
              const row = st as unknown as Record<string, unknown>;
              if (row.type === "inbound-rtp" && row.kind === "audio" && typeof row.totalSamplesReceived === "number") {
                n = Math.max(n, row.totalSamplesReceived as number);
              }
            });
          }
          return n;
        });
      const base = await samplesNow();
      await expect.poll(samplesNow, { timeout: 120_000, intervals: [250] }).toBeGreaterThan(base);
      console.log(`  [downgrade] picture dropped, audio back after ${Date.now() - tToggle}ms`);
      // Prove the claim: an audio-only session must carry zero video bytes.
      const videoBytes = await page.evaluate(async () => {
        const w = window as unknown as { __pcs: RTCPeerConnection[] };
        let n = 0;
        for (const pc of w.__pcs) {
          if (pc.connectionState !== "connected") continue;
          const r = await pc.getStats();
          r.forEach((st) => {
            const row = st as unknown as Record<string, unknown>;
            if (row.type === "inbound-rtp" && row.kind === "video" && typeof row.bytesReceived === "number") {
              n += row.bytesReceived as number;
            }
          });
        }
        return n;
      });
      console.log(`  [downgrade] video bytes on the rebuilt connection: ${videoBytes}`);
      expect(videoBytes, "an audio-only session must carry no video").toBe(0);
      await waitForQuiet(30_000);
    }

    const doneBtn = page.getByRole("button", { name: /我说完了|i'm done answering/i });
    for (let turn = 1; turn <= TURNS; turn++) {
      // Wait for THIS turn's answer: the counter must advance, not merely be non-zero from a prior turn.
      const seen = heardCount;
      await expect
        .poll(() => heardCount, { timeout: 150_000, intervals: [1000] })
        .toBeGreaterThan(seen);
      console.log(`  [turn ${turn}] answer heard: ${JSON.stringify(heard.slice(0, 60))}`);
      await expect(doneBtn).toBeEnabled({ timeout: 60_000 });
      const tSubmit = Date.now();
      await doneBtn.click();
      const v = await waitForVoice(120_000);
      results.push({ turn, from: "submit", ms: v === null ? null : v - tSubmit });
      await waitForQuiet(60_000);
    }

    console.log(`\n===== PER-TURN SPEAK-START, MODE=${MODE} =====`);
    console.log(`  cold start (always with video): click → voice audible   ${coldStartMs === null ? "NOT HEARD" : `${coldStartMs}ms`}`);
    results.forEach((r) =>
      console.log(`  turn ${r.turn}: ${r.from} → voice audible   ${r.ms === null ? "NOT HEARD" : `${r.ms}ms`}`),
    );
    if (errors.length) console.log(`  errors: ${errors.length} → ${errors[0]}`);
    console.log("==========================================\n");

    expect(coldStartMs, "the first question never became audible").not.toBeNull();
    results.forEach((r) => expect(r.ms, `turn ${r.turn} never became audible`).not.toBeNull());

    // Leave the way a candidate closing the tab does. Navigating fires `pagehide`, which
    // `page.close()` may skip, so this is what proves the voice socket's App Insights record and the
    // last WebRTC quality window survive the page going away (docs/voice-performance-telemetry.md).
    await page.goto("about:blank");
    await page.waitForTimeout(2_000);
  });
});
