import { test, expect } from "@playwright/test";

/**
 * Admin editor + scored report + voice-fallback E2E (SPEC F2b/F3b/F4/F8/F9).
 *
 * 1. Admin signs in, creates a bank (default), adds an SOP question, drafts its checklist.
 * 2. A candidate then interviews against that default bank and reaches a SCORED report (not stub):
 *    the executive view shows the grade gauge + narrative + the SOP-source-beside-answer evidence.
 * 3. The voice channel with no real mic surfaces the mic-permission dialog (F9 AC #4 fallback).
 */

// Seeded admin (playwright.config SEED_ADMIN_USERNAME/PASSWORD).
const ADMIN_USER = "admin";
const ADMIN_PW = "e2e-admin-pw";

test("admin authors a bank + checklist, candidate gets a scored report", async ({ page }) => {
  // --- Admin: sign in with the real login ---
  await page.goto("/admin");
  await page.getByTestId("admin-username-input").fill(ADMIN_USER);
  await page.getByTestId("admin-password-input").fill(ADMIN_PW);
  await page.getByTestId("admin-login").click();
  // Logged in → the admin editor's page heading renders. Admin copy is i18n-driven now (the header
  // language selector controls it), so match either locale's page title — the Content/Connection
  // tabs are role=tab, not heading, so this resolves to the single page-title h1.
  await expect(
    page.getByRole("heading", { name: /题库与评分标准|Question banks & rubrics/ }),
  ).toBeVisible();

  // --- Admin: create a default bank ---
  const bankName = `E2E SOP Bank ${Date.now()}`;
  await page.getByPlaceholder("New bank name").fill(bankName);
  await page.getByRole("button", { name: "Add bank" }).click();
  await expect(page.getByRole("button", { name: bankName })).toBeVisible();

  // Open the bank, add a question.
  await page.getByRole("button", { name: bankName }).click();
  await expect(page.getByText("Questions")).toBeVisible();
  await page.getByPlaceholder("New question text").fill("Walk me through your pre-deploy checks.");
  await page.getByRole("button", { name: "Add question" }).click();

  // Open the question's inline rubric editor and (re)draft its checklist from the question/SOP.
  // Design B auto-drafts a non-empty checklist at create time; "重新生成 / Generate" re-drafts it
  // via the mock LLM (weights re-normalized to 100).
  await page.getByRole("button", { name: /评分标准|Rubric/ }).click();
  await page.getByTestId("checklist-generate").click();
  await expect(page.getByText(/Weights total: 100/)).toBeVisible();

  // Make this the default bank so the candidate interview uses it.
  // (First bank auto-defaulted may be the boot-seeded one; explicitly set ours.)
  const makeDefault = page.getByRole("button", { name: "Make default" }).first();
  if (await makeDefault.isVisible().catch(() => false)) {
    await makeDefault.click();
  }

  // --- Candidate: interview against the authored bank, reach a SCORED report ---
  await page.goto("/interview");
  await page.getByRole("button", { name: /开始面试|start interview/i }).click();
  await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
  await expect(page.getByRole("textbox")).toBeVisible();

  for (let i = 0; i < 20; i++) {
    if (await page.getByTestId("report-exec").isVisible().catch(() => false)) break;
    // v0.30.0.0: the last answer lands on the pre-scoring review screen; scoring starts only on an
    // explicit 提交并评测 click, not automatically.
    const submitEval = page.getByTestId("submit-and-evaluate");
    if (await submitEval.isVisible().catch(() => false)) {
      await submitEval.click();
      await page.waitForTimeout(250);
      continue;
    }
    const box = page.getByRole("textbox");
    if (!(await box.isVisible().catch(() => false))) break;
    await box.fill("I verify the runbook and confirm the change ticket before deploying.");
    await page.getByRole("button", { name: /提交回答|submit answer/i }).click();
    await page.waitForTimeout(150);
  }

  // Executive report view: grade gauge + SOP-source-vs-answer evidence (the P14 proof).
  // Scoring is one LLM round-trip per answer. Under CI's mock provider that's instant, but on a dev
  // machine whose .env carries a real Foundry endpoint the boot-seed/config-overlay flips scoring to
  // the live provider (~8-10s/answer, ~24s for the interview) — well past the 10s default expect
  // timeout. Give this one wait room for real-provider latency; every later assertion resolves
  // instantly once the report is up. CI (mock) still finishes far inside this budget.
  await expect(page.getByTestId("report-exec")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("score-gauge")).toBeVisible();
  await expect(page.getByTestId("gauge-grade")).toHaveText(/[A-F]/);
  await expect(page.getByTestId("report-evidence")).toBeVisible();

  // Detail view discloses per-item judgments.
  await page.getByTestId("toggle-detail").click();
  await expect(page.getByTestId("report-detail")).toBeVisible();
});

test("voice channel with no mic falls back to the mic-permission dialog (F9 AC#4)", async ({
  browser,
}) => {
  // Fresh context WITHOUT microphone permission so getUserMedia fails and the dialog appears.
  const context = await browser.newContext({ permissions: [] });
  const page = await context.newPage();
  await page.goto("/interview");
  await page.getByRole("button", { name: /开始面试|start interview/i }).click();
  await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
  await page.getByRole("button", { name: /语音作答|answer by voice/i }).click();

  // Either the mic-permission dialog (denied) or the text-fallback notice must appear — never a hang.
  await expect(
    page.getByText(/需要麦克风权限|Microphone access needed|语音不可用|Voice unavailable/i),
  ).toBeVisible({ timeout: 15_000 });
  await context.close();
});
