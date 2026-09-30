/**
 * Mic-rate A/B: does capturing at 16 kHz instead of 24 kHz cost transcription accuracy?
 *
 * The uplink was cut from 24 kHz to 16 kHz to stop the mic stream starving our own signalling on narrow
 * office uplinks (`docs/avatar-weaknet-probe.md` §3.8 conclusion 5; the reasoning for Azure's 24 kHz
 * default is in `docs/voice-live-control-notes.md` §4). The theory says this is free — we run the
 * CASCADED path, whose recogniser is a 16 kHz pipeline that downsamples our 24 kHz anyway. This spec
 * measures it instead of trusting the theory.
 *
 * It feeds a known sentence through Chromium's fake mic, lets Azure transcribe it, and reports the
 * word-error rate against the reference text. Run it once per rate and compare (see the runner script
 * `frontend/e2e/scripts/mic-rate-ab.sh`, which flips both sides and restores them).
 *
 * The reference sentence is deliberately loaded with sibilants and consonant contrasts (s/sh/f/th) —
 * that is where the 8–12 kHz band 16 kHz discards would show up if it mattered at all.
 *
 * Run: LIVE_VOICE=1 FAKE_AUDIO=/abs/path/answer.wav npx playwright test mic-rate-transcript-ab --config=e2e/live.config.ts
 */
import { expect, test } from "@playwright/test";
import { appendFileSync } from "node:fs";
import { enterVoiceChannel, primeCandidateLogin, waitForInterviewStage } from "./helpers/candidateLogin";

const LIVE = process.env.LIVE_VOICE === "1";
const BASE = process.env.BASE || "http://localhost:5173";
/** Must match what the WAV actually says (see the runner script). */
const REFERENCE =
  process.env.AB_REFERENCE ??
  "She sells sixth-floor thermostats, and the finance staff should specify these first, with thorough research.";
