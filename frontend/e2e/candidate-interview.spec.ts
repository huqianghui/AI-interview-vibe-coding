import { test, expect, request as pwRequest } from "@playwright/test";

/**
 * Candidate interview E2E (SPEC F6/F7/F8/F9) — real browser, real backend (mock providers).
 *
 * Drives the winning-demo path end to end: land → orientation → answer each question (incl. the
 * F7 memory follow-up that quotes the candidate's own words) → scoring → report. Also asserts the
 * P3 boundary: the candidate never sees checklist/rubric/expected_points anywhere.
 *
 * Tests share one backend DB and run serially, so this file authors its OWN default bank (with a
 * follow-up question) via the admin API before running — it never relies on whichever bank a
 * sibling test left as default.
 */

test.beforeAll(async () => {
  // Author a fresh default bank whose question carries a follow-up, so the F7 memory moment is
  // guaranteed to fire regardless of test order.
  const api = await pwRequest.newContext({ baseURL: "http://127.0.0.1:8100" });
  // Log in as the seeded admin to get a real JWT (admin routes are require_role("admin")).
  const token = (
    await (
      await api.post("/auth/login", {
        headers: { "Content-Type": "application/json" },
        data: { username: "admin", password: "e2e-admin-pw" },
      })
    ).json()
  ).access_token;
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const bank = await (
    await api.post("/admin/question-banks", {
      headers: auth,
      data: { name: `E2E Candidate Bank ${Date.now()}`, is_default: true },
    })
  ).json();
  await api.post(`/admin/question-banks/${bank.bank_id}/questions`, {
    headers: auth,
    data: { text: "Describe your deployment safety habit.", max_follow_ups: 1 },
  });
  await api.dispose();
});

test("candidate completes a text interview and reaches a report", async ({ page }) => {
  await page.goto("/interview");
  await page.getByRole("button", { name: /开始面试|start interview/i }).click();

  // Orientation beat, then into the interview.
  await expect(page.getByText(/开始之前|before we begin/i)).toBeVisible();
  await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();

  // Question + progress present.
  await expect(page.getByTestId("question-progress")).toBeVisible();
  await expect(page.getByRole("textbox")).toBeVisible();

  // Answer up to 20 turns until the report appears (follow-ups make the count > question count).
  let sawFollowUpCitation = false;
  const distinctive = "I always double-check the runbook before every deploy.";
  for (let i = 0; i < 20; i++) {
    const reportUp =
      (await page.getByTestId("report-exec").isVisible().catch(() => false)) ||
      (await page
        .getByText(/面试报告|interview report/i)
        .isVisible()
        .catch(() => false));
    if (reportUp) break;

    const box = page.getByRole("textbox");
    if (!(await box.isVisible().catch(() => false))) break;

    await box.fill(distinctive);
    await page.getByRole("button", { name: /提交回答|submit answer/i }).click();
    await page.waitForTimeout(250);

    // If the current question now quotes what we just said, the F7 memory moment fired.
    const pinned = (await page.locator('[role="heading"], .fui-Card').first().textContent()
      .catch(() => "")) ?? "";
    const bodyText = (await page.locator("body").textContent().catch(() => "")) ?? "";
    if (bodyText.includes("double-check the runbook") && /You mentioned|你刚才提到/.test(bodyText)) {
      sawFollowUpCitation = true;
    }
    void pinned;
  }

  // Report reveal. Assert on the single, deterministic executive-view container (the same marker the
  // loop breaks on) — the loose text regex matched the "report ready" banner AND both report titles,
  // a strict-mode double-match that raced on when the exec row mounted.
  await expect(page.getByTestId("report-exec")).toBeVisible();

  // F7: a follow-up cited the candidate's prior answer during the run.
  expect(sawFollowUpCitation).toBe(true);
});

test("candidate never sees rubric/checklist content (P3)", async ({ page }) => {
  await page.goto("/interview");
  await page.getByRole("button", { name: /开始面试|start interview/i }).click();
  await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
  await expect(page.getByRole("textbox")).toBeVisible();

  const body = (await page.locator("body").textContent()) ?? "";
  for (const leaked of ["expected_points", "checklist", "rubric", "weight", "source_quote"]) {
    expect(body.toLowerCase()).not.toContain(leaked);
  }
});

test("candidate resumes an in-progress interview after a page reload (F6 edge b)", async ({
  page,
}) => {
  await page.goto("/interview");
  await page.getByRole("button", { name: /开始面试|start interview/i }).click();
  await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
  await expect(page.getByTestId("question-progress")).toBeVisible();

  // Answer once so the interview is genuinely mid-flight, then reload the page.
  await page.getByRole("textbox").fill("My first answer, of ample length for scoring.");
  await page.getByRole("button", { name: /提交回答|submit answer/i }).click();
  await page.waitForTimeout(250);

  await page.reload();

  // Resumes straight into the interview (question + answer box), NOT back to the Start screen.
  await expect(page.getByTestId("question-progress")).toBeVisible();
  await expect(page.getByRole("textbox")).toBeVisible();
  await expect(page.getByRole("button", { name: /开始面试|start interview/i })).toHaveCount(0);
});
