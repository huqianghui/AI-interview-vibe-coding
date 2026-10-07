import { test, expect } from "@playwright/test";
import { adminApi, primeCandidateLogin } from "./helpers/candidateLogin";
import { continueByTextIfAsked } from "./helpers/micDialog";

/**
 * #187 end to end, on the mock stack: the admin assigns a question bank to one candidate, that
 * candidate's interview uses it, and the finished interview shows up in both histories (the
 * candidate's start screen, and the admin's Users tab) with its report and transcript.
 *
 * user3, not user1: the other candidate specs share user1, and an assignment on it would change
 * which bank they get.
 *
 * Both fields are assigned. The interviewer matters as much as the bank: external-interview.spec
 * leaves an external-brain persona as the DEFAULT, and an interview on that never reads a bank, so
 * a spec that assigned only the bank passed alone and failed after it in the full run.
 */
const CANDIDATE = "user3";
const ADMIN_USER = "admin";
const ADMIN_PW = "e2e-admin-pw";

test("an assigned bank drives the interview, which then appears in both histories", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const bankName = `E2E assigned bank ${stamp}`;
  const question = `E2E assigned question ${stamp}?`;
  const answer = "I check the runbook and confirm the rollback plan first.";

  // --- Setup over the API: a non-default bank, assigned to user3 only ---
  const { api, headers } = await adminApi();
  const bank = (await (
    await api.post("/admin/question-banks", { headers, data: { name: bankName, is_default: false } })
  ).json()) as { bank_id: string };
  await api.post(`/admin/question-banks/${bank.bank_id}/questions`, {
    headers,
    data: { text: question, expected_points: ["checks the runbook"] },
  });
  const users = (await (await api.get("/admin/users", { headers })).json()) as Array<{
    id: string;
    username: string;
  }>;
  const userId = users.find((u) => u.username === CANDIDATE)!.id;
  // A question-bank interviewer with no avatar character, so the candidate answers by keyboard.
  const persona = (await (
    await api.post("/admin/personas", {
      headers,
      data: { name: `E2E assigned interviewer ${stamp}`, interview_brain: "bank", enabled: true },
    })
  ).json()) as { id: string; name: string };
  try {
    const assigned = await api.patch(`/admin/users/${userId}/assignment`, {
      headers,
      data: { persona_id: persona.id, bank_id: bank.bank_id },
    });
    expect(assigned.ok()).toBe(true);

    // --- Candidate: the interview asks the ASSIGNED bank's question ---
    await primeCandidateLogin(page, CANDIDATE);
    await page.goto("/interview");
    await page.getByRole("button", { name: /开始面试|start interview/i }).click();
    await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
    await continueByTextIfAsked(page);
    await expect(page.getByText(question)).toBeVisible();
    await page.getByRole("textbox").fill(answer);
    await page.getByRole("button", { name: /提交回答|submit answer/i }).click();
    await page.getByTestId("submit-and-evaluate").click();
    await expect(page.getByTestId("report-exec")).toBeVisible({ timeout: 60_000 });

    // --- Candidate: back on the start screen, the finished interview is in "My interviews" ---
    await page.goto("/interview");
    const mine = page.getByTestId("my-interviews");
    await expect(mine).toBeVisible();
    // Newest first. primeCandidateLogin's cleanup already started (and finished) one interview on the
    // assigned bank before this spec's own, so the bank appears twice; ours is the top row.
    const myRow = mine.locator('[data-testid^="history-row-"]').filter({ hasText: bankName }).first();
    await expect(myRow).toContainText(/已评分|Scored/);
    await expect(myRow).toContainText(persona.name);
    await myRow.getByRole("button").click();
    await expect(page.getByTestId("history-transcript")).toContainText(answer);
    await expect(page.getByTestId("report-exec")).toBeVisible();

    // --- Admin: the same interview, opened from user3's row in the Users tab ---
    await page.setViewportSize({ width: 2000, height: 1200 });
    await page.goto("/admin");
    await page.getByTestId("admin-username-input").fill(ADMIN_USER);
    await page.getByTestId("admin-password-input").fill(ADMIN_PW);
    await page.getByTestId("admin-login").click();
    await page.getByTestId("admin-tab-users").click();
    await expect(page.getByTestId(`user-assign-bank-${CANDIDATE}`)).toHaveValue(bank.bank_id);
    await expect(page.getByTestId(`user-assign-persona-${CANDIDATE}`)).toHaveValue(persona.id);
    await page.getByTestId(`user-interviews-${CANDIDATE}`).click();
    const adminRow = page
      .getByTestId(`user-history-table-${CANDIDATE}`)
      .locator('[data-testid^="history-row-"]')
      .filter({ hasText: bankName })
      .first();
    await expect(adminRow).toContainText(/已评分|Scored/);
    await page.screenshot({ path: "e2e/output/user-history-list-2000.png", fullPage: true });
    await adminRow.getByRole("button").click();
    await expect(page.getByTestId("report-exec")).toBeVisible();
    await expect(page.getByTestId("history-transcript")).toContainText(question);
    await expect(page.getByTestId("history-transcript")).toContainText(answer);
    await page.screenshot({ path: "e2e/output/user-history-detail-2000.png", fullPage: true });

    // The transcript downloads as a text file.
    const download = page.waitForEvent("download");
    await page.getByTestId("history-download-transcript").click();
    expect((await download).suggestedFilename()).toMatch(/^interview-transcript-.*\.txt$/);
  } finally {
    // Leave user3 on the default, so other specs that sign in as user3 are unaffected.
    await api.patch(`/admin/users/${userId}/assignment`, {
      headers,
      data: { persona_id: null, bank_id: null },
    });
    await api.dispose();
  }
});
