/**
 * Opt-in LIVE Playwright config — drives the REAL running dev servers against real Azure.
 *
 * Unlike the default playwright.config.ts (mock-only, boots its own servers), this config assumes
 * the real frontend (:5173) + backend (:8000, real Foundry credentials) are already running, and
 * launches Chromium with fake-media flags so getUserMedia succeeds without a physical microphone.
 * Collects the live-gated specs (self-skip unless LIVE_VOICE=1) plus candidate-login (#102), which
 * runs in both configs so the login gate is verified against the real backend too.
 *
 * Run: LIVE_VOICE=1 npx playwright test --config=e2e/live.config.ts
 */
import { defineConfig, devices } from "@playwright/test";

const BASE = process.env.BASE || "http://localhost:5173";

export default defineConfig({
  testDir: ".",
  testMatch: /(candidate-login|voice-live-azure|avatar-diagnostic|avatar-stability-probe|avatar-weaknet-probe|avatar-audio-only-live|avatar-auto-downgrade-live|avatar-restore-live|avatar-speak-start-live|native-webrtc-voice-live|audio-only-webrtc-live|turn-latency-live|uplink-bytes-live|playback-jitter-live|mic-rate-transcript-ab|audio-diagnostic|audio-turn2-diagnostic|anon-recovery|readme-live-screenshots|external-interview-live|external-voice-live|bank-linear-restart-live|bank-judged-live)\.spec\.ts/,
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
        // When FAKE_AUDIO points at a WAV file, the fake mic plays it (spoken user answer for
        // full-turn diagnostics); otherwise Chromium's default beep tone is used.
        ...(process.env.FAKE_AUDIO ? [`--use-file-for-fake-audio-capture=${process.env.FAKE_AUDIO}`] : []),
        // STRICT_AUTOPLAY=1 drops the permissive flag to reproduce real-Chrome autoplay policy
        // (the hidden avatar <audio> element's play() can be rejected there).
        ...(process.env.STRICT_AUTOPLAY === "1" ? [] : ["--autoplay-policy=no-user-gesture-required"]),
        // CHROME_ARGS: extra Chromium flags for probes, e.g. the built-in WebRTC fake-network field trial
        // (avatar-weaknet-probe): --force-fieldtrials=WebRTC-FakeNetworkReceiveConfig/link_capacity_kbps:500/
        ...(process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(/\s+/).filter(Boolean) : []),
      ],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // No webServer: this config reuses the already-running real servers.
});
