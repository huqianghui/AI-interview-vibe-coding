/**
 * The app's design language, as Fluent tokens.
 *
 * Approved direction: "Warm Editorial / Foundry Purple" (docs/planning/design-ui-refresh-foundry-purple.md).
 * Everything visual flows from here — pages must read `tokens.*`, never a literal hex, so the
 * palette stays changeable in one place. The two values that cannot be Fluent tokens (the page
 * ground and the autofill override) live in styles/global.css next door.
 *
 * WHY NOT Azure blue: Azure's own brand blue (#0078D4) shares a hue with Fluent's default
 * #0F6CBD, which is what made the old UI read like a Windows settings page. Purple is still a
 * Microsoft family colour — all three purples below are Fluent palette entries already used for
 * the avatar swatches in data/avatarCharacters.ts — and it reads as *Azure AI* (the Foundry /
 * Copilot register) rather than Azure-the-platform. Owner decision, 2026-10-03.
 */
import {
  createLightTheme,
  type BrandVariants,
  type Theme,
} from "@fluentui/react-components";

/** Raw palette. Exported so components can reach the few values Fluent has no token for. */
export const palette = {
  /** Page ground. Also hard-coded in styles/global.css — change both together. */
  ground: "#F5F1EA",
  /** Cards, inputs, menus: the warm surface. Maps to colorNeutralBackground1. */
  surface: "#FFFDF9",
  /** Recessed fill: segmented-control track, muted rows. */
  inset: "#EBE5DA",

  /** Authority colour: headings and the wordmark. Darker than the action colour on purpose. */
  ink: "#4A2680",
  inkStrong: "#3A1D66",

  /**
   * Action colour: buttons, links, focus rings. This is the SAME value as `foundryPurple[80]`,
   * and theme.test.ts asserts they stay equal — Fluent derives colorBrandBackground and its
   * hover/pressed states from the ramp, so if the two drift the page ends up with two slightly
   * different purples (Fluent controls on one, our own makeStyles rules on the other) and nothing
   * points at the cause. Named here so a component that needs the colour directly has a token
   * instead of a literal.
   */
  action: "#5C2E91",
  actionHover: "#4A2375",
  /** The action colour at panel strength — for a surface that must read as "this is the
   *  authoritative side" without competing with the text on it (the report's SOP quote panels). */
  actionTint: "#F2ECFA",

  /** Accents. `magenta` marks "this is the live/current item"; `cyan` is reserved for LIVE. */
  violet: "#8764B8",
  magenta: "#C239B3",
  cyan: "#50E6FF",

  /** Warm neutrals. Cool greys are off-direction and must not appear. */
  text: "#241F1A",
  textMuted: "#6B6257",
  textFaint: "#9A9085",
  line: "#E0D7C9",
  lineStrong: "#CFC3B1",

  ok: "#1E7A5C",
  warn: "#9A6B1F",
  danger: "#A33D2E",

  /** Two-layer warm shadow. Flat bordered boxes are the look being replaced. */
  shadow: "0 2px 4px rgba(36,31,26,.04), 0 16px 40px -16px rgba(36,31,26,.16)",
  shadowSm: "0 1px 3px rgba(36,31,26,.07)",
} as const;

/**
 * Font stacks.
 *
 * Neither face carries CJK, so the Chinese fallback is deliberate, not accidental: Latin renders
 * in Bricolage Grotesque / Literata and Chinese renders in the platform's own PingFang SC or
 * Microsoft YaHei. The serif body stack puts PingFang SC ahead of any CJK serif so Chinese UI
 * text stays a modern sans rather than landing in Songti.
 */
export const fonts = {
  /** Headings, wordmark, buttons, labels. */
  display:
    '"Bricolage Grotesque", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, "Segoe UI", sans-serif',
  /** Prose: questions, transcript, body copy. */
  body: '"Literata", Georgia, "PingFang SC", "Microsoft YaHei", serif',
} as const;

/**
 * Brand ramp, anchored so that brand[80] is exactly the action colour #5C2E91 — createLightTheme
 * maps brand[80] to colorBrandBackground, [70] to its hover and [60] to its pressed state. The
 * lightness curve is lifted from webLightTheme's own blue ramp so every derived token (focus
 * rings, compound strokes, selected rows) behaves the way a stock Fluent ramp does.
 */
export const foundryPurple: BrandVariants = {
  10: "#150823",
  20: "#1E0C34",
  30: "#281143",
  40: "#331655",
  50: "#401D67",
  60: "#4A2376",
  70: "#552987",
  80: "#5C2E91",
  90: "#7B3DC2",
  100: "#9962D8",
  110: "#A778DD",
  120: "#B58DE2",
  130: "#C6A6EA",
  140: "#D6BEF1",
  150: "#E4D6F5",
  160: "#F5F0FB",
};

