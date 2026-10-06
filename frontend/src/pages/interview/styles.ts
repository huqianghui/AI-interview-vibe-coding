/** The interview page's styles (Fluent `makeStyles` + `tokens`) and the status legend's palette. */
import { makeStyles, tokens } from "@fluentui/react-components";
import { palette } from "../../theme";
import type { AudioState } from "../../types/voice";

export const useInterviewStyles = makeStyles({
  // Stack for the non-live phases (idle / orientation / scoring / report). WIDTH AND PADDING ARE
  // NOT SET HERE any more: this used to be `maxWidth: 760px; margin: 0 auto; padding: 24px`, and
  // because LoginCard centred its own 420px box inside it, the page title and the card ended up on
  // two different left edges. AppShell decides the measure for every route now.
  page: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
  },
  // An action row inside a Card. Fluent's Card stretches its children, so every in-card button
  // needs a row wrapper or it renders full-width by accident.
  cardActions: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
  },
  // Status legend under the header: the four voice states side by side, with the LIVE one lifted out of
  // the dimmed row and explaining itself. Only the active state carries its sentence — see the comment
  // at the render site for the measurement that decided it.
  statusLegend: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
    // No width/margin here: AppShell owns the measure. This strip used to centre itself at 1400px
    // while the same route's other phases centred at 760px.
    marginBottom: tokens.spacingVerticalL,
    flexShrink: 0,
  },
  statusItem: {
    display: "flex",
    alignItems: "flex-start",
    gap: tokens.spacingHorizontalS,
    flex: "1 1 200px",
    minWidth: "180px",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground2,
    // Inactive states recede; the active one is restored to full presence below.
    opacity: 0.55,
    // On a phone the four cards stack, so the three inactive ones cost about 150px of the first screen
    // and push the question the candidate was just asked into the bottom third (measured at 390px
    // wide). A narrow screen cannot usefully show a four-state reference strip anyway, so it shows the
    // live state only. The strip keeps its educational job where there is room for it.
    "@media (max-width: 900px)": {
      display: "none",
    },
    transition:
      "opacity 200ms ease, border-color 200ms ease, box-shadow 200ms ease",
  },
  statusItemActive: {
    // Overrides the narrow-screen hide above: whatever the width, the live state is shown.
    "@media (max-width: 900px)": {
      display: "flex",
    },
    opacity: 1,
    border: `1px solid ${tokens.colorBrandStroke1}`,
    boxShadow: tokens.shadow4,
    background: tokens.colorNeutralBackground1,
  },
  statusDot: {
    flexShrink: 0,
    width: "10px",
    height: "10px",
    borderRadius: tokens.borderRadiusCircular,
    marginTop: "5px",
  },
  statusTextCol: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    minWidth: 0,
  },
  statusItemLabel: {
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  statusItemTip: {
    color: tokens.colorNeutralForeground3,
    lineHeight: tokens.lineHeightBase200,
  },
  // Live Q&A body: status strip, global top bar, then the two-column stage.
  stageWrap: {
    // Padding, width and the `calc(100vh - 56px)` height all moved to AppShell's `fill` measure —
    // the one-viewport rule belongs to the shell, not to this page, so the admin and agent-editor
    // routes cannot drift to a different answer. This is now purely the vertical stack.
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    flex: 1,
  },
  // Global top bar (P11 rule #3): progress + live voice state + channel switch, spanning the full
  // width above both columns. Frosted-glass surface so it reads as a control strip, not content.
  topBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalL,
    flexWrap: "wrap",
    marginBottom: tokens.spacingVerticalL,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalXL}`,
    boxSizing: "border-box",
    borderRadius: tokens.borderRadiusXLarge,
    // Re-tinted onto the approved purple ramp (the old literal rgba(124,58,237) was a one-off
    // violet that belonged to no palette). Kept as a gradient so the bar still reads as a control
    // strip rather than content.
    background: `linear-gradient(135deg, ${palette.violet}1A 0%, ${palette.magenta}0D 100%)`,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backdropFilter: "blur(10px)",
    boxShadow: tokens.shadow4,
    flexShrink: 0,
  },
  topBarSlot: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
    minWidth: 0,
  },
  // The progress slot grows to fill the bar so the rail spreads across the whole row; the channel
  // switch on the right keeps its natural width.
  topBarGrow: { flex: 1, minWidth: "240px" },
  topBarRight: { justifyContent: "flex-end", flexShrink: 0 },
  // Segmented text/voice switch — one pill, two halves.
  segmented: {
    display: "inline-flex",
    padding: "3px",
    gap: "2px",
    borderRadius: tokens.borderRadiusCircular,
    background: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  segBtn: { borderRadius: tokens.borderRadiusCircular, minWidth: "84px" },
  grid: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 3fr) minmax(380px, 2fr)",
    // minmax(0, 1fr), NOT the default `auto` row: an auto row is sized from its content FIRST, so
    // a long transcript pushed the row past the available height and both columns overflowed the
    // viewport (measured at 23px while building the mockup, with the bottom gutter down to 1px).
    // Capping the row makes the transcript's own scroller absorb the overflow instead.
    gridTemplateRows: "minmax(0, 1fr)",
    gap: tokens.spacingHorizontalXXL,
    alignItems: "stretch",
    // Width comes from AppShell; this used to centre itself at 1400px independently.
    flex: 1,
    minHeight: 0,
    "@media (max-width: 900px)": {
      gridTemplateColumns: "1fr",
      gridTemplateRows: "auto",
    },
    // Matches AppShell's height escape (max-height: 560px): once the page is allowed to scroll,
    // capping the row would still squeeze the question card against a height the page no longer
    // has to respect. Let it size from content instead.
    "@media (max-height: 560px)": { gridTemplateRows: "auto" },
  },
  // Below the breakpoint the two columns stack, and the stage comes first in DOM order — which put the
  // question's TEXT entirely off screen on a phone (measured: 144px off a 390x844 iPhone, 76px off a
  // 899px-wide desktop window, so this is a narrow-viewport problem and not a phone one). The question
  // a candidate was just asked is the one thing they must be able to read without scrolling, and the
  // digital human does not need watching while they answer. Order only; the desktop two-column layout,
  // where both fit comfortably, is untouched.
  stageOrderNarrow: {
    "@media (max-width: 900px)": { order: 2 },
  },
  controlsOrderNarrow: {
    "@media (max-width: 900px)": { order: 1 },
  },
  // Left: the dark "stage" the digital human / orb sits on.
  stage: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    // Adapt to the grid's height (bounded by the viewport-height stageWrap) instead of a fixed
    // 560px that forced the stage taller than the screen. minHeight:0 lets flex shrink it.
    minHeight: 0,
    height: "100%",
    // border-box so the vertical padding is INCLUDED in height:100% — otherwise the stage renders
    // (row height + 40px padding), overflowing the viewport (cropping the figure's legs) and
    // standing 40px taller than the right column. With border-box it matches the column exactly.
    boxSizing: "border-box",
    // NO frame (owner rule 2026-09-24: "inner and outer frame one colour, or no outer frame"): the
    // stage is a transparent layout box; AvatarView sizes ITSELF to the stream's exact aspect and
    // carries the rounded corners + shadow, so the digital human is the only surface on screen.
    background: "transparent",
    overflow: "hidden",
    padding: 0,
    "@media (max-width: 900px)": { minHeight: "360px" },
  },
  stageAvatar: {
    width: "100%",
    flex: 1,
    display: "flex",
    // TOP-aligned, not centred (owner, 2026-10-02: "it needs to line up with the question"). The
    // avatar box is sized to the stream's exact aspect by `AvatarView`, so centring it left a gap
    // above the figure and the stage started ~96px BELOW the question card on the right — the two
    // columns visibly disagreed about where the content began. Flex-start puts the top edge of the
    // media on the same line as the card's top. Horizontal centring is kept.
    alignItems: "flex-start",
    justifyContent: "center",
  },
  // Right: the control column — a flex column so the transcript can grow to fill leftover height.
  controls: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
    minWidth: 0,
    minHeight: 0,
    // SAFETY NET, and it is load-bearing. Capping the grid row at minmax(0, 1fr) stops a long
    // transcript from pushing the columns past the viewport, but a capped row plus the shell's
    // `overflow: hidden` means anything that still does not fit is not cramped, it is CLIPPED AND
    // UNREACHABLE. CI caught exactly that: at Playwright's 1280x720 the resumed interview (whose
    // transcript already holds the first answer) pushed the answer textarea out of the row, and
    // `candidate-interview.spec.ts:171` could not see it. The transcript shrinking is the intended
    // relief valve (see transcriptFill), but it cannot cover the case where the question card and
    // the answer controls alone exceed the row. Letting this column scroll means the question and
    // the answer box are always reachable, whatever the viewport.
    overflowY: "auto",
  },
  questionCard: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
  },
  questionEyebrow: {
    color: tokens.colorBrandForeground1,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  questionText: {
    fontSize: tokens.fontSizeBase600,
    lineHeight: tokens.lineHeightBase600,
    fontWeight: tokens.fontWeightSemibold,
  },
  // Wrapper that lets the transcript flex-grow and scroll internally (auto-fit, no fixed height).
  transcriptFill: {
    flex: 1,
    // Was a hard `minHeight: 120px`, which fought the whole point of capping the grid row: the
    // transcript is the column's relief valve (P11 rule #4 — transcript is SECONDARY to the
    // question and the controls), and a floor stops it relieving anything. It keeps a comfortable
    // 120px wherever there is room via flex-basis, but it is now allowed to collapse rather than
    // squeeze the answer box out of a short viewport.
    flexBasis: "120px",
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
  fallbackNote: {
    display: "block",
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
  },
  voiceControls: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  // BUTTONS ONLY — nothing else goes in this row. The video cooldown reason used to render as a
  // sibling BETWEEN the buttons, and on a weak network that text stole enough horizontal space to
  // force "Turn on video" and "I'm done answering" to wrap onto two lines: the controls visibly
  // changed shape at the exact moment the candidate needed them to be familiar (owner, 2026-10-02 —
  // the buttons must not change at all). The reason now renders BELOW the row. `wrap` plus the
  // per-button `flexShrink: 0` / `nowrap` below make the old failure structurally impossible rather
  // than merely absent: anything added here moves to a new line instead of squeezing a button.
  voiceButtons: { display: "flex", flexWrap: "wrap", gap: tokens.spacingHorizontalS },
  voiceButton: { flexShrink: 0, whiteSpace: "nowrap" },
  // The cooldown reason, on its own line under the buttons. Deliberately NOT red: this is a wait,
  // not a fault — the automation is working as designed and the picture comes back on its own, so
  // the error colour would claim something is broken. Same reasoning as AvatarView refusing to reuse
  // the `voiceUnavailable` path for a media downgrade.
  voiceHint: { color: tokens.colorNeutralForeground3 },
  // External-brain (Phase 2) awaiting overlay: a quiet "interviewer is thinking" row shown in place
  // of the answer inputs while the next turn is produced, so the candidate waits instead of typing.
  externalThinking: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
  },
  // Recovery block: a stalled external turn the candidate clears with an explicit 恢复.
  recoveryBlock: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorPaletteYellowBorderActive}`,
    background: tokens.colorNeutralBackground2,
  },
});

/** Dot color per state for the status legend, matching each state's semantic hue. */
export const STATUS_DOT_COLOR: Record<AudioState, string> = {
  idle: tokens.colorBrandForeground1,
  listening: tokens.colorPaletteBlueForeground2,
  speaking: tokens.colorPaletteGreenForeground1,
  muted: tokens.colorNeutralForeground3,
};

/** Order the four states read left-to-right in the legend. */
export const STATUS_ORDER: AudioState[] = ["idle", "listening", "speaking", "muted"];

