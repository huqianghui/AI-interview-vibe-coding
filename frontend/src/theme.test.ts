/**
 * theme.ts holds no logic, so what is worth testing is its CONTRACTS — the three invariants other
 * code silently depends on. Each one has a concrete failure mode, and two of them have bug history
 * in this repo.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { appTheme, fonts, foundryPurple, layout, palette } from "./theme";

describe("theme contracts", () => {
  it("anchors the brand ramp so brand[80] IS the action colour", () => {
    // createLightTheme maps brand[80] → colorBrandBackground, [70] → hover, [60] → pressed. If the
    // ramp drifts off the action colour, every primary button, link and focus ring moves to a
    // purple nobody chose, while `palette.action` (used directly in a few places) stays put — so
    // the UI ends up with two slightly different purples and no obvious culprit.
    expect(foundryPurple[80]).toBe(palette.action);
    expect(appTheme.colorBrandBackground).toBe(palette.action);
  });

  it("keeps the ramp monotonically lightening from 10 to 160", () => {
    // A non-monotonic ramp does not fail loudly: Fluent derives hover/pressed/selected states by
    // stepping along it, so an out-of-order stop makes a button get DARKER on hover in one place
    // and lighter in another. Cheap to assert, impossible to eyeball across 16 stops.
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const stops = Object.keys(foundryPurple)
      .map(Number)
      .sort((a, b) => a - b)
      .map((k) => luminance(foundryPurple[k as keyof typeof foundryPurple]));
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i]).toBeGreaterThan(stops[i - 1]);
    }
  });

  it("keeps palette.ground a six-digit hex, because the voice URL silently drops anything else", () => {
    // `palette.ground` is sent to Azure as `avatar_bg` to paint the wall behind the digital human.
    // `buildWsUrl` strips the '#' and validates six hex digits — a 3-digit shorthand, an rgb()
    // string or a CSS var would be DROPPED WITHOUT ERROR, and Azure would fall back to whatever
    // studio wall the avatar was recorded on: a visible rectangle around the interviewer, with no
    // log line pointing at this constant. See InterviewPage.videoToggle.test.tsx for the wiring.
    expect(palette.ground).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it("wires the body font into Fluent's base font token", () => {
    // Fluent components read fontFamilyBase. If this is not wired, every Fluent control renders in
    // Segoe UI while our own makeStyles rules render in Literata — a mismatch that reads as a
    // rendering bug rather than a theme gap.
    expect(appTheme.fontFamilyBase).toBe(fonts.body);
  });

  it("names a CJK fallback in both stacks, since neither face carries CJK glyphs", () => {
    // Bricolage Grotesque and Literata are latin-only. Without an explicit CJK family the zh-CN
    // interview renders Chinese in the browser's default, which on Windows is often SimSun — the
    // single most dated-looking choice available, and only visible to Chinese candidates.
    for (const stack of [fonts.display, fonts.body]) {
      expect(stack).toMatch(/PingFang SC|Microsoft YaHei/);
    }
  });

  it("gives every layout measure a real CSS length", () => {
    // AppShell interpolates these straight into makeStyles. `undefined` would not throw; it would
    // silently produce `max-width: undefined`, which the browser ignores — so the page would go
    // full-bleed and look like the width bug this refresh exists to fix.
    const length = String.raw`\d+(\.\d+)?(px|rem|em|%|vw)`;
    for (const v of [
      layout.readingWidth,
      layout.narrowWidth,
      layout.gutter,
      layout.gutterNarrow,
      layout.stackBelow,
    ]) {
      expect(v).toMatch(new RegExp(`^${length}$`));
    }
    // The wide measure is fluid, so it must be a well-formed clamp(min, preferred, max) of real
    // lengths, with a pixel floor no smaller than the old fixed 1320px (the laptop layout).
    const clamp = layout.contentWidth.match(new RegExp(`^clamp\\((${length}), (${length}), (${length})\\)$`));
    expect(clamp, layout.contentWidth).not.toBeNull();
    expect(layout.contentWidth.startsWith("clamp(1320px,")).toBe(true);
  });

  it("keeps global.css in agreement with the palette it duplicates", () => {
    // global.css has to hard-code four values because CSS cannot import TypeScript: the page
    // ground on html/body, the surface + text colours inside the Chrome autofill override, and the
    // table stripe.
    // The duplication is structural, so the drift is what gets guarded. It matters more than it
    // looks: if the ground in global.css drifts from palette.ground, the page is painted one
    // colour while `avatar_bg` tells Azure to paint another, and a visible rectangle reappears
    // around the digital human — with nothing in the diff pointing at the cause.
    // Resolved from the vitest root (frontend/), not import.meta.url — under the jsdom
    // environment import.meta.url is not a file: URL and readFileSync rejects it.
    const css = readFileSync(resolve(process.cwd(), "src/styles/global.css"), "utf8");
    for (const value of [palette.ground, palette.surface, palette.text, palette.stripe]) {
      expect(
        css.toLowerCase(),
        `global.css should contain ${value} from the palette`,
      ).toContain(value.toLowerCase());
    }
  });

  it("keeps the warm neutrals warm (no cool grey leaks onto the sand ground)", () => {
    // The direction's one hard rule: no cool grey. createLightTheme leaves Fluent's own neutrals
    // (#ffffff / #fafafa / #d1d1d1) in place, so a missed override shows up as a grey patch on a
    // warm page. Warm here means red channel >= blue channel.
    const warm = (hex: string) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return r >= b;
    };
    for (const key of [
      "ground",
      "surface",
      "inset",
      "text",
      "textMuted",
      "textFaint",
      "line",
      "lineStrong",
    ] as const) {
      expect(warm(palette[key]), `${key} (${palette[key]}) should be warm`).toBe(true);
    }
  });
});
