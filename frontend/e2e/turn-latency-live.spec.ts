/**
 * Per-turn speak-start latency: turn 1, 2 and 3, not just the first one.
 *
 * Series 03 §6 reported "多轮无退化" from a WS-level probe on a direct, avatar-less session. This measures
 * the product's own path turn by turn, in the browser, with audibility as the end point — so it answers
 * what the candidate experiences on their second and third answer, not only their first.
 *
 * Two configurations, selected by MODE (the runner script flips the persona's avatar column between them):
 *   MODE=avatar  the default product path — avatar over WebRTC
 *   MODE=audio   no avatar at all, so the reply audio comes back as PCM over the WebSocket. There is no
 *                ICE, no avatar session creation, and no rate limit. This is "audio from the start",
 *                which is NOT the same thing as the audio-only DOWNGRADE (that one keeps the WebRTC
 *                connection and only marks the video m-line inactive).
 *
 * Needs a looping FAKE_AUDIO WAV so every turn has an answer to submit.
 *
 * STATE: MODE=avatar is trustworthy (turn 1 / 2 / 3 measured at 6487 / 970 / 1067 ms on amira, no
 * degradation across turns). MODE=audio is NOT yet trustworthy: it reported "NOT HEARD" on all three
 * turns while a separate check proved the session was healthy — 10 `response.audio.delta` frames, an
 * `response.audio.done`, and no console errors. Without an avatar the reply audio arrives as PCM on the
 * WebSocket and is played through WebAudio, where `getStats()` has nothing to report, and the
 * AudioNode.prototype.connect tap below does not reliably catch that graph. Fix the tap before reading
 * any MODE=audio number: as it stands the probe cannot tell silence from its own blindness.
 *
 * Worth knowing before extending this: for a pure-audio session the native WebRTC interface is available
 * (Voice Live offers SDK / WebSocket / WebRTC / SIP). The standing decision to keep the uplink on the
 * WebSocket is conditioned on wanting the avatar, which the WebRTC mode does not support — so it does not
 * apply to an audio-only mode. Per series 01 §4.5.2 the payoff there is weak-network behaviour, not
 * average latency: no TCP head-of-line blocking, loss degrading to brief distortion instead of a latency
 * spike. That path is not implemented here, and "no avatar over WebSocket PCM" is not a stand-in for it.
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
    const level = async (): Promise<number> =>
      page.evaluate(async () => {
        const w = window as unknown as {
          __pcs: RTCPeerConnection[];
          __probeAnalyser?: { node: AnalyserNode; buf: Uint8Array };
        };
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
        const a = w.__probeAnalyser;
        if (a) {
          a.node.getByteTimeDomainData(a.buf);
          let peak = 0;
          for (const v of a.buf) peak = Math.max(peak, Math.abs(v - 128) / 128);
          best = Math.max(best, peak);
        }
        return best;
      });

    // Tap every AudioContext's destination so the WS/PCM playback path is observable too.
    await page.addInitScript(() => {
      const w = window as unknown as { __probeAnalyser?: { node: AnalyserNode; buf: Uint8Array } };
      const Orig = window.AudioContext;
      window.AudioContext = class extends Orig {
        constructor(...a: unknown[]) {
          // @ts-expect-error passthrough
          super(...a);
          try {
            const node = this.createAnalyser();
            node.fftSize = 512;
            node.connect(this.destination);
            const origConnect = AudioNode.prototype.connect;
            const dest = this.destination;
            // Mirror anything connected to the destination into the analyser.
            AudioNode.prototype.connect = function (this: AudioNode, target: AudioNode | AudioParam, ...rest: unknown[]) {
              if (target === dest) {
                try {
                  origConnect.call(this, node);
                } catch {
                  /* some nodes refuse a second connection; the WebRTC path still covers those */
                }
              }
              // @ts-expect-error passthrough
              return origConnect.call(this, target, ...rest);
            } as typeof AudioNode.prototype.connect;
            w.__probeAnalyser = { node, buf: new Uint8Array(node.frequencyBinCount) };
          } catch {
            /* no analyser: the WebRTC path above still answers for MODE=avatar */
          }
        }
      } as unknown as typeof AudioContext;
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

    // Turn 1: the cold start — click to hearing the first question.
    const firstVoice = await waitForVoice(120_000);
    results.push({ turn: 1, from: '"I\'m ready" click', ms: firstVoice === null ? null : firstVoice - t0 });
    await waitForQuiet(60_000);

    const doneBtn = page.getByRole("button", { name: /我说完了|i'm done answering/i });
    for (let turn = 2; turn <= TURNS; turn++) {
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
    results.forEach((r) =>
      console.log(`  turn ${r.turn}: ${r.from} → voice audible   ${r.ms === null ? "NOT HEARD" : `${r.ms}ms`}`),
    );
    if (errors.length) console.log(`  errors: ${errors.length} → ${errors[0]}`);
    console.log("==========================================\n");

    results.forEach((r) => expect(r.ms, `turn ${r.turn} never became audible`).not.toBeNull());
  });
});
