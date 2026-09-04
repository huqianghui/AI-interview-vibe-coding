import { test, expect } from "@playwright/test";

/**
 * Admin external-interview-API config E2E (SPEC Phase 2, vendor-neutral).
 *
 * Exercises the /admin › Connection tab "External interview API" card end to end in a real browser:
 * save endpoint + user-tag + key, click-to-reveal the plaintext key, run the test-connection probe,
 * and confirm the write-only key masking. Nothing here names a product (owner directive) — the UI
 * copy and this test speak only of an "external interview API".
 *
 * Runs on the shared mock backend. It saves a NON-EMPTY endpoint mid-test (which would flip the
 * runner to the http provider), so it RESETS the endpoint back to empty at the end — the sibling
 * external-interview spec relies on the empty-endpoint mock provider to drive its interview.
 */

const ADMIN_USER = "admin";
const ADMIN_PW = "e2e-admin-pw";

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/admin");
  await page.getByTestId("admin-username-input").fill(ADMIN_USER);
  await page.getByTestId("admin-password-input").fill(ADMIN_PW);
  await page.getByTestId("admin-login").click();
  // Admin editor page heading (i18n-driven — match either locale).
  await expect(
    page.getByRole("heading", { name: /题库与评分标准|Question banks & rubrics/ }),
  ).toBeVisible();
}

test("admin saves, reveals, and probes the external interview API config", async ({ page }) => {
  await signIn(page);

  // Switch to the Connection tab where the external-API card lives.
  await page.getByTestId("admin-tab-connection").click();
  await expect(page.getByTestId("ext-endpoint")).toBeVisible();

  // --- Save endpoint + user-tag + key ---
  // A syntactically valid https host on the reserved .invalid TLD: passes the endpoint validator
  // (https, public DNS name) but is guaranteed-unreachable, so the later probe fails fast (NXDOMAIN)
  // instead of hanging. The key is a test value only (never a real secret — owner directive).
  const endpoint = "https://external-brain.invalid/v1/interview";
  const userTag = "e2e-deployment";
  const apiKey = "e2e-external-test-key-123456";

  await page.getByTestId("ext-endpoint").fill(endpoint);
  await page.getByTestId("ext-user-tag").fill(userTag);
  await page.getByTestId("ext-key").fill(apiKey);
  await page.getByTestId("ext-save").click();
  await expect(page.getByTestId("ext-status")).toHaveText(/Saved\./);

  // After save the config reloads: the key is write-only, so its input becomes a masked placeholder
  // ("API key (saved: …)") — the plaintext is never round-tripped into the field.
  await expect(page.getByTestId("ext-key")).toHaveAttribute(
    "placeholder",
    /API key \(saved: .+\)/,
  );

  // The saved endpoint + user-tag DO round-trip back into their inputs on reload.
  await expect(page.getByTestId("ext-endpoint")).toHaveValue(endpoint);
  await expect(page.getByTestId("ext-user-tag")).toHaveValue(userTag);

  // --- Click-to-reveal exposes the plaintext key on a deliberate click (separate reveal route) ---
  await page.getByTestId("ext-reveal").click();
  await expect(page.getByTestId("ext-revealed")).toHaveText(apiKey);
  // Toggling again hides it.
  await page.getByTestId("ext-reveal").click();
  await expect(page.getByTestId("ext-revealed")).toHaveCount(0);

  // --- Test connection: probes the (unreachable) endpoint without creating any interview rows.
  // The probe never throws — it reports a structured pass/fail; against .invalid it fails fast, so
  // we only assert a non-empty status message surfaced (not a specific pass/fail).
  await page.getByTestId("ext-test").click();
  await expect(page.getByTestId("ext-status")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("ext-status")).not.toHaveText("");

  // --- Reset endpoint to empty so the sibling external-interview spec gets the mock provider ---
  // (An empty api_key preserves the stored key; only the endpoint decides http-vs-mock.)
  await page.getByTestId("ext-endpoint").fill("");
  await page.getByTestId("ext-save").click();
  await expect(page.getByTestId("ext-status")).toHaveText(/Saved\./);
  await expect(page.getByTestId("ext-endpoint")).toHaveValue("");
});
