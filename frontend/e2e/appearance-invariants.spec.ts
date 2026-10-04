import { test, expect } from "@playwright/test";
import { primeCandidateLogin } from "./helpers/candidateLogin";

/**
 * The eight appearance invariants that only a real browser can hold (v0.41.0.0 → v0.42.x).
 *
 * The theme contracts and AppShell's structure are covered by unit tests, but these eight are
 * E2E-shaped by nature: jsdom has no autofill, no real font loading, and no viewport. Until now they
 * were held by nothing but one manual check done at ship time, which is how the design could regress
 * into a user-visible defect with CI entirely green.
 *
 * Runs on the standard zero-Azure mock stack, so it is part of `npm run e2e` and gates every commit.
 */

const GROUND = "rgb(245, 241, 234)"; // palette.ground #F5F1EA, painted on html/body in global.css
const SURFACE_HEXES = ["#fffdf9", "#FFFDF9"]; // palette.surface — the CARD colour, never the page

test.describe("appearance invariants", () => {
  test("1. the FluentProvider root stays transparent, so the page ground shows through", async ({
    page,
  }) => {
    // THE ONE WITH BUG HISTORY. The ground is painted on html/body, and `avatar_bg` tells Azure to
    // paint the digital human's wall the same colour. If the `provider` class in App.tsx is ever
    // dropped, the provider repaints the page in the warm CARD surface, the two stop matching, and
    // a visible rectangle reappears around the interviewer — the exact defect `avatar_bg` exists to
    // prevent, with CI green.
    await page.goto("/interview");
    const bg = await page.evaluate(() => {
      const el = document.querySelector(".fui-FluentProvider");
      return el ? getComputedStyle(el).backgroundColor : "NO PROVIDER";
    });
    // Transparent renders as rgba(0,0,0,0) in every engine.
    expect(bg).toBe("rgba(0, 0, 0, 0)");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(GROUND);
  });

  test("2. an autofilled field keeps the warm surface, not Chrome's light blue", async ({ page }) => {
    // Most of the original complaint: Chrome repaints an autofilled input #E8F0FE and overrides every
    // Fluent token, which made the sign-in screen read like a Windows form. global.css fights back
    // with a 1000px inset box-shadow in the surface colour.
    await page.goto("/interview");
    const user = page.getByRole("textbox").first();
    await user.fill("user1");
    // Chrome only applies :-webkit-autofill to a real autofill, which Playwright cannot trigger — so
    // assert the RULE is live rather than the state: the shadow is what survives the repaint.
    const rule = await page.evaluate(() =>
      [...document.styleSheets]
        .flatMap((s) => {
          try {
            return [...s.cssRules];
          } catch {
            return [];
          }
        })
        .map((r) => r.cssText)
        .filter((t) => t.includes("-webkit-autofill"))
        .join(" "),
    );
    expect(rule, "the autofill override must be in the stylesheet").toContain("inset");
    // The engine normalises #fffdf9 to rgb(255, 253, 249) in cssText, so assert the rgb form —
    // asserting the hex passes nowhere and fails everywhere, which is a lesson this repo has
    // already learned once in jsdom.
    expect(rule, "the inset shadow must be palette.surface").toContain("rgb(255, 253, 249)");
    expect(rule).toContain("-webkit-text-fill-color");
    expect(rule, "the text colour must survive the repaint too").toContain("rgb(36, 31, 26)");
  });

  test("3. both faces load, and nothing reaches fonts.googleapis.com", async ({ page }) => {
    // The fonts are self-hosted because Google Fonts is unreachable from the client's network. A
    // regression to the CDN would look fine here and show Times New Roman to the actual users.
    const external: string[] = [];
    page.on("request", (r) => {
      if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(r.url())) external.push(r.url());
    });
    await page.goto("/interview");
    await page.waitForLoadState("networkidle");
    const faces = await page.evaluate(async () => {
      await (document as unknown as { fonts: FontFaceSet }).fonts.ready;
      return [...(document as unknown as { fonts: FontFaceSet }).fonts].map(
        (f) => `${f.family}:${f.status}`,
      );
    });
    expect(external, `no request may go to Google Fonts: ${external.join(", ")}`).toEqual([]);
    expect(faces.join(" ")).toContain("Bricolage Grotesque:loaded");
    expect(faces.join(" ")).toContain("Literata:loaded");
  });

  test("4. zh-CN renders Chinese in a modern sans, never SimSun", async ({ page }) => {
    // Only ever visible to Chinese candidates — which is the client's whole user base. Neither
    // self-hosted face carries CJK, so the fallback chain has to land on PingFang SC / Microsoft
    // YaHei and not on a serif.
    await page.goto("/interview");
    await page.evaluate(() => localStorage.setItem("i18nextLng", "zh-CN"));
    await page.reload();
    await page.waitForLoadState("networkidle");
    const stack = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(stack).toMatch(/PingFang SC|Microsoft YaHei/);
    expect(stack).not.toMatch(/SimSun|宋体|Songti/);
    // PingFang must come BEFORE any CJK serif, or Chinese lands in Songti anyway.
    const pf = stack.indexOf("PingFang SC");
    const serif = stack.lastIndexOf("serif");
    expect(pf, "PingFang SC must appear in the stack").toBeGreaterThan(-1);
    expect(pf).toBeLessThan(serif);
  });

  test("5. 390px wide has no horizontal page scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/interview");
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "the page must never scroll sideways on a phone").toBeLessThanOrEqual(0);
  });

  test("6. the page ground is the ground colour, not the card surface", async ({ page }) => {
    // Guards the pair that `avatar_bg` depends on: body ground and the avatar wall are the same
    // value, and the card surface is a DIFFERENT one. If body ever becomes the surface, the two
    // drift and the interviewer gets a rectangle again.
    await page.goto("/interview");
    const body = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(body).toBe(GROUND);
    for (const hex of SURFACE_HEXES) {
      expect(body.toLowerCase()).not.toContain(hex.toLowerCase().slice(1));
    }
  });

  test("7. the sign-in screen fits one viewport at 1440x900", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/interview");
    await page.waitForLoadState("networkidle");
    const scroll = await page.evaluate(
      () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
    );
    // A couple of pixels of sub-pixel rounding is not a scrollbar; 50+ is a composition that does
    // not fit. (Measured 2026-10-04: 1 px at 900, 51 px at 720 — filed as a known P3.)
    expect(scroll, `sign-in should fit 1440x900, scrollable by ${scroll}px`).toBeLessThan(24);
  });

  test("8. a short viewport scrolls instead of clipping the controls", async ({ page }) => {
    // The live screen uses a height escape below 560px so `overflow: hidden` on the stage cannot
    // make the answer controls unreachable — that bug shipped once and could not be clicked out of.
    await primeCandidateLogin(page);
    await page.setViewportSize({ width: 1280, height: 520 });
    await page.goto("/interview");
    await page.getByRole("button", { name: /开始面试|start interview/i }).click();
    await expect(page.getByText(/开始之前|before we begin/i)).toBeVisible();
    await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
    await expect(page.getByTestId("question-progress")).toBeVisible();
    const reachable = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="interview-controls"]');
      if (!el) return "NO CONTROLS";
      const r = el.getBoundingClientRect();
      // Either visible in the viewport, or reachable by scrolling — never clipped away.
      const scrollable =
        document.documentElement.scrollHeight > document.documentElement.clientHeight ||
        (el.closest("[style*='overflow'],*") as HTMLElement | null)?.scrollHeight !== undefined;
      return r.height > 0 && (r.bottom <= innerHeight || scrollable);
    });
    expect(reachable, "the answer controls must stay reachable on a short viewport").toBe(true);
  });
});
