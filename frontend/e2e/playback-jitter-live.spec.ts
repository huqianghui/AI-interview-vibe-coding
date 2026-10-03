/**
 * The playback jitter buffer on the path that actually uses it (perf review P0-2).
 *
 * REQUIRES AN AVATAR-LESS PERSONA. With a digital human the interviewer's audio rides the avatar's
 * WebRTC track and `response.audio.delta` never fires, so this code path is not exercised at all —
 * which is why the buffer went unmeasured for so long. The spec detects that and skips rather than
 * passing vacuously.
 *
 * What it reports, and why each number is here:
 *
 *   - UNDERRUNS, from the worklet's own counter via the page's console. The only reason the counter
 *     can be trusted is the end-of-stream marker (`response.audio.done`): without it a finished
 *     sentence drains the queue exactly like a stalled network and every utterance logs a gap.
 *   - AZURE'S DELTA PACING: each delta's arrival interval against the audio it carries. This is the
 *     measurement that sized the buffer, and it overturned the assumption behind P0-2. The gaps on
 *     this path are not network jitter — Azure's own first delta carries ~200 ms and the next
 *     arrives ~250 ms later, so the risk is concentrated in the first second of each response. One
 *     run also saw Azure go quiet for 1441 ms mid-response, which no conversational buffer absorbs.
 *
 * Run: LIVE_VOICE=1 FAKE_AUDIO=/abs/path/answer.wav \
 *        npx playwright test playback-jitter-live --config=e2e/live.config.ts
 */
import { expect, test } from "@playwright/test";
import {
  enterVoiceChannel,
  primeCandidateLogin,
  waitForInterviewStage,
} from "./helpers/candidateLogin";

const LIVE = process.env.LIVE_VOICE === "1";
/** How long to listen. One response is enough to see the pacing; the default covers a few turns. */
const WINDOW_S = Number(process.env.PLAYBACK_WINDOW_S || 60);
/** Azure sends 24 kHz PCM16, so base64 length → milliseconds of audio. */
const msOfAudio = (b64: string) => ((b64.length * 3) / 4 / 2 / 24_000) * 1000;

test.describe("Playback jitter buffer (real Azure, WS PCM path)", () => {
  test.skip(!LIVE, "opt-in: set LIVE_VOICE=1");
  test.setTimeout(180_000);

  test("plays the interviewer through the buffer and reports gaps", async ({ page }) => {
    await primeCandidateLogin(page);

    const logs: string[] = [];
    page.on("console", (m) => {
      const t = m.text();
      if (/voice-audio|playback/.test(t)) logs.push(t);
    });

    let avatarEnabled: boolean | null = null;
    const deltas: { gapMs: number; audioMs: number }[] = [];
    let dones = 0;
    let last = 0;
    page.on("websocket", (ws) => {
      if (!/voice-live\/ws/.test(ws.url())) return;
      ws.on("framereceived", (f) => {
        if (typeof f.payload !== "string") return;
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(f.payload) as Record<string, unknown>;
        } catch {
          return;
        }
        if (m.type === "proxy.connected") avatarEnabled = Boolean(m.avatar_enabled);
        if (m.type === "response.audio.delta") {
          const now = Date.now();
          deltas.push({
            gapMs: last ? now - last : 0,
            audioMs: Math.round(msOfAudio((m.delta as string) ?? "")),
          });
          last = now;
        }
        if (m.type === "response.audio.done") dones++;
      });
    });

    await page.goto("/interview", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /开始面试|start interview/i }).click();
    await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
    await waitForInterviewStage(page);
    await enterVoiceChannel(page);
    await page.waitForTimeout(WINDOW_S * 1000);

    test.skip(
      avatarEnabled === true,
      "this persona has a digital human, so audio rides WebRTC and the WS PCM path never runs — " +
        "set the persona's character to empty to measure the buffer",
    );

    const underrunLogs = logs.filter((l) => /underrun/.test(l));
    const totalAudioMs = deltas.reduce((n, d) => n + d.audioMs, 0);
    console.log(`\n===== playback jitter buffer =====`);
    console.log(`  response.audio.delta   ${deltas.length} (${(totalAudioMs / 1000).toFixed(1)}s of audio)`);
    console.log(`  response.audio.done    ${dones}`);
    console.log(`  underruns              ${underrunLogs.length}`);
    console.log(`  Azure delta pacing (arrival interval vs audio carried, ms):`);
    let margin = 0;
    for (const d of deltas) {
      margin += d.audioMs - d.gapMs;
      console.log(
        `    gap ${String(d.gapMs).padStart(5)}   audio ${String(d.audioMs).padStart(4)}` +
          `   cushion ${String(Math.round(margin)).padStart(6)}`,
      );
    }
    for (const l of logs) console.log(`    ${l}`);

    // The path ran at all, and the marker that makes the counter meaningful arrived.
    expect(deltas.length, "no audio deltas — is this persona avatar-less?").toBeGreaterThan(0);
    expect(dones, "response.audio.done never arrived; the underrun counter cannot be trusted")
      .toBeGreaterThan(0);
    // Playback actually started rather than sitting in `filling` forever.
    expect(logs.some((l) => /playback started/.test(l)), "playback never started").toBe(true);
    // Deliberately NOT asserting zero underruns: measured, Azure itself can go quiet for over a
    // second mid-response, and failing the build for the service's pacing would be a flaky test
    // rather than a useful one. The number is reported so a regression is visible.
  });
});
