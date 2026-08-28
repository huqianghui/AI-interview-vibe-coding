import { test, expect, request as pwRequest } from "@playwright/test";

/**
 * README screenshot capture (opt-in, NOT a test of behavior).
 *
 * Drives the same flows as the real E2E specs and saves PNGs for the root README.md into
 * `docs/images/`. Runs on the standard zero-Azure mock stack (playwright.config webServers).
 *
 * Self-skips unless SCREENSHOTS=1 so `npm run e2e` / CI stay unchanged:
 *   cd frontend && SCREENSHOTS=1 npx playwright test e2e/readme-screenshots.spec.ts
 */

const ENABLED = process.env.SCREENSHOTS === "1";
const OUT = "../docs/images";
const ADMIN_USER = "admin";
const ADMIN_PW = "e2e-admin-pw";

test.skip(!ENABLED, "README screenshot capture is opt-in: set SCREENSHOTS=1");

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeAll(async () => {
  if (!ENABLED) return;
  // Author a default bank with a follow-up-bearing question so the F7 memory moment shows up.
  const api = await pwRequest.newContext({ baseURL: "http://127.0.0.1:8100" });
  const token = (
    await (
      await api.post("/auth/login", {
        headers: { "Content-Type": "application/json" },
        data: { username: ADMIN_USER, password: ADMIN_PW },
      })
    ).json()
  ).access_token;
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const bank = await (
    await api.post("/admin/question-banks", {
      headers: auth,
      data: { name: `README Shots Bank ${Date.now()}`, is_default: true },
    })
  ).json();
  for (const [text, maxFu] of [
    ["Describe your deployment safety habit.", 1],
    ["How do you verify a rollback plan before shipping?", 0],
  ] as const) {
    await api.post(`/admin/question-banks/${bank.bank_id}/questions`, {
      headers: auth,
      data: { text, max_follow_ups: maxFu },
    });
  }
  await api.dispose();
});

test("capture candidate flow: interview → follow-up → review → report", async ({ page }) => {
  await page.goto("/interview");
  await expect(page.getByRole("button", { name: /开始面试|start interview/i })).toBeVisible();
  await page.screenshot({ path: `${OUT}/01-landing.png` });

  await page.getByRole("button", { name: /开始面试|start interview/i }).click();
  await expect(page.getByText(/开始之前|before we begin/i)).toBeVisible();
  await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();

  await expect(page.getByTestId("question-progress")).toBeVisible();
  await expect(page.getByRole("textbox")).toBeVisible();
  await page.screenshot({ path: `${OUT}/02-interview-question.png` });

  // Answer turns until the report; grab the follow-up (memory) and review screens on the way.
  let shotFollowUp = false;
  for (let i = 0; i < 20; i++) {
    if (await page.getByTestId("report-exec").isVisible().catch(() => false)) break;

    const submitEval = page.getByTestId("submit-and-evaluate");
    if (await submitEval.isVisible().catch(() => false)) {
      await page.screenshot({ path: `${OUT}/04-review-before-scoring.png` });
      await submitEval.click();
      await page.waitForTimeout(400);
      continue;
    }

    const box = page.getByRole("textbox");
    if (!(await box.isVisible().catch(() => false))) break;
    await box.fill("I always double-check the runbook before every deploy.");
    await page.getByRole("button", { name: /提交回答|submit answer/i }).click();
    await page.waitForTimeout(400);

    const bodyText = (await page.locator("body").textContent().catch(() => "")) ?? "";
    if (
      !shotFollowUp &&
      bodyText.includes("double-check the runbook") &&
      /You mentioned|你刚才提到/.test(bodyText)
    ) {
      await page.screenshot({ path: `${OUT}/03-follow-up-memory.png` });
      shotFollowUp = true;
    }
  }

  await expect(page.getByTestId("report-exec")).toBeVisible();
  await expect(page.getByTestId("score-gauge")).toBeVisible();
  await page.screenshot({ path: `${OUT}/05-report-executive.png`, fullPage: true });

  await page.getByTestId("toggle-detail").click();
  await expect(page.getByTestId("report-detail")).toBeVisible();
  await page.screenshot({ path: `${OUT}/06-report-detail.png`, fullPage: true });
});

test("capture admin: content workspace + rubric editor", async ({ page }) => {
  await page.goto("/admin");
  await page.getByTestId("admin-username-input").fill(ADMIN_USER);
  await page.getByTestId("admin-password-input").fill(ADMIN_PW);
  await page.getByTestId("admin-login").click();
  await expect(page.getByRole("heading", { name: /题库与评分标准/ })).toBeVisible();

  const bankName = `README Admin Bank ${Date.now()}`;
  await page.getByPlaceholder("New bank name").fill(bankName);
  await page.getByRole("button", { name: "Add bank" }).click();
  await page.getByRole("button", { name: bankName }).click();
  await expect(page.getByText("Questions")).toBeVisible();
  await page.getByPlaceholder("New question text").fill("Walk me through your pre-deploy checks.");
  await page.getByRole("button", { name: "Add question" }).click();

  await page.getByRole("button", { name: /评分标准 \/ Rubric/ }).click();
  await page.getByTestId("checklist-generate").click();
  await expect(page.getByText(/Weights total: 100/)).toBeVisible();
  await page.screenshot({ path: `${OUT}/07-admin-rubric-editor.png`, fullPage: true });
});

test("capture admin: Foundry agent persona editor", async ({ page }) => {
  await page.goto("/admin/agent");
  const user = page.getByTestId("agent-username-input");
  if (await user.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await user.fill(ADMIN_USER);
    await page.getByTestId("agent-password-input").fill(ADMIN_PW);
    await page.getByTestId("agent-login").click();
  }
  // Editor surface (persona nav + definition sections + avatar preview). Give the avatar
  // thumbnails a beat to load; they come from the MS Learn CDN and may be blank offline.
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/08-admin-agent-editor.png` });
});
