/**
 * LIVE anon-token self-heal check (opt-in). Simulates a stale cached anon token (the "Invalid
 * anonymous token" 401) and confirms 开始面试 recovers by minting a fresh session instead of
 * dead-ending. Run: LIVE_VOICE=1 npx playwright test anon-recovery --config=e2e/live.config.ts
 */
import { test, expect } from "@playwright/test";

const LIVE = process.env.LIVE_VOICE === "1";
const BASE = process.env.BASE || "http://localhost:5173";

test.describe("Anon token self-heal (real backend)", () => {
  test.skip(!LIVE, "opt-in: set LIVE_VOICE=1");

  test("a stale anon token recovers on 开始面试 instead of 401", async ({ page }) => {
    // Seed a garbage token that will fail JWT decode → backend 401 "Invalid anonymous token".
    await page.addInitScript(() => {
      localStorage.setItem("anon_session_token", "stale.invalid.token");
    });
    await page.goto(`${BASE}/interview`);
    await page.getByRole("button", { name: /开始面试|start interview/i }).click();

    // Must NOT surface the 401; must advance to orientation (I'm ready button appears).
    await expect(page.getByText(/Invalid anonymous token|401/i)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByRole("button", { name: /我准备好了|i'm ready/i })).toBeVisible({
      timeout: 15_000,
    });

    // The stale token was replaced with a fresh one.
    const token = await page.evaluate(() => localStorage.getItem("anon_session_token"));
    expect(token).not.toBe("stale.invalid.token");
    expect(token).toBeTruthy();
  });
});
