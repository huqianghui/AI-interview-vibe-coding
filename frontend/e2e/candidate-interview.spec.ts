import { test, expect, request as pwRequest } from "@playwright/test";
import { primeCandidateLogin } from "./helpers/candidateLogin";

/**
 * Candidate interview E2E (SPEC F6/F7/F8/F9) — real browser, real backend (mock providers).
 *
 * Drives the winning-demo path end to end: land → orientation → answer each question → scoring →
 * report. Also asserts the P3 boundary: the candidate never sees checklist/rubric/expected_points
 * anywhere.
 *
 * Owner rule (v0.39.2.0): a submit ALWAYS advances to the next question, in every turn mode. The
 * authored bank's only question still carries `max_follow_ups: 1` on purpose — that is exactly the
 * shape that used to hand the candidate a template follow-up quoting their own words ("You
 * mentioned …") instead of the next question. The test now proves the opposite: ONE submit reaches
 * the review/report, and no quoting follow-up is ever shown.
 *
 * Tests share one backend DB and run serially, so this file authors its OWN default bank via the
 * admin API before running — it never relies on whichever bank a sibling test left as default.
 */

test.beforeAll(async () => {
  // Author a fresh default bank of TWO questions. Q1 ALLOWS a follow-up (max_follow_ups: 1) — the
  // regression shape for v0.39.2.0: a linear submit must advance straight to Q2, never hand the
  // candidate a template follow-up. Q2 exists so the resume test below has a mid-flight interview
  // to come back to after its single answer.
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
    data: { text: "Describe your deployment safety habit.", order_index: 0, max_follow_ups: 1 },
  });
  await api.post(`/admin/question-banks/${bank.bank_id}/questions`, {
    headers: auth,
    data: { text: "How do you hand over an on-call shift?", order_index: 1, max_follow_ups: 0 },
  });
  await api.dispose();
});

/**
 * The seeded default persona has a configured voice, so the page opens in voice mode. In CI the
 * fake media device satisfies getUserMedia; on a dev machine without a mic (or with the OS denying
 * the headless browser) the "Microphone access needed" dialog appears instead and hides the answer
 * box. These are TEXT-channel tests, so take the dialog's own "Use text instead" exit when offered.
 */
async function continueByTextIfAsked(page: import("@playwright/test").Page) {
  const useText = page.getByRole("button", { name: /use text instead|改用文字/i });
  // The dialog arrives asynchronously (after getUserMedia rejects), so wait for whichever shows
  // first — the answer box (CI, fake device) or the dialog (no device) — instead of a fixed pause.
  await expect(page.getByRole("textbox").or(useText).first()).toBeVisible();
  if (await useText.isVisible().catch(() => false)) await useText.click();
}


test("candidate completes a text interview and reaches a report", async ({ page }) => {
  // Two answers are scored (per-answer LLM pass, mock in CI); same budget as admin-and-report.spec.
  test.setTimeout(180_000);
  await primeCandidateLogin(page); // #102: /interview is login-gated
  await page.goto("/interview");
  await page.getByRole("button", { name: /开始面试|start interview/i }).click();

  // Orientation beat, then into the interview.
  await expect(page.getByText(/开始之前|before we begin/i)).toBeVisible();
  await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();

  // Question + progress present.
  await expect(page.getByTestId("question-progress")).toBeVisible();
  await continueByTextIfAsked(page);
  await expect(page.getByRole("textbox")).toBeVisible();

  // Answer up to 20 turns until the report appears. Count real submits: two questions and no
  // follow-up at submit ⇒ exactly two answers reach review → report (Q1's follow-up slot is
  // never used by a submit).
  let sawFollowUpCitation = false;
  let submits = 0;
  const distinctive = "I always double-check the runbook before every deploy.";
  for (let i = 0; i < 20; i++) {
    const reportUp =
      (await page.getByTestId("report-exec").isVisible().catch(() => false)) ||
      (await page
        .getByText(/面试报告|interview report/i)
        .isVisible()
        .catch(() => false));
    if (reportUp) break;

    // After the last answer the interview enters the pre-scoring review screen (v0.30.0.0): the
    // report no longer auto-renders — the candidate must explicitly click 提交并评测 to start scoring.
    const submitEval = page.getByTestId("submit-and-evaluate");
    if (await submitEval.isVisible().catch(() => false)) {
      await submitEval.click();
      await page.waitForTimeout(250);
      continue;
    }

    const box = page.getByRole("textbox");
    if (!(await box.isVisible().catch(() => false))) break;

    await box.fill(distinctive);
    await page.getByRole("button", { name: /提交回答|submit answer/i }).click();
    submits += 1;
    await page.waitForTimeout(250);

    // If the current question quotes what we just said, the retired template follow-up fired.
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
  await expect(page.getByTestId("report-exec")).toBeVisible({ timeout: 60_000 });

  // v0.39.2.0: no template follow-up quoted the candidate, and the two questions needed exactly
  // two submits — Q1's follow-up slot never turned into an extra turn (a submit always advances).
  expect(sawFollowUpCitation).toBe(false);
  expect(submits).toBe(2);
});

test("candidate never sees rubric/checklist content (P3)", async ({ page }) => {
  await primeCandidateLogin(page); // #102: /interview is login-gated
  await page.goto("/interview");
  await page.getByRole("button", { name: /开始面试|start interview/i }).click();
  await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
  await continueByTextIfAsked(page);
  await expect(page.getByRole("textbox")).toBeVisible();

  const body = (await page.locator("body").textContent()) ?? "";
  for (const leaked of ["expected_points", "checklist", "rubric", "weight", "source_quote"]) {
    expect(body.toLowerCase()).not.toContain(leaked);
  }
});

test("candidate resumes an in-progress interview after a page reload (F6 edge b)", async ({
  page,
}) => {
  await primeCandidateLogin(page); // #102: /interview is login-gated
  await page.goto("/interview");
  await page.getByRole("button", { name: /开始面试|start interview/i }).click();
  await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
  await expect(page.getByTestId("question-progress")).toBeVisible();
  await continueByTextIfAsked(page);

  // Answer Q1 so the interview is genuinely mid-flight (on Q2), then reload the page.
  await page.getByRole("textbox").fill("My first answer, of ample length for scoring.");
  await page.getByRole("button", { name: /提交回答|submit answer/i }).click();
  await page.waitForTimeout(250);

  await page.reload();

  // Resumes straight into the interview (question + answer box), NOT back to the Start screen.
  await expect(page.getByTestId("question-progress")).toBeVisible();
  await expect(page.getByRole("textbox")).toBeVisible();
  await expect(page.getByRole("button", { name: /开始面试|start interview/i })).toHaveCount(0);
});
