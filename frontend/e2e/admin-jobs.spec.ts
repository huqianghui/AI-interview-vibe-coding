import { test, expect } from "@playwright/test";

/**
 * Admin Jobs tab E2E (docs/planning/spec-jobs-and-scale-out.md §6), on the shared mock backend.
 *
 * The backend runs its job runner embedded here (JOB_RUNNER_MODE's default), and every boot queues
 * two jobs: the default interviewer's sync and the SOP backfill. So the tab has real rows to show
 * without this test making any: both have succeeded by the time it looks, which the first view
 * (queued, running, failed) leaves out until "Succeeded" is ticked.
 */

const ADMIN_USER = "admin";
const ADMIN_PW = "e2e-admin-pw";

test("the Jobs tab lists the boot jobs and filters by status and kind", async ({ page }) => {
  await page.goto("/admin");
  await page.getByTestId("admin-username-input").fill(ADMIN_USER);
  await page.getByTestId("admin-password-input").fill(ADMIN_PW);
  await page.getByTestId("admin-login").click();
  await page.getByTestId("admin-tab-jobs").click();
  await expect(page.getByTestId("jobs-tab")).toBeVisible();

  await page.getByTestId("jobs-filter-status-succeeded").click();
  const table = page.getByTestId("jobs-table");
  await expect(table).toContainText(/Sync interviewer|同步面试官/);
  await expect(table).toContainText(/Convert all SOPs|转换全部 SOP/);
  await expect(table).toContainText(/Succeeded|已完成/);
  await page.screenshot({ path: "test-results/admin-jobs-tab.png", fullPage: true });

  await page.getByTestId("jobs-filter-kind").selectOption("persona_sync");
  await expect(table).not.toContainText(/Convert all SOPs|转换全部 SOP/);
  await page.getByTestId("jobs-reset").click();
  await expect(page.getByTestId("jobs-filter-status-succeeded")).not.toBeChecked();
});
