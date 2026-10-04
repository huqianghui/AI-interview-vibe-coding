import { expect, type Page } from "@playwright/test";

/**
 * Clear the mic-permission dialog if the app raises it, then leave the answer box focused-able.
 *
 * On a local Mac, headless Chromium has no fake media device, so `getUserMedia` rejects and the app
 * shows "Microphone access needed" over the answer controls — even with `permissions: ["microphone"]`
 * granted. CI (Linux, fake device) never sees it. Specs that do not handle this fail on every
 * developer machine for a reason that has nothing to do with the code under test, which trains
 * people to ignore a red suite.
 *
 * Waits for whichever arrives first — the answer box (CI) or the dialog (no device) — rather than a
 * fixed pause, because the dialog appears asynchronously after getUserMedia rejects.
 */
export async function continueByTextIfAsked(page: Page) {
  const useText = page.getByRole("button", { name: /use text instead|改用文字/i });
  await expect(page.getByRole("textbox").or(useText).first()).toBeVisible();
  if (await useText.isVisible().catch(() => false)) await useText.click();
}
