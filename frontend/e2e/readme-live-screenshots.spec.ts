/**
 * README screenshot capture — LIVE Azure voice/avatar mode (opt-in, NOT CI).
 *
 * Complements readme-screenshots.spec.ts (mock stack): this one drives the REAL running dev
 * servers (frontend :5173 → backend :8000 with real Foundry credentials) into voice mode and
 * screenshots the digital-human avatar actually rendering (video frames, not the orb fallback).
 * PNGs land in docs/images/ next to the mock-stack captures.
 *
 * Run (real servers already up, persona synced):
 *   LIVE_VOICE=1 SCREENSHOTS=1 npx playwright test readme-live-screenshots --config=e2e/live.config.ts
 */
import { test, expect } from "@playwright/test";

const ENABLED = process.env.LIVE_VOICE === "1" && process.env.SCREENSHOTS === "1";
const BASE = process.env.BASE || "http://localhost:5173";
const OUT = "../docs/images";

test.describe("README live avatar screenshots (real Azure)", () => {
  test.skip(!ENABLED, "opt-in: set LIVE_VOICE=1 SCREENSHOTS=1 to capture against real Azure");

  test.use({ viewport: { width: 1440, height: 900 } });

  test("capture voice mode: digital-human avatar speaking", async ({ page }) => {
    await page.goto(`${BASE}/interview`);
    await page.getByRole("button", { name: /开始面试|start interview/i }).click();
    await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
    await expect(page.getByRole("textbox")).toBeVisible();

    await page.getByRole("button", { name: /语音作答|answer by voice/i }).click();

    // Wait for the avatar VIDEO to render real frames (not the orb): the recvonly PC attached a
    // stream and the element is actually decoding (videoWidth > 0 and time advances).
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const v = document.querySelector("video");
            return v ? v.videoWidth > 0 && v.currentTime > 0 : false;
          }),
        { timeout: 90_000, message: "avatar video never rendered frames" },
      )
      .toBe(true);

    // Give the interviewer a beat to start speaking the question (speaking state + transcript).
    await page
      .getByText(/Speaking|正在讲话/i)
      .first()
      .waitFor({ timeout: 30_000 })
      .catch(() => {});
    await page.waitForTimeout(2_000);

    await page.screenshot({ path: `${OUT}/09-live-avatar-voice.png` });

    // A second beat later the transcript panel usually has the spoken question text — a nicer shot.
    await page.waitForTimeout(6_000);
    await page.screenshot({ path: `${OUT}/10-live-avatar-transcript.png` });
  });
});
