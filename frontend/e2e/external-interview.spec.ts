import { test, expect, request as pwRequest } from "@playwright/test";

/**
 * External-brain candidate interview E2E (SPEC Phase 2, vendor-neutral).
 *
 * A persona whose interview brain is "external" hands every turn to the external interview server
 * instead of the built-in bank. With no endpoint configured the backend degrades to the in-process
 * mock provider (a deterministic 3-question interview), so this whole flow runs on zero network.
 *
 * Asserts the candidate-facing contract:
 *  - the interview runs turn-by-turn to completion (answer × 3 → done);
 *  - it ends on the acknowledgement card, NOT a local report — external sessions are scored by the
 *    organizer, never surfaced here (SPEC P12);
 *  - the "Question X of N" progress is hidden (the external brain exposes no count, total = 0);
 *  - no rubric/checklist/score leaks to the candidate (P3).
 *
 * beforeAll authors an external-brain default persona via the admin API and defensively clears any
 * external endpoint a sibling spec may have left, guaranteeing the mock provider drives the run.
 */

test.beforeAll(async () => {
  const api = await pwRequest.newContext({ baseURL: "http://127.0.0.1:8100" });
  const token = (
    await (
      await api.post("/auth/login", {
        headers: { "Content-Type": "application/json" },
        data: { username: "admin", password: "e2e-admin-pw" },
      })
    ).json()
  ).access_token;
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // Guarantee the mock provider: clear any saved external endpoint (empty api_key preserves the key;
  // only the endpoint decides http-vs-mock, and an empty endpoint → mock).
  await api.put("/admin/external-interviewer", {
    headers: auth,
    data: { endpoint: "", api_key: "", user_tag: "" },
  });

  // Author an external-brain persona and make it the default interviewer. character="" keeps it a
  // text (non-voice) persona so the candidate answers by keyboard.
  await api.post("/admin/personas", {
    headers: auth,
    data: {
      name: `E2E External Brain ${Date.now()}`,
      interview_brain: "external",
      enabled: true,
      is_default: true,
    },
  });
  await api.dispose();
});

test("external-brain interview runs to the completion acknowledgement (no local report — P12)", async ({
  page,
}) => {
  await page.goto("/interview");
  await page.getByRole("button", { name: /开始面试|start interview/i }).click();

  // Orientation beat, then into the interview (the mock provider produced the first question).
  await expect(page.getByText(/开始之前|before we begin/i)).toBeVisible();
  await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();

  // The external brain exposes no question count → the "Question X of N" progress is hidden.
  await expect(page.getByTestId("question-progress")).toHaveCount(0);
  await expect(page.getByRole("textbox")).toBeVisible();

  // Answer turn-by-turn until the completion acknowledgement appears. The mock runs 3 questions.
  for (let i = 0; i < 6; i++) {
    if (await page.getByTestId("external-complete").isVisible().catch(() => false)) break;
    const box = page.getByRole("textbox");
    if (!(await box.isVisible().catch(() => false))) {
      // Answer in flight (external-thinking overlay) — give the synchronous turn a beat to resolve.
      await page.waitForTimeout(200);
      continue;
    }
    await box.fill("I have several years of directly relevant hands-on experience.");
    await page.getByRole("button", { name: /提交回答|submit answer/i }).click();
    await page.waitForTimeout(200);
  }

  // Ends on the acknowledgement card with the vendor-neutral "organizer will follow up" copy.
  await expect(page.getByTestId("external-complete")).toBeVisible();
  await expect(
    page.getByText(/面试已结束|interview complete/i),
  ).toBeVisible();

  // P12: NO local report/score is ever shown for an external session.
  await expect(page.getByTestId("report-exec")).toHaveCount(0);
  await expect(page.getByTestId("score-gauge")).toHaveCount(0);
  await expect(page.getByTestId("submit-and-evaluate")).toHaveCount(0);

  // P3: no rubric/checklist/scoring internals leak to the candidate anywhere on the page.
  const body = (await page.locator("body").textContent()) ?? "";
  for (const leaked of ["expected_points", "checklist", "rubric", "source_quote"]) {
    expect(body.toLowerCase()).not.toContain(leaked);
  }
});
