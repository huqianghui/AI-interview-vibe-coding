/**
 * LIVE verification that the weak-network degrade fires BY ITSELF (opt-in, real Azure — NOT CI).
 *
 * `avatar-audio-only-live.spec.ts` proves the mechanism by driving the manual toggle. This spec proves
 * the TRIGGER: on a genuinely degraded link, nobody touches anything and the app still drops the
 * picture to protect the interviewer's voice. It is the one seam the unit tests cannot cover — the
 * policy in `avatarHealth.ts` has 17 of its own tests, but only a real lossy link proves that the
 * numbers `getStats()` actually reports on this platform cross the thresholds the policy watches.
 *
 * Requires OS-level packet shaping, which requires sudo — run it through
 * `frontend/e2e/scripts/verify-auto-downgrade.sh`, which shapes, runs this, and always restores.
 *
 * What it asserts:
 *   1. The session comes up showing video (so there is something to lose).
 *   2. Within the policy's own window, `data-media-mode` flips to `audio-only` with NO interaction.
 *   3. The rebuilt session really is picture-less (no video bytes) and the voice is still flowing.
 *   4. The page says so: the voice-only notice is visible.
 *
 * Run: LIVE_VOICE=1 npx playwright test avatar-auto-downgrade-live --config=e2e/live.config.ts
 */
import { expect, test } from "@playwright/test";
import { enterVoiceChannel, primeCandidateLogin, waitForInterviewStage } from "./helpers/candidateLogin";
import { HEALTH_THRESHOLDS } from "../src/hooks/avatarHealth";

const LIVE = process.env.LIVE_VOICE === "1";
const BASE = process.env.BASE || "http://localhost:5173";
/** How long to wait for the policy to make up its mind. The downgrade needs BAD_WINDOWS consecutive
 * samples, then a full session rebuild, so allow generous slack over the theoretical minimum. */
const DOWNGRADE_BUDGET_MS = Number(
  process.env.DOWNGRADE_BUDGET_MS ?? HEALTH_THRESHOLDS.SAMPLE_INTERVAL_MS * HEALTH_THRESHOLDS.BAD_WINDOWS + 90_000,
);

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

test.describe("Weak-network automatic downgrade (real Azure, shaped link)", () => {
  test.skip(!LIVE, "opt-in: set LIVE_VOICE=1");
  test.setTimeout(DOWNGRADE_BUDGET_MS + 120_000);

  test("drops the picture on its own and keeps the voice", async ({ page }) => {
    const decisions: string[] = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (text.includes("media health poor") || text.includes("media mode →") || text.includes("rebuilding the session")) {
        decisions.push(text);
      }
    });

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

    const view = page.locator('[data-testid="avatar-view"]');

    // 1. There has to be a picture to lose. On a badly shaped link the avatar may never paint a frame
    //    at all — that is itself the failure this feature addresses, so accept either "video came up"
    //    or "video mode but never painted", and say which happened.
    await expect(view).toHaveAttribute("data-media-mode", "video");
    const paintedFirst = await view
      .getAttribute("data-avatar-connected")
      .then(async (v) =>
        v === "true"
          ? true
          : await view
              .waitFor({ state: "attached" })
              .then(async () => (await view.getAttribute("data-avatar-connected")) === "true")
              .catch(() => false),
      );

    // 2. The interesting assertion: nobody touches the UI, and the mode changes anyway.
    await expect(view).toHaveAttribute("data-media-mode", "audio-only", { timeout: DOWNGRADE_BUDGET_MS });
    expect(
      decisions.some((d) => d.includes("media health poor")),
      `the mode changed but no health decision was logged — did something else switch it?\n${decisions.join("\n")}`,
    ).toBe(true);

    // 3. The rebuilt session must actually be picture-less, with the voice still arriving.
    await expect
      .poll(async () => await inboundBytes(page, "audio"), { timeout: 90_000, intervals: [1_000] })
      .toBeGreaterThan(0);
    const audioMid = await inboundBytes(page, "audio");
    await page.waitForTimeout(8_000);
    const audioAfter = await inboundBytes(page, "audio");
    const videoAfter = await inboundBytes(page, "video");

    expect(audioAfter, "the interviewer's voice still streams after the automatic downgrade").toBeGreaterThan(
      audioMid,
    );
    expect(videoAfter, "the rebuilt session carries no video").toBe(0);

    // 4. And the page explains itself.
    await expect(page.getByTestId("avatar-voice-only-hint")).toBeVisible();

    console.log("\n===== automatic downgrade, shaped link =====");
    console.log(`video painted before the downgrade: ${paintedFirst}`);
    console.log(`audio bytes after the switch: ${audioMid} → ${audioAfter} over 8s`);
    console.log("decision log:");
    decisions.forEach((d) => console.log(`  ${d}`));
    console.log("===========================================\n");
  });
});