/** Where to append the measured result so the runner can diff the two rates. */
const RESULT_FILE = process.env.AB_RESULT_FILE;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Levenshtein distance over words → word error rate against the reference. */
function wordErrorRate(reference: string, hypothesis: string): number {
  const r = words(reference);
  const h = words(hypothesis);
  if (r.length === 0) return h.length === 0 ? 0 : 1;
  const d: number[][] = Array.from({ length: r.length + 1 }, (_, i) =>
    Array.from({ length: h.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      const cost = r[i - 1] === h[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[r.length][h.length] / r.length;
}

test.describe("Mic sample-rate transcript A/B (real Azure)", () => {
  test.skip(!LIVE, "opt-in: set LIVE_VOICE=1");
  test.skip(!process.env.FAKE_AUDIO, "needs FAKE_AUDIO=<abs path to the reference wav>");
  test.setTimeout(240_000);

  test("transcribes the reference sentence", async ({ page }) => {
    // The page logs the effective rates; a mismatch between them would invalidate the whole run.
    const rateLogs: string[] = [];
    let userTranscript = "";
    page.on("console", (msg) => {
      const text = msg.text();
      if (text.includes("MIC RATE MISMATCH")) rateLogs.push(text);
    });

    // Read the candidate transcript straight off the WS frames, so this doesn't depend on any DOM shape.
    await page.addInitScript(() => {
      const w = window as unknown as {
        __userText: string;
        __diag: { micFrames: number; speechStarted: number; speechStopped: number; serverTypes: string[] };
      };
      w.__userText = "";
      // If the transcript never arrives, the first question is always "was the mic silent, or was
      // Azure?". Count both sides so the failure message answers it instead of guessing.
      w.__diag = { micFrames: 0, speechStarted: 0, speechStopped: 0, serverTypes: [] };
      const Orig = window.WebSocket;
      const Wrapped = function (this: WebSocket, url: string | URL, protocols?: string | string[]) {
        const ws = protocols === undefined ? new Orig(url) : new Orig(url, protocols);
        const origSend = ws.send.bind(ws);
        ws.send = (data: Parameters<WebSocket["send"]>[0]) => {
          if (typeof data === "string" && data.includes('"input_audio_buffer.append"')) w.__diag.micFrames += 1;
          origSend(data);
        };
        ws.addEventListener("message", (ev: MessageEvent) => {
          if (typeof ev.data !== "string") return;
          try {
            const msg = JSON.parse(ev.data) as { type?: string; transcript?: string; delta?: string };
            const type = msg.type ?? "";
            if (type === "input_audio_buffer.speech_started") w.__diag.speechStarted += 1;
            if (type === "input_audio_buffer.speech_stopped") w.__diag.speechStopped += 1;
            if (type.includes("transcription") && !w.__diag.serverTypes.includes(type)) {
              w.__diag.serverTypes.push(type);
            }
            if (msg.type === "conversation.item.input_audio_transcription.completed" && msg.transcript) {
              w.__userText += ` ${msg.transcript}`;
            }
          } catch {
            /* non-JSON frame */
          }
        });
        return ws;
      } as unknown as typeof WebSocket;
      Wrapped.prototype = Orig.prototype;
      // The app guards every send with `readyState === WebSocket.OPEN`; without these statics that
      // comparison is `1 === undefined`, so NOT ONE mic frame is ever sent and the transcript stays
      // empty (this spec's first run failed exactly that way).
      Object.defineProperty(Wrapped, "CONNECTING", { value: Orig.CONNECTING });
      Object.defineProperty(Wrapped, "OPEN", { value: Orig.OPEN });
      Object.defineProperty(Wrapped, "CLOSING", { value: Orig.CLOSING });
      Object.defineProperty(Wrapped, "CLOSED", { value: Orig.CLOSED });
      window.WebSocket = Wrapped;
    });

    await primeCandidateLogin(page);
    await page.goto(`${BASE}/interview`);
    await page.getByRole("button", { name: /开始面试|start interview/i }).click();
    await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
    await waitForInterviewStage(page);
    await enterVoiceChannel(page);

    // Wait for a WHOLE pass of the reference, not merely "some text": the fake mic starts at page load
    // while the session comes up seconds later, so the first pass is always half-eaten. The WAV must
    // therefore be `utterance + trailing silence, looped` — the silence lets Azure's VAD close each
    // pass (without it, nothing is ever finalised), and the repeat gives us one clean pass.
    const refWordCount = words(REFERENCE).length;
    try {
      await expect
        .poll(
          async () =>
            words(await page.evaluate(() => (window as unknown as { __userText: string }).__userText)).length,
          { timeout: 180_000, intervals: [2_000] },
        )
        .toBeGreaterThanOrEqual(refWordCount);
    } catch (err) {
      const diag = await page.evaluate(() => (window as unknown as { __diag: unknown }).__diag);
      throw new Error(
        `no candidate transcript arrived. Mic/Azure diagnostics: ${JSON.stringify(diag)}. ` +
          `micFrames=0 means the browser never streamed the fake WAV (check the file format and the ` +
          `--use-file-for-fake-audio-capture flag); micFrames>0 with speechStarted=0 means Azure's VAD ` +
          `never heard speech in it; speechStarted>0 with speechStopped=0 means the WAV is LOOPING, so ` +
          `the utterance never ends — append "%noloop" to the FAKE_AUDIO path. Original: ${String(err)}`,
      );
    }
    await page.waitForTimeout(6_000); // let the current utterance finish

    userTranscript = (
      await page.evaluate(() => (window as unknown as { __userText: string }).__userText)
    ).trim();

    expect(rateLogs, `mic rate drift detected: ${rateLogs.join(" | ")}`).toEqual([]);

    // Score the single best-matching window of reference length, so a stray extra word or a repeat
    // cannot inflate the error rate.
    const hyp = words(userTranscript);
    const refLen = refWordCount;
    let best = 1;
    for (let start = 0; start <= Math.max(0, hyp.length - refLen); start++) {
      best = Math.min(best, wordErrorRate(REFERENCE, hyp.slice(start, start + refLen).join(" ")));
    }
    if (hyp.length < refLen) best = wordErrorRate(REFERENCE, userTranscript);

    console.log("\n===== mic-rate transcript A/B =====");
    console.log(`reference : ${REFERENCE}`);
    console.log(`transcript: ${userTranscript}`);
    console.log(`word error rate: ${(best * 100).toFixed(1)}%`);
    console.log("===================================\n");

    if (RESULT_FILE) {
      appendFileSync(
        RESULT_FILE,
        `${process.env.AB_LABEL ?? "run"}\twer=${(best * 100).toFixed(1)}%\t${userTranscript}\n`,
      );
    }

    // Loose floor: this asserts "recognition basically worked", not a quality bar. The comparison
    // between the two rates is the actual result, and it lives in the runner's output.
    expect(best, `transcription failed outright: "${userTranscript}"`).toBeLessThan(0.6);
  });
});
