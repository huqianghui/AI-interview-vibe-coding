/**
 * The report's SOP coverage notes: reference-only, so ONE collapsible section, closed by default
 * (owner, 2026-10-14), with the "does not affect your score" line visible while closed. Runs on the
 * mock stack. Its default bank cites no SOP, so the coverage check has nothing to report; the REAL
 * scoring stream is fetched and only its final `report` event gets coverage findings added, so the
 * page renders them exactly as it would a real audit's.
 */
import { test, expect } from "@playwright/test";
import { primeCandidateLogin } from "./helpers/candidateLogin";
import { continueByTextIfAsked } from "./helpers/micDialog";

test("SOP coverage notes start closed, say they do not affect the score, and open on a click", async ({ page }) => {
  test.setTimeout(180_000);
  let rewritten = false;
  await page.route("**/report/stream", async (route) => {
    const real = await route.fetch();
    const body = (await real.text())
      .split("\n")
      .map((line) => {
        if (!line.trim()) return line;
        let event: { type?: string; report?: Record<string, unknown> };
        try {
          event = JSON.parse(line);
        } catch {
          return line; // not an event (a heartbeat, a partial line): pass it through untouched
        }
        if (event.type !== "report" || !event.report) return line;
        rewritten = true;
        const first = (event.report.per_question as { question_id: string; prompt?: string }[])[0];
        event.report.sop_coverage = [
          {
            question_id: first.question_id,
            question_text: first.prompt ?? "",
            missing: [
              { point: "Confirm the customer's identity first", sop_evidence: "verify ID before proceeding" },
              { point: "Log the change ticket before deploying", sop_evidence: "" },
            ],
          },
        ];
        return JSON.stringify(event);
      })
      .join("\n");
    await route.fulfill({ response: real, body });
  });
  await primeCandidateLogin(page);
  await page.goto("/interview");
  await page.getByRole("button", { name: /开始面试|start interview/i }).click();
  await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
  await expect(page.getByTestId("question-progress")).toBeVisible();
  await continueByTextIfAsked(page);

  for (let i = 0; i < 60; i++) {
    if (await page.getByTestId("report-exec").isVisible().catch(() => false)) break;
    const submitEval = page.getByTestId("submit-and-evaluate");
    if (await submitEval.isVisible().catch(() => false)) {
      await page.getByTestId("sop-coverage-check").check();
      await submitEval.click();
      await page.waitForTimeout(400);
      continue;
    }
    // The mic dialog can come back between questions (no device on CI): stay on text.
    const useText = page.getByRole("button", { name: /use text instead|改用文字/i });
    if (await useText.isVisible().catch(() => false)) {
      // It animates in; a click on a moving target can time out, so try briefly and loop.
      await useText.click({ timeout: 3_000 }).catch(() => undefined);
      continue;
    }
    const box = page.getByRole("textbox");
    if (!(await box.isVisible().catch(() => false))) {
      await page.waitForTimeout(500);
      continue;
    }
    await box.fill("I always double-check the runbook before every deploy.").catch(() => undefined);
    // The mic dialog can cover the button at any moment; the next round dismisses it.
    await page
      .getByRole("button", { name: /提交回答|submit answer/i })
      .click({ timeout: 3_000 })
      .catch(() => undefined);
    await page.waitForTimeout(400);
  }

  await expect(page.getByTestId("report-exec"), "the interview loop never reached the report").toBeVisible({
    timeout: 120_000,
  });
  expect(rewritten, "the scoring stream carried no `report` event to add coverage findings to").toBe(true);
  const section = page.getByTestId("report-sop-coverage");
  await expect(section).toBeVisible({ timeout: 120_000 });
  const toggle = page.getByTestId("report-sop-coverage-toggle").getByRole("button");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(section).toContainText(/do not affect your score|不影响你的评分/i);
  await expect(page.getByTestId("report-sop-coverage-toggle")).toContainText("(2)");
  await expect(section).not.toContainText("Confirm the customer's identity first");
  await section.screenshot({ path: "test-results/sop-coverage-closed.png" });

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  // Open: the points are there, under their question, with the SOP sentence they come from.
  await expect(section).toContainText("Confirm the customer's identity first");
  await expect(section).toContainText("Log the change ticket before deploying");
  await expect(section).toContainText('"verify ID before proceeding"');
  await section.screenshot({ path: "test-results/sop-coverage-open.png" });
});
