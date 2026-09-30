/**
 * LIVE verification of the weak-network media degrade (opt-in, real Azure — NOT CI).
 *
 * The automatic downgrade needs a shaped network (sudo — `frontend/e2e/scripts/weaknet-phase2.sh`), but
 * the MECHANISM it relies on is fully testable on a good link by driving the manual override.
 *
 * Note the shape this had to take. Azure honours `session.avatar.connect` exactly ONCE per Voice Live
 * session and has no disconnect/renegotiate event: re-offering on a live session is refused with
 * `error: "WebRTC connection is in connected state"` (measured 2026-09-30, which is how this spec found
 * it). So switching the picture rebuilds the whole session — that is what makes this worth a live test.
 *
 * What this pins down, all of it measured behaviour that unit tests can only mock:
 *   1. Azure accepts an audio-only session (video m-line `a=inactive`) on a fresh connect. Deleting the
 *      m-line instead is rejected — see `docs/avatar-weaknet-probe.md` §3.6.
 *   2. The video stream really stops (no bytes) while the interviewer's audio keeps flowing.
 *   3. The page tells the truth: `data-media-mode="audio-only"` plus the voice-only notice.
 *   4. The first-question read is NOT held for the full 6 s gate in audio-only mode (no frame ever
 *      paints, so the old frame-only gate sat out the whole timeout in silence).
 *   5. Turning the picture back on rebuilds again and video bytes resume.
 *
 * Run: LIVE_VOICE=1 npx playwright test avatar-audio-only-live --config=e2e/live.config.ts
 */
import { expect, test } from "@playwright/test";
import { enterVoiceChannel, primeCandidateLogin, waitForInterviewStage } from "./helpers/candidateLogin";

const LIVE = process.env.LIVE_VOICE === "1";
const BASE = process.env.BASE || "http://localhost:5173";

/** Sum inbound-rtp bytes for one kind across every RTCPeerConnection the page has open. */
async function inboundBytes(page: import("@playwright/test").Page, kind: "video" | "audio") {
  return page.evaluate(async (k) => {
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs ?? [];
    let total = 0;
    for (const pc of pcs) {
      if (pc.connectionState !== "connected") continue;
      const report = await pc.getStats();
      report.forEach((s) => {
        const row = s as unknown as Record<string, unknown>;
        if (row.type === "inbound-rtp" && row.kind === k && typeof row.bytesReceived === "number") {
          total += row.bytesReceived;
        }
      });
    }
    return total;
  }, kind);
}

test.describe("Avatar audio-only degrade (real Azure)", () => {
  test.skip(!LIVE, "opt-in: set LIVE_VOICE=1");
  test.setTimeout(300_000);

  test("dropping the picture keeps the voice, and the picture comes back after the cooldown", async ({ page }) => {
    const logs: string[] = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (text.includes("[voice]") || text.includes("[avatar-stream]")) logs.push(text);
    });

    // Collect every PeerConnection so the test can read its stats.
    await page.addInitScript(() => {
      const w = window as unknown as { __pcs: RTCPeerConnection[] };
      w.__pcs = [];
      const Orig = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Orig {
        constructor(...args: unknown[]) {
          // @ts-expect-error passthrough
          super(...args);
          w.__pcs.push(this);
        }
      } as unknown as typeof RTCPeerConnection;
    });

    await primeCandidateLogin(page);
    await page.goto(`${BASE}/interview`);
    await page.getByRole("button", { name: /开始面试|start interview/i }).click();
    await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
    await waitForInterviewStage(page);
    await enterVoiceChannel(page);

    // --- 1. the picture comes up normally -----------------------------------------------------
    const view = page.locator('[data-testid="avatar-view"]');
    await expect(view).toHaveAttribute("data-media-mode", "video");
    await expect(view).toHaveAttribute("data-avatar-connected", "true", { timeout: 60_000 });
    const videoBefore = await inboundBytes(page, "video");
    expect(videoBefore, "video bytes are flowing before the degrade").toBeGreaterThan(0);

    // --- 2. drop the picture on purpose -------------------------------------------------------
    const toggle = page.getByTestId("voice-video-toggle");
    await toggle.click();

    await expect(view).toHaveAttribute("data-media-mode", "audio-only", { timeout: 30_000 });
    await expect(page.getByTestId("avatar-voice-only-hint")).toBeVisible();
    // The orb is the honest visual once nothing paints.
    await expect(view).toHaveAttribute("data-avatar-connected", "false");

    // The session is rebuilt, so wait for the new audio-only media to actually come up before judging
    // it. Only PeerConnections still in `connected` are counted, so the torn-down one drops out.
    await expect
      .poll(async () => await inboundBytes(page, "audio"), { timeout: 60_000, intervals: [1_000] })
      .toBeGreaterThan(0);

    const audioMid = await inboundBytes(page, "audio");
    const videoMid = await inboundBytes(page, "video");
    await page.waitForTimeout(8_000);
    const audioAfter = await inboundBytes(page, "audio");
    const videoAfter = await inboundBytes(page, "video");

    expect(audioAfter, "the interviewer's voice still streams with the picture off").toBeGreaterThan(
      audioMid,
    );
    // Azure answered the inactive video m-line, so no video should arrive at all on this session.
    expect(videoAfter, "no video bytes on an audio-only session").toBe(0);
    expect(videoMid).toBe(0);

    // --- 3. the read gate was not held for its full timeout ----------------------------------
    expect(
      logs.some((l) => l.includes("avatar-ready gate elapsed")),
      `the first read must not sit out the 6s gate in audio-only mode. logs:\n${logs.join("\n")}`,
    ).toBe(false);

    // --- 4. take the picture back ------------------------------------------------------------
    // Every switch creates a new avatar session and Azure rate-limits those (it refused a third inside
    // ~20 s with "Retry after 43.0s"), so the control is disabled until the cooldown passes. Waiting for
    // it to re-enable is part of what this spec verifies.
    await expect(toggle).toBeDisabled();
    await expect(toggle).toBeEnabled({ timeout: 90_000 });
    await toggle.click();
    await expect(view).toHaveAttribute("data-media-mode", "video", { timeout: 30_000 });
    await expect(view).toHaveAttribute("data-avatar-connected", "true", { timeout: 90_000 });
    const videoRestored = await inboundBytes(page, "video");
    expect(videoRestored, "video resumed after turning the picture back on").toBeGreaterThan(0);

    console.log("\n===== audio-only degrade, live =====");
    console.log(`video bytes: before=${videoBefore} atSwitch=${videoMid} after8s=${videoAfter} restored=${videoRestored}`);
    console.log(`audio bytes: atSwitch=${audioMid} after8s=${audioAfter}`);
    console.log("===================================\n");
  });
});
