/**
 * The app shell: one header band, one content width, for every route.
 *
 * Replaces two defects at once (docs/planning/design-ui-refresh-foundry-purple.md §1):
 *
 *  1. The old header was an inline-styled flex holding nothing but the language dropdown, with
 *     `justify-content: flex-end` — so the control floated in a ~150px dead band with no bar, no
 *     wordmark and no divider under it. It is a real banner now, and it owns the app identity, so
 *     pages no longer render their own duplicate `appTitle` heading (which also meant two <h1>s).
 *  2. Content width was decided three times independently (a 760px page column, a 420px card
 *     centred inside it, a 1400px live strip), so nothing shared a left edge and the content
 *     filled 38% of a wide screen. Width is decided HERE, once, from `layout` in theme.ts.
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { makeStyles, tokens } from "@fluentui/react-components";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { fonts, layout, palette } from "../theme";

const useStyles = makeStyles({
  root: { position: "relative", zIndex: 1, minHeight: "100vh" },

  /** `fill`: the live interview screen is pinned to exactly one viewport. A candidate mid-answer
   *  must never scroll to find the question or the controls; the transcript is the only scroller. */
  rootFill: {
    position: "relative",
    zIndex: 1,
    height: "100vh",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    // Stacked on a phone the stage + question + transcript cannot all fit, and a nested scroll
    // area on touch is worse than a long page, so the one-viewport rule is dropped there.
    [`@media (max-width: ${layout.stackBelow})`]: {
      height: "auto",
      overflow: "visible",
    },
  },

  appbar: {
    position: "relative",
    zIndex: 2,
    flexShrink: 0,
    backgroundColor: "rgba(255, 253, 249, 0.86)",
    backdropFilter: "blur(14px)",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  appbarInner: {
    maxWidth: layout.contentWidth,
    marginInline: "auto",
    paddingInline: layout.gutter,
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalL,
    height: "64px",
    [`@media (max-width: ${layout.stackBelow})`]: {
      paddingInline: layout.gutterNarrow,
      height: "auto",
      paddingBlock: tokens.spacingVerticalS,
      flexWrap: "wrap",
      gap: tokens.spacingHorizontalS,
    },
  },
  /** Wordmark + tagline read as one identity block, so they sit in one flex row with a hairline
   *  between them. The tagline used to render per page, as a small grey line floating above the
   *  content with nothing connecting it to the header — an orphan. It belongs to the app, not to
   *  any one phase, so it lives here once. */
  identity: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
    minWidth: 0,
  },
  wordmark: {
    margin: 0,
    fontFamily: fonts.display,
    fontSize: "18px",
    fontWeight: 700,
    letterSpacing: "-0.012em",
    color: palette.ink,
    whiteSpace: "nowrap",
  },
  tagline: {
    paddingLeft: tokens.spacingHorizontalM,
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    // Below the breakpoint the band wraps and the controls need the room more than the tagline
    // does; the wordmark alone still answers "what site is this".
    "@media (max-width: 760px)": { display: "none" },
  },
  spacer: { flexGrow: 1 },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
  },

  main: {
    maxWidth: layout.contentWidth,
    marginInline: "auto",
    paddingInline: layout.gutter,
    paddingBlock: tokens.spacingVerticalXXL,
    [`@media (max-width: ${layout.stackBelow})`]: {
      paddingInline: layout.gutterNarrow,
      paddingBlock: tokens.spacingVerticalXL,
    },
  },
  /** `fill`: a pure flex chain down to the children. `height: 100%` on a child of a padded flex
   *  item resolves against the PADDED box in practice, which ate the bottom gutter (measured at
   *  1px instead of 24px while building the mockup), so every level grows instead. */
  mainFill: {
    flexGrow: 1,
    minHeight: 0,
    display: "flex",
    maxWidth: layout.contentWidth,
    width: "100%",
    marginInline: "auto",
    paddingInline: layout.gutter,
    paddingBlock: tokens.spacingVerticalL,
    [`@media (max-width: ${layout.stackBelow})`]: {
      display: "block",
      flexGrow: 0,
      paddingInline: layout.gutterNarrow,
    },
  },
  fillInner: {
    flexGrow: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    [`@media (max-width: ${layout.stackBelow})`]: { display: "block" },
  },

  /** `narrow`: the sign-in form, truly centred in the viewport rather than starting after a dead
   *  band at the top (the old page opened with ~150px of nothing, then crammed everything into
   *  the upper half and left the bottom 40% empty). */
  mainNarrow: {
    minHeight: "calc(100vh - 64px)",
    display: "grid",
    placeItems: "center",
    paddingInline: layout.gutter,
    paddingBlock: tokens.spacingVerticalXXL,
    [`@media (max-width: ${layout.stackBelow})`]: {
      paddingInline: layout.gutterNarrow,
      alignItems: "start",
    },
  },
  narrowInner: { width: "100%", maxWidth: layout.narrowWidth },

  /** `reading`: prose-heavy single-column phases (orientation, review, scoring, report). */
  mainReading: {
    maxWidth: layout.readingWidth,
    marginInline: "auto",
    paddingInline: layout.gutter,
    paddingBlock: tokens.spacingVerticalXXL,
    [`@media (max-width: ${layout.stackBelow})`]: {
      paddingInline: layout.gutterNarrow,
      paddingBlock: tokens.spacingVerticalXL,
    },
  },
});

export interface AppShellProps {
  children: ReactNode;
  /** Controls shown in the header band, to the left of the language switcher. */
  actions?: ReactNode;
  /**
   * `wide` (default, 1320px) — two-column screens: admin, the agent editor.
   * `reading` (760px) — prose-heavy phases: orientation, review, scoring, report.
   * `narrow` (440px, vertically centred) — the sign-in form.
   * `fill` — pin the page to exactly one viewport (the live interview screen).
   */
  measure?: "wide" | "reading" | "narrow" | "fill";
}

export function AppShell({ children, actions, measure = "wide" }: AppShellProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  const fill = measure === "fill";

  return (
    <div className={fill ? styles.rootFill : styles.root}>
      <header className={styles.appbar}>
        <div className={styles.appbarInner}>
          <div className={styles.identity}>
            <h1 className={styles.wordmark}>{t("appTitle")}</h1>
            <span className={styles.tagline}>{t("tagline")}</span>
          </div>
          <span className={styles.spacer} />
          <div className={styles.actions}>
            {actions}
            <LanguageSwitcher />
          </div>
        </div>
      </header>

      {fill ? (
        <main className={styles.mainFill}>
          <div className={styles.fillInner}>{children}</div>
        </main>
      ) : measure === "narrow" ? (
        <main className={styles.mainNarrow}>
          <div className={styles.narrowInner}>{children}</div>
        </main>
      ) : (
        <main
          className={measure === "reading" ? styles.mainReading : styles.main}
        >
          {children}
        </main>
      )}
    </div>
  );
}
