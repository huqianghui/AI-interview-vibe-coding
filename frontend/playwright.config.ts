import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E config (SPEC — real-browser end-to-end).
 *
 * Two web servers are started for the run:
 * 1. Backend (uvicorn) on :8100 — a fresh in-file SQLite DB migrated to head, and mock
 *    providers so no Azure is touched.
 * 2. Frontend (vite dev) on :5273 — proxies `/api` to the backend on :8100 (via E2E_API_TARGET).
 *
 * Everything runs on mocks: the whole candidate + admin flow is exercisable with zero Azure.
 */
const BACKEND_PORT = 8100;
const FRONTEND_PORT = 5273;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  // CI-only retries: since 2026-09-10 runners intermittently hang one candidate-flow request
  // mid-journey (same code green minutes apart). A retry re-runs the test on the same, already
  // warm servers and — via `trace: "on-first-retry"` below — captures a full trace that the CI
  // workflow uploads on failure, so the next occurrence is diagnosable instead of a dead end.
  // Local runs keep 0 retries: a dev-machine hang should fail loudly, not be papered over.
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: "on-first-retry",
    // Bound every action and API request. The default is 0 — UNLIMITED — so a locator that matches
    // nothing waits for ever, and wrapping it in `.catch(() => "")`, a common best-effort idiom,
    // hides the hang completely: the test burns its whole budget on that line and then reports a
    // failure at some LATER assertion, on a page that renders correctly. That cost PR #154 three
    // consecutive 180 s timeouts, and the trace's 176-second gap was the only thing that located it
    // (`e2e/candidate-interview.spec.ts`, the follow-up-citation read).
    //
    // 30 s, not lower: this also applies to `apiRequestContext`, and the admin bank-seeding POST on
    // a cold backend measured over 6 s. The live-Azure specs are unaffected either way — they run on
    // `e2e/live.config.ts`, which carries its own `use` block.
    actionTimeout: 30_000,
    // Auto-grant mic permission so the voice path can be exercised without a real device prompt.
    permissions: ["microphone"],
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // Fresh DB + migrations, then boot the API on mock providers with a seeded admin user
      // (admin/e2e-admin-pw) — the admin E2E logs in via the real JWT login.
      // PY_BIN/ALEMBIC_BIN let CI use PATH tools (`python`/`alembic`); locally they default to the
      // backend virtualenv so `npm run e2e` works without activating it.
      command:
        "cd ../backend && rm -f e2e.db && " +
        // #102: SECRET_KEY is required at import time (Settings validation) — the migration step
        // needs it too, not just uvicorn, or a CI runner with no .env fails before the server starts.
        'DATABASE_URL=sqlite+aiosqlite:///./e2e.db SECRET_KEY=e2e-secret-key-do-not-use-in-prod ' +
        '"${ALEMBIC_BIN:-.venv/bin/alembic}" upgrade head && ' +
        "DATABASE_URL=sqlite+aiosqlite:///./e2e.db " +
        "SEED_ADMIN_USERNAME=admin SEED_ADMIN_PASSWORD=e2e-admin-pw " +
        // #102: SECRET_KEY is required (no code default); a fixed key keeps user1..3 stable.
        "SECRET_KEY=e2e-secret-key-do-not-use-in-prod " +
        "DEFAULT_LLM_PROVIDER=mock DEFAULT_RETRIEVAL_PROVIDER=mock DEFAULT_VOICE_PROVIDER=mock " +
        // Throwaway Fernet key so the external-config E2E can exercise the API-key
        // encryption path. Production supplies ENCRYPTION_KEY as a Container App
        // secret (main.bicep @secure param); the mock-provider CI harness has none,
        // and debug is off, so without this the encrypt-on-save would raise
        // EncryptionKeyMissing and the save would 500. Test-only value, never a real key.
        "ENCRYPTION_KEY=darq45pUcAWiIW1AAxBNoaeqR21cWgauYwJM5ecwBJI= " +
        `"\${PY_BIN:-.venv/bin/python}" -m uvicorn app.main:app --host 127.0.0.1 --port ${BACKEND_PORT}`,
      port: BACKEND_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
    },
    {
      command: `E2E_API_TARGET=http://127.0.0.1:${BACKEND_PORT} npm run dev -- --port ${FRONTEND_PORT} --strictPort`,
      port: FRONTEND_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
