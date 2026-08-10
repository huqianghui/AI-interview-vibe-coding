import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E config (SPEC — real-browser end-to-end).
 *
 * Two web servers are started for the run:
 * 1. Backend (uvicorn) on :8100 — a fresh in-file SQLite DB migrated to head, admin token set, and
 *    mock providers so no Azure is touched. `ADMIN_API_TOKEN` matches what the admin E2E logs in with.
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
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: "on-first-retry",
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
        'DATABASE_URL=sqlite+aiosqlite:///./e2e.db "${ALEMBIC_BIN:-.venv/bin/alembic}" upgrade head && ' +
        "DATABASE_URL=sqlite+aiosqlite:///./e2e.db " +
        "SEED_ADMIN_USERNAME=admin SEED_ADMIN_PASSWORD=e2e-admin-pw " +
        "DEFAULT_LLM_PROVIDER=mock DEFAULT_RETRIEVAL_PROVIDER=mock DEFAULT_VOICE_PROVIDER=mock " +
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
