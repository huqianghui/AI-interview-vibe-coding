import { test, expect, request as pwRequest } from "@playwright/test";
import { primeCandidateLogin } from "./helpers/candidateLogin";

/**
 * Opt-in LIVE external-brain interview E2E — drives the REAL running dev servers against the REAL
 * external interview server, using the endpoint + API key an admin has saved in the Connection tab
 * (nothing is hardcoded here; the spec consumes the stored config, which is exactly what it proves).
 *
 * Requires: both dev servers running (frontend :5173, backend :8000 with the real DB), a real
 * external endpoint + key saved via the admin UI, and env vars:
 *
 *   LIVE_EXTERNAL=1 LIVE_ADMIN_PW=<seed admin password> \
 *     npx playwright test --config=e2e/live.config.ts external-interview-live
 *
 * Flow: verifies the saved config health-probes OK through the running backend (the admin
 * "Test connection" path), points the default persona at the external brain (restored afterwards),
 * then runs a full candidate interview turn-by-turn in the browser until the external server
 * declares the session complete. Real turns take seconds each — budgets are sized for a
 * ~10-question interview.
 *
 * Asserts the same candidate-facing contract as the mock spec: no question count, completion
 * acknowledgement (not a local report — P12), and no rubric/score internals leaked (P3).
 */

const API_BASE = process.env.API_BASE || "http://localhost:8000";
const ADMIN_USER = process.env.LIVE_ADMIN_USER || "admin";
const ADMIN_PW = process.env.LIVE_ADMIN_PW || "";

const LIVE = process.env.LIVE_EXTERNAL === "1";

let previousDefaultId: string | null = null;
let testPersonaId: string | null = null;

test.skip(!LIVE, "live spec — set LIVE_EXTERNAL=1 (and LIVE_ADMIN_PW) to run");

async function adminApi() {
  const api = await pwRequest.newContext({ baseURL: API_BASE });
  const login = await api.post("/auth/login", {
    headers: { "Content-Type": "application/json" },
    data: { username: ADMIN_USER, password: ADMIN_PW },
  });
  expect(login.ok(), "admin login (check LIVE_ADMIN_PW)").toBeTruthy();
  const token = (await login.json()).access_token;
  return { api, auth: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } };
}

test.beforeAll(async () => {
  if (!LIVE) return;
  expect(ADMIN_PW, "LIVE_ADMIN_PW must be set").toBeTruthy();
  const { api, auth } = await adminApi();

  // The REAL saved connection must exist — this spec never writes endpoint/key (no secrets in the
  // repo); an admin saves them once in the Connection tab and this run proves that stored config
  // is what the backend uses.
  const cfg = await (await api.get("/admin/external-interviewer", { headers: auth })).json();
  expect(cfg.endpoint, "no external endpoint saved — configure the Connection tab first").toBeTruthy();

  // Health-probe through the RUNNING backend (same code path as the admin "Test connection"
  // button): proves endpoint + decrypted key + transport against the live server.
  const probe = await (
    await api.post("/admin/external-interviewer/test", { headers: auth })
  ).json();
  expect(probe.success, `live connection probe failed: ${probe.message}`).toBeTruthy();

  // Remember the current default persona, then author a text-channel external-brain persona so the
  // candidate answers by keyboard (deterministic without a mic). Restored in afterAll.
  const personas: Array<{ id: string; is_default: boolean }> = await (
    await api.get("/admin/personas", { headers: auth })
  ).json();
  previousDefaultId = personas.find((p) => p.is_default)?.id ?? null;

  const created = await (
    await api.post("/admin/personas", {
      headers: auth,
      data: {
        name: `E2E Live External ${Date.now()}`,
        interview_brain: "external",
        enabled: true,
        is_default: true,
      },
    })
  ).json();
  testPersonaId = created.id;
  await api.dispose();
});

test.afterAll(async () => {
  if (!LIVE || !ADMIN_PW) return;
  const { api, auth } = await adminApi();
  if (previousDefaultId) {
    await api.post(`/admin/personas/${previousDefaultId}/set-default`, { headers: auth });
  }
  if (testPersonaId) {
    await api.put(`/admin/personas/${testPersonaId}`, {
      headers: auth,
      data: { enabled: false },
    });
  }
  await api.dispose();
});

test("live external-brain interview runs to completion against the real server", async ({
  page,
}) => {
  // Real gateway round-trips are seconds each; a ~10-question interview needs a generous budget.
  test.setTimeout(600_000);

  await primeCandidateLogin(page); // #102: /interview is login-gated

  await page.goto("/interview");
  await page.getByRole("button", { name: /开始面试|start interview/i }).click();
  await expect(page.getByText(/开始之前|before we begin/i)).toBeVisible();
  await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();

  // External brain exposes no question count → progress header must stay hidden.
  await expect(page.getByTestId("question-progress")).toHaveCount(0);
  // First question comes from a live round-trip — allow it time to land.
  await expect(page.getByRole("textbox")).toBeVisible({ timeout: 60_000 });

  let answered = 0;
  for (let i = 0; i < 40; i++) {
    if (await page.getByTestId("external-complete").isVisible().catch(() => false)) break;
    const box = page.getByRole("textbox");
    if (!(await box.isVisible().catch(() => false))) {
      // Turn in flight (awaiting overlay) — poll until the next question or completion lands.
      await page.waitForTimeout(1_000);
      continue;
    }
    await box.fill(
      "We maintain a regional training matrix reviewed monthly, track completion in the LMS, " +
        "and escalate overdue items with a documented CAPA when gaps persist.",
    );
    await page.getByRole("button", { name: /提交回答|submit answer/i }).click();
    answered += 1;
    await page.waitForTimeout(500);
  }

  // Ends on the acknowledgement card; the external server decided completion, not a local count.
  await expect(page.getByTestId("external-complete")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/面试已结束|interview complete/i)).toBeVisible();
  expect(answered, "should have answered several real questions").toBeGreaterThanOrEqual(3);

  // P12: never a local report/score for an external session.
  await expect(page.getByTestId("report-exec")).toHaveCount(0);
  await expect(page.getByTestId("score-gauge")).toHaveCount(0);
  await expect(page.getByTestId("submit-and-evaluate")).toHaveCount(0);

  // P3: no rubric/scoring internals anywhere in the candidate page.
  const body = (await page.locator("body").textContent()) ?? "";
  for (const leaked of ["expected_points", "checklist", "rubric", "source_quote"]) {
    expect(body.toLowerCase()).not.toContain(leaked);
  }
});
