/**
 * The report's SOP coverage notes: reference-only, so ONE collapsible section, closed by default
 * (owner, 2026-10-14), with the "does not affect your score" line visible while closed. Runs on the
 * mock stack. Its default bank cites no SOP, so the coverage check has nothing to report; the REAL
 * scoring stream is fetched and only its final `report` event gets coverage findings added, so the
 * page renders them exactly as it would a real audit's.
 *
 * Isolated from the specs before it (they share one backend: external-interview.spec leaves an
 * EXTERNAL default persona behind): its own one-question bank and bank interviewer, assigned to user3
 * for the duration and unassigned after.
 */
const CANDIDATE = "user3";
import { test, expect } from "@playwright/test";
import { adminApi, primeCandidateLogin } from "./helpers/candidateLogin";
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
  const stamp = Date.now();
  const { api, headers } = await adminApi();
  const bank = (await (
    await api.post("/admin/question-banks", { headers, data: { name: `E2E coverage bank ${stamp}`, is_default: false } })
  ).json()) as { bank_id: string };
  await api.post(`/admin/question-banks/${bank.bank_id}/questions`, {
    headers,
    data: { text: `E2E coverage question ${stamp}?`, expected_points: ["checks the runbook"] },
  });
  const users = (await (await api.get("/admin/users", { headers })).json()) as { id: string; username: string }[];
  const userId = users.find((u) => u.username === CANDIDATE)!.id;
  // A question-bank interviewer with no avatar character, so the candidate answers by keyboard.
  const persona = (await (
    await api.post("/admin/personas", {
      headers,
      data: { name: `E2E coverage interviewer ${stamp}`, interview_brain: "bank", enabled: true },
    })
  ).json()) as { id: string };
  try {
    const assigned = await api.patch(`/admin/users/${userId}/assignment`, {
      headers,
      data: { persona_id: persona.id, bank_id: bank.bank_id },
    });
    expect(assigned.ok()).toBe(true);

    await primeCandidateLogin(page, CANDIDATE);
    await page.goto("/interview");
    await page.getByRole("button", { name: /开始面试|start interview/i }).click();
    await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
    await continueByTextIfAsked(page);
    await page.getByRole("textbox").fill("I always double-check the runbook before every deploy.");
    await page.getByRole("button", { name: /提交回答|submit answer/i }).click();
    await page.getByTestId("sop-coverage-check").check();
    await page.getByTestId("submit-and-evaluate").click();

    await expect(page.getByTestId("report-exec"), "the interview never reached the report").toBeVisible({
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
  } finally {
    // Leave user3 on the default, so other specs that sign in as user3 are unaffected.
    await api.patch(`/admin/users/${userId}/assignment`, { headers, data: { persona_id: null, bank_id: null } });
    await api.dispose();
  }
});
