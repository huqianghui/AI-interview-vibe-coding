/**
 * Opt-in LIVE Playwright config — drives the REAL running dev servers against real Azure.
 *
 * Unlike the default playwright.config.ts (mock-only, boots its own servers), this config assumes
 * the real frontend (:5173) + backend (:8000, real Foundry credentials) are already running, and
 * launches Chromium with fake-media flags so getUserMedia succeeds without a physical microphone.
 * Only the voice-live-azure spec (self-skips unless LIVE_VOICE=1) is collected here.
 *
 * Run: LIVE_VOICE=1 npx playwright test --config=e2e/live.config.ts
 */
import { defineConfig, devices } from "@playwright/test";

const BASE = process.env.BASE || "http://localhost:5173";

export default defineConfig({
  testDir: ".",
  testMatch: /voice-live-azure\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: BASE,
    trace: "retain-on-failure",
    permissions: ["microphone"],
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // No webServer: this config reuses the already-running real servers.
});
