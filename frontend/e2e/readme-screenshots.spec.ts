import { test, expect, request as pwRequest } from "@playwright/test";
import { primeCandidateLogin } from "./helpers/candidateLogin";

/**
 * README screenshot capture (opt-in, NOT a test of behavior).
 *
 * Drives the same flows as the real E2E specs and saves PNGs for the root README.md into
 * `docs/images/`. Runs on the standard zero-Azure mock stack (playwright.config webServers).
 *
 * Self-skips unless SCREENSHOTS=1 so `npm run e2e` / CI stay unchanged:
 *   cd frontend && SCREENSHOTS=1 npx playwright test e2e/readme-screenshots.spec.ts
 *
 * RESTART THE MOCK STACK FIRST. playwright.config sets `reuseExistingServer: !CI`, so a backend
 * left running from an earlier session is reused — and it serves the code it booted with. That is
 * how a capture run on 2026-10-04 produced a report screenshot still showing the doubled full stop
 * fixed hours earlier in v0.42.1.1: the uvicorn process was four hours old. Kill anything on :8100
 * and :5273 before capturing, or the screenshots document a version that no longer exists:
 *   pkill -f "uvicorn app.main:app.*8100"; pkill -f "vite.*5273"
 */

const ENABLED = process.env.SCREENSHOTS === "1";
const OUT = "../docs/images";
const ADMIN_USER = "admin";
const ADMIN_PW = "e2e-admin-pw";

test.skip(!ENABLED, "README screenshot capture is opt-in: set SCREENSHOTS=1");

test.use({ viewport: { width: 1440, height: 900 } });

/**
 * Clear the mic-permission dialog if it appears (recorded learning, 2026-09-24).
 *
 * On a local Mac, headless Chromium has no fake media device, so getUserMedia rejects and the app
 * raises "Microphone access needed" over the answer box — even with `permissions: ["microphone"]`.
 * CI (Linux, fake device) never sees it. Without this the capture of the interview screen failed on
 * a missing textbox and the August screenshots silently stayed in the README.
 */
async function continueByTextIfAsked(page: import("@playwright/test").Page) {
  const useText = page.getByRole("button", { name: /use text instead|改用文字/i });
  // The dialog arrives asynchronously, so wait for whichever shows first.
  await expect(page.getByRole("textbox").or(useText).first()).toBeVisible();
  if (await useText.isVisible().catch(() => false)) await useText.click();
}

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

test("capture the sign-in screen", async ({ page }) => {
  // Deliberately NOT primed: this is the screen a candidate actually arrives on, and since
  // v0.41.1.0 it is the strongest one in the product — the interviewer's own portrait beside the
  // form. The other test primes the login via addInitScript, which has to happen before goto, so
  // the unauthenticated shot needs its own page.
  await page.goto("/interview");
  await expect(page.getByRole("button", { name: /登录|sign in/i })).toBeVisible();
  await page.screenshot({ path: `${OUT}/00-signin.png` });
});

