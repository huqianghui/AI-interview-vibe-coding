/**
 * How much does the candidate's microphone actually cost on their uplink?
 *
 * The perf review's P0-1 was arithmetic: 256 kbps of audio, plus base64's +1/3, plus a JSON
 * envelope charged once per message, at one message per 8 ms AudioWorklet render quantum. This spec
 * is the measurement that replaced the arithmetic, and it is kept so the claim can be re-checked
 * rather than taken on trust.
 *
 * Measured (20 s window, same WAV, same persona, 16 kHz capture):
 *
 *   per-quantum base64 JSON (before)   125.0 msg/s   391 B/msg   391 kbps payload
 *   40 ms batches, base64 JSON          25.0 msg/s  1755 B/msg   351 kbps payload
 *   40 ms batches, binary               25.0 msg/s  1280 B/msg   256 kbps payload
 *
 * TWO NUMBERS, AND THEY MEAN DIFFERENT THINGS. `framesent` reports the APPLICATION payload, which
 * is what the page handed the socket. It is NOT what crosses the network: this connection
 * negotiates `permessage-deflate` (verified on the handshake — uvicorn answers with
 * `server_max_window_bits=12`), so the bytes on the wire are deflate's output. Base64 is highly
 * compressible, so deflate was already clawing back part of the +1/3 that the payload column shows.
 * Treat the payload column as "work handed to the transport" and read the wire column for
 * bandwidth.
 *
 * The message RATE in the first column is wire-real either way: a WebSocket frame is a frame, and
 * at 125/s each one costs a base64 encode, a JSON serialise, a send syscall and a deflate flush on
 * the thread that also renders React and decodes the avatar's video.
 *
 * Run: LIVE_VOICE=1 FAKE_AUDIO=/abs/path/answer.wav \
 *        npx playwright test uplink-bytes-live --config=e2e/live.config.ts
 */
import { expect, test } from "@playwright/test";
import {
  enterVoiceChannel,
  primeCandidateLogin,
  waitForInterviewStage,
} from "./helpers/candidateLogin";

const LIVE = process.env.LIVE_VOICE === "1";
/** Length of the steady-state window, after the uplink has actually started. */
const WINDOW_S = Number(process.env.UPLINK_WINDOW_S || 20);
/** Optional label for the console line, so two runs are distinguishable in a scrollback. */
const LABEL = process.env.UPLINK_LABEL || "current build";

/** 40 ms of 16 kHz mono PCM16 — the batch the worklet transfers. Used for the expected-size check. */
const BATCH_BYTES = 1280;

test.describe("Mic uplink byte rate (real Azure)", () => {
  test.skip(!LIVE, "opt-in: set LIVE_VOICE=1");
  test.setTimeout(180_000);

  test("reports messages/second and payload kbps for the mic uplink", async ({
    page,
  }) => {
    await primeCandidateLogin(page);

    let messages = 0;
    let bytes = 0;
    let binaryMessages = 0;
    page.on("websocket", (ws) => {
      if (!/voice-live\/ws/.test(ws.url())) return;
      ws.on("framesent", (frame) => {
        const isText = typeof frame.payload === "string";
        // Count ONLY mic audio. A handful of control frames (session.update, response.create) share
        // this socket and would otherwise inflate a per-message average by a few percent.
        if (isText && !frame.payload.includes("input_audio_buffer.append"))
          return;
        if (!isText) binaryMessages++;
        messages++;
        bytes += isText
          ? Buffer.byteLength(frame.payload, "utf8")
          : frame.payload.length;
      });
    });

    await page.goto("/interview", { waitUntil: "domcontentloaded" });
    // Same entry sequence as the other live specs: the landing screen, then the readiness gate,
    // both of which precede the interview stage the helper waits for.
    await page
      .getByRole("button", { name: /开始面试|start interview/i })
      .click();
    await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
    await waitForInterviewStage(page);
    await enterVoiceChannel(page);

    // Wait for the uplink to actually start (session handshake + mic init), then reset and measure
    // a clean steady-state window — the handshake would otherwise be averaged into the rate.
    await expect
      .poll(() => messages, {
        timeout: 90_000,
        message: "no mic frames went up",
      })
      .toBeGreaterThan(0);
    messages = 0;
    bytes = 0;
    binaryMessages = 0;
    const startedAt = Date.now();
    await page.waitForTimeout(WINDOW_S * 1000);
    const elapsedS = (Date.now() - startedAt) / 1000;

    const perSecond = messages / elapsedS;
    const kbps = (bytes * 8) / elapsedS / 1000;
    const avgBytes = bytes / Math.max(messages, 1);
    const mode =
      binaryMessages === messages
        ? "binary"
        : binaryMessages === 0
          ? "base64 JSON"
          : "MIXED";

    console.log(`\n===== mic uplink: ${LABEL} =====`);
    console.log(`  window          ${elapsedS.toFixed(1)} s`);
    console.log(`  framing         ${mode}`);
    console.log(`  messages        ${messages}  (${perSecond.toFixed(1)}/s)`);
    console.log(`  payload         ${bytes} B  (${kbps.toFixed(0)} kbps)`);
    console.log(`  avg message     ${avgBytes.toFixed(0)} B`);
    console.log(
      `  NOTE: payload, not wire — permessage-deflate is negotiated on this socket.\n`,
    );

    // Guard the framing rather than the absolute rate: the rate depends on how much of the window
    // the fake mic spent inside a turn, but 40 ms batching is a property of the build.
    expect(messages, "mic frames should still be flowing").toBeGreaterThan(0);
    expect(
      perSecond,
      "40 ms batching means ~25 msg/s, nowhere near the old 125",
    ).toBeLessThan(60);
    if (mode === "binary") {
      // Raw PCM16 frames carry the batch and nothing else — no base64, no envelope.
      expect(Math.abs(avgBytes - BATCH_BYTES)).toBeLessThan(64);
    }
  });
});