const base = createLightTheme(foundryPurple);

/**
 * The app theme: the purple ramp plus warm-neutral and typography overrides.
 *
 * createLightTheme only swaps the brand colours; its neutrals stay Fluent's cool greys
 * (#ffffff / #fafafa / #f5f5f5 / #d1d1d1), which on a warm sand ground read as a grey patch.
 * Every neutral that shows up on a surface is therefore re-pointed at a warm value.
 */
export const appTheme: Theme = {
  ...base,

  // ── Typography ───────────────────────────────────────────────────────────
  fontFamilyBase: fonts.body,

  // ── Surfaces. colorNeutralBackground1 is the CARD surface, not the page ground: the page
  //    ground is painted on html/body in global.css and the provider root is transparent.
  colorNeutralBackground1: palette.surface,
  colorNeutralBackground1Hover: "#FAF6F0",
  colorNeutralBackground1Pressed: palette.inset,
  colorNeutralBackground1Selected: "#F7F2EB",
  colorNeutralBackground2: "#F9F5EF",
  colorNeutralBackground3: palette.inset,
  colorNeutralBackground4: "#E5DED2",
  colorNeutralBackground5: "#DFD7C9",
  colorNeutralBackground6: palette.ground,
  colorNeutralBackgroundStatic: palette.inkStrong,

  colorSubtleBackground: "transparent",
  colorSubtleBackgroundHover: "#F2ECFA",
  colorSubtleBackgroundPressed: "#E9DFF7",
  colorSubtleBackgroundSelected: "#F2ECFA",

  // ── Foreground ───────────────────────────────────────────────────────────
  colorNeutralForeground1: palette.text,
  colorNeutralForeground1Hover: palette.text,
  colorNeutralForeground1Pressed: palette.text,
  colorNeutralForeground2: palette.textMuted,
  colorNeutralForeground2Hover: palette.ink,
  colorNeutralForeground2Pressed: palette.inkStrong,
  colorNeutralForeground2BrandHover: palette.ink,
  colorNeutralForeground2BrandPressed: palette.inkStrong,
  colorNeutralForeground3: palette.textFaint,
  colorNeutralForeground4: palette.textFaint,

  // ── Strokes. Fluent's #d1d1d1 is the single most obvious cool-grey leak on a warm ground.
  colorNeutralStroke1: palette.lineStrong,
  colorNeutralStroke1Hover: "#BCAE99",
  colorNeutralStroke1Pressed: "#AD9E86",
  colorNeutralStroke2: palette.line,
  colorNeutralStroke3: "#EBE5DA",
  colorNeutralStrokeAccessible: palette.textMuted,
  colorNeutralStrokeAccessibleHover: palette.ink,
  colorNeutralStrokeSubtle: palette.line,

  // ── Status colours, warmed to match ──────────────────────────────────────
  colorPaletteGreenForeground1: palette.ok,
  colorPaletteGreenBackground2: "#E9F0EB",
  colorPaletteRedForeground1: palette.danger,
  colorPaletteRedBackground2: "#FBECE9",
  colorPaletteYellowForeground2: palette.warn,

  // ── Shape. Fluent's defaults are 4/6/8px; this direction is softer throughout.
  borderRadiusSmall: "8px",
  borderRadiusMedium: "12px",
  borderRadiusLarge: "16px",
  borderRadiusXLarge: "20px",

  // ── Elevation, warmed. Fluent's shadows are neutral-black and read cold on sand.
  shadow2: palette.shadowSm,
  shadow4: palette.shadow,
  shadow8: palette.shadow,
  shadow16: "0 4px 8px rgba(36,31,26,.05), 0 24px 56px -20px rgba(36,31,26,.20)",
};

/**
 * Shared layout scale. The defect this replaces: the live app centred a 760px column, a 420px
 * card and a 1400px strip independently, so nothing shared a left edge and the content filled
 * 38% of a wide screen. ONE width, one gutter, applied by AppShell.
 */
export const layout = {
  /** Max content width for the two-column screens (live interview, admin). */
  contentWidth: "1320px",
  /**
   * Prose measure: orientation, review, scoring, report. The old app's 760px was not wrong as a
   * measure — ~75 characters is right for reading. The defect was that it was ONE of three widths
   * nested inside each other so nothing shared a left edge. Here it is a named, deliberate choice.
   */
  readingWidth: "760px",
  /** Form measure: the sign-in card. */
  narrowWidth: "440px",
  gutter: "32px",
  gutterNarrow: "16px",
  /** Breakpoint where the two-column stage stacks. */
  stackBelow: "1000px",
} as const;