test("capture candidate flow: idle → orientation → interview → review → report", async ({ page }) => {
  await primeCandidateLogin(page); // #102: /interview is login-gated
  await page.goto("/interview");
  await expect(page.getByRole("button", { name: /开始面试|start interview/i })).toBeVisible();
  await page.screenshot({ path: `${OUT}/01-landing.png` });

  await page.getByRole("button", { name: /开始面试|start interview/i }).click();
  await expect(page.getByText(/开始之前|before we begin/i)).toBeVisible();
  // The orientation beat is one of the four screens redesigned in v0.42.0.0 and had never been
  // captured: it is the only screen that tells the candidate how many questions there are.
  await page.screenshot({ path: `${OUT}/01b-orientation.png` });
  await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();

  await expect(page.getByTestId("question-progress")).toBeVisible();
  await continueByTextIfAsked(page);
  await expect(page.getByRole("textbox")).toBeVisible();
  await page.screenshot({ path: `${OUT}/02-interview-question.png` });

  // Answer turns until the report, grabbing the review screen on the way.
  //
  // There used to be a `03-follow-up-memory.png` capture here, gated on the body text matching
  // /You mentioned|你刚才提到/. That was the LINEAR-mode template follow-up, retired in v0.39.2.0
  // (a submit always advances now, in every turn mode), so the condition can never be true and the
  // shot can never be taken — it would have silently kept shipping an August screenshot of a
  // feature that no longer exists. The judged nudge that replaced it needs a real judge verdict,
  // which the mock stack does not produce; it is covered by `bank-judged-live.spec.ts`.
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
  }

  // The loop above only answers; waiting for the report belongs here. It used to rely on the
  // loop's own iterations to catch `report-exec`, but once the last answer is submitted the
  // review screen is gone and no textbox is left, so the loop breaks immediately and the default
  // 10 s expect became the entire scoring budget — a bet on timing, not a wait.
  await expect(page.getByTestId("report-exec")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("score-gauge")).toBeVisible();
  await page.screenshot({ path: `${OUT}/05-report-executive.png`, fullPage: true });

  // The detail shot now means "every question expanded", not "the gate clicked": there is no gate,
  // and what this image has to document is that all questions get the same side-by-side card.
  await expect(page.getByTestId("report-detail")).toBeVisible();
  // `button[aria-expanded]` and NOT "any button in the accordion": each expanded item carries its
  // own `sop-source-link` button, so the looser selector matches items instead of headers — which
  // is how the first attempt at this produced a detail screenshot identical to the executive one.
  const headers = page.locator('[data-testid="report-detail"] button[aria-expanded]');
  const headerCount = await headers.count();
  const itemsBefore = await page.getByTestId("report-item").count();
  for (let i = 1; i < headerCount; i++) await headers.nth(i).click();
  // Prove the expansion actually RENDERED. `aria-expanded` alone is not proof: it flipped to "true"
  // on a run whose detail screenshot was still byte-identical to the executive one.
  // Prove the expansion actually RENDERED, by item count. `aria-expanded` is not proof: it flipped
  // to "true" on a run whose detail screenshot was still byte-identical to the executive one.
  const itemsAfter = await page.getByTestId("report-item").count();
  if (headerCount > 1) expect(itemsAfter).toBeGreaterThan(itemsBefore);

  // ELEMENT screenshot, deliberately — this is the one README image that is the content column
  // rather than the whole 1440px page, because `fullPage` cannot capture this screen.
  //
  // The report sits inside the shell's own box, so `document.body` does not grow when a question
  // expands: measured at 2150px both before and after seven more cards rendered. `fullPage` follows
  // the body, so it silently clipped everything past roughly one viewport and the detail capture kept
  // coming out the same height as the executive one no matter how many sections were open — twice,
  // including once while an `aria-expanded` assertion passed. Growing the viewport to the report's
  // bounding box first does not fix it either (measured: +88px for six more cards). Screenshotting
  // the element is the only form that actually contains the expanded report.
  await page.getByTestId("report").screenshot({ path: `${OUT}/06-report-detail.png` });
});

test("capture admin: content workspace + rubric editor", async ({ page }) => {
  await page.goto("/admin");
  await page.getByTestId("admin-username-input").fill(ADMIN_USER);
  await page.getByTestId("admin-password-input").fill(ADMIN_PW);
  await page.getByTestId("admin-login").click();
  await expect(
    page.getByRole("heading", { name: /题库与评分标准|Question banks & rubrics/ }),
  ).toBeVisible();

  const bankName = `README Admin Bank ${Date.now()}`;
  await page.getByPlaceholder("New bank name").fill(bankName);
  await page.getByRole("button", { name: "Add bank" }).click();
  await page.getByRole("button", { name: bankName }).click();
  await expect(page.getByText("Questions")).toBeVisible();
  await page.getByPlaceholder("New question text").fill("Walk me through your pre-deploy checks.");
  await page.getByRole("button", { name: "Add question" }).click();

  await page.getByRole("button", { name: /评分标准|Rubric/ }).click();
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
