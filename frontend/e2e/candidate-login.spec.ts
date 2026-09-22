import { expect, test } from "@playwright/test";
import {
  adminApi,
  candidatePassword,
  candidateToken,
  enterTextChannel,
  finishOpenInterview,
  waitForInterviewStage,
} from "./helpers/candidateLogin";

/**
 * #102 — candidate login gate + admin Users tab. Runs in BOTH configs:
 *  - default (mock providers, CI): the gate, the seeded accounts and resume-after-relogin.
 *  - live (real .env config): the same journey against the real backend; the digital-human read of
 *    Q1 is covered by voice-live-azure.spec.ts (which now signs in through the same helper).
 *
 * Nothing here hardcodes a candidate password: it is read through the admin API exactly like an
 * operator would read it from the Users tab.
 */
const ADMIN_USER = process.env.E2E_ADMIN_USERNAME || "admin";
const ADMIN_PW = process.env.E2E_ADMIN_PASSWORD || "e2e-admin-pw";
const PW_RE = /[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}/;
// Live runs (real .env) drive the client's real default persona/bank (often the external brain) —
// never touch their default bank. Mock runs author a deterministic multi-question bank so "answer
// Q1, resume at Q2" is guaranteed regardless of what a sibling spec left as default.
const LIVE = process.env.LIVE_VOICE === "1";
let previousDefaultBankId: string | null = null;

test.beforeAll(async () => {
  if (LIVE) return;
  const { api, headers } = await adminApi();
  try {
    const banks = (await (await api.get("/admin/question-banks", { headers })).json()) as {
      bank_id: string;
      is_default: boolean;
    }[];
    previousDefaultBankId = banks.find((b) => b.is_default)?.bank_id ?? null;
    const bank = (await (
      await api.post("/admin/question-banks", {
        headers,
        data: { name: `E2E Login Bank ${Date.now()}`, is_default: true },
      })
    ).json()) as { bank_id: string };
    for (const text of [
      "Describe how you prepare a site for an inspection.",
      "How do you track training completion across the region?",
      "What do you do when a deviation is found during an audit?",
    ]) {
      await api.post(`/admin/question-banks/${bank.bank_id}/questions`, {
        headers,
        data: { text, max_follow_ups: 0 },
      });
    }
  } finally {
    await api.dispose();
  }
});

test.afterAll(async () => {
  if (LIVE || !previousDefaultBankId) return;
  // Walk user1's leftover interview to completion BEFORE switching the default bank back: bank
  // questions resolve against the current default bank, so an interview parked at Q2 of our
  // 3-question bank would be stranded (no question, not scorable) once a 1-question bank is default.
  await finishOpenInterview(await candidateToken("user1"));
  const { api, headers } = await adminApi();
  try {
    await api.post(`/admin/question-banks/${previousDefaultBankId}/default`, { headers });
  } finally {
    await api.dispose();
  }
});

async function signIn(page: import("@playwright/test").Page, username: string, password: string) {
  await page.getByTestId("candidate-username-input").fill(username);
  await page.getByTestId("candidate-password-input").fill(password);
  await page.getByTestId("candidate-login").click();
}

test("interview page is gated: card shown, wrong password rejected, admin refused", async ({ page }) => {
  await page.goto("/interview");
  await expect(page.getByTestId("candidate-login")).toBeVisible();
  await expect(page.getByRole("button", { name: /开始面试|start interview/i })).toHaveCount(0);

  await signIn(page, "user1", "definitely-wrong");
  await expect(page.getByText(/用户名或密码错误|wrong username or password|incorrect/i)).toBeVisible();

  await signIn(page, ADMIN_USER, ADMIN_PW);
  await expect(page.getByText("Admin accounts cannot take interviews")).toBeVisible();
  await expect(page.getByTestId("candidate-login")).toBeVisible();
});

test("user1 signs in, starts, answers, signs out, and resumes after a fresh tab", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const password = await candidatePassword("user1");
  // Clean slate: a sibling spec may have left user1 mid-interview (sessions are per account).
  await finishOpenInterview(await candidateToken("user1"));

  await page.goto("/interview");
  await signIn(page, "user1", password);
  await page.getByRole("button", { name: /开始面试|start interview/i }).click();
  await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
  await waitForInterviewStage(page);
  const interviewId = await page.evaluate(() => localStorage.getItem("interview_session_id"));
  expect(interviewId).toBeTruthy();

  // Answer Q1 by text (works for bank and external-brain personas, voice-default or not).
  await enterTextChannel(page);
  await page.getByRole("textbox").fill("A first answer of reasonable length for the resume check.");
  await page.getByRole("button", { name: /提交回答|submit answer/i }).click();
  // An external brain hides the input while it "thinks"; wait for the next turn to open, then the
  // box is back and empty.
  await expect(page.getByRole("textbox")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("textbox")).toHaveValue("");

  // A brand-new context = closed tab (sessionStorage AND localStorage gone).
  const fresh = await browser.newContext();
  const page2 = await fresh.newPage();
  await page2.goto("/interview");
  await expect(page2.getByTestId("candidate-login")).toBeVisible();
  await signIn(page2, "user1", password);
  // Same account → the backend hands back the same session → Start RESUMES the same interview
  // (same interview id, no orientation screen).
  await page2.getByRole("button", { name: /开始面试|start interview/i }).click();
  // The page always shows the orientation beat after Start (resume included).
  await page2.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
  await waitForInterviewStage(page2);
  const resumedId = await page2.evaluate(() => localStorage.getItem("interview_session_id"));
  expect(resumedId).toBe(interviewId);
  await fresh.close();

  // Sign out on the original tab → back to the card; tokens gone.
  await page.getByTestId("candidate-sign-out").click();
  await expect(page.getByTestId("candidate-login")).toBeVisible();
  const leftovers = await page.evaluate(() => [
    sessionStorage.getItem("candidate_access_token"),
    localStorage.getItem("anon_session_token"),
    localStorage.getItem("interview_session_id"),
  ]);
  expect(leftovers).toEqual([null, null, null]);
});

test("admin Users tab lists the seeded candidates with viewable passwords", async ({ page }) => {
  await page.goto("/admin");
  await page.getByTestId("admin-username-input").fill(ADMIN_USER);
  await page.getByTestId("admin-password-input").fill(ADMIN_PW);
  await page.getByTestId("admin-login").click();
  await page.getByTestId("admin-tab-users").click();
  for (const name of ["user1", "user2", "user3"]) {
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  }
  const shown = await page.getByText(PW_RE).count();
  expect(shown).toBeGreaterThanOrEqual(3);
  // The admin's own row never exposes a password.
  const adminRow = page.getByRole("row").filter({ hasText: ADMIN_USER });
  await expect(adminRow).not.toContainText(PW_RE);
});
