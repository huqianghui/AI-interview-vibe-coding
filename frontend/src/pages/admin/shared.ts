/** What the admin page's tabs share: styles (Fluent `makeStyles` + `tokens`, the project baseline),
 * the rubric kinds, and the error-banner guard's type. */
import { makeStyles, tokens } from "@fluentui/react-components";

export const useAdminStyles = makeStyles({
  // Width and padding moved to AppShell (one measure per route). What is left is the stack.
  page: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
  },
  // Top bar: page title on the left, cross-navigation to the persona editor on the right.
  topBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalL,
    flexWrap: "wrap",
  },
  navLink: { textDecoration: "none" },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  fieldGrid: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    maxWidth: "560px",
  },
  list: {
    listStyle: "none",
    padding: 0,
    margin: 0,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  // A bank / question row: label on the left, an aligned action cluster on the right.
  row: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground2,
  },
  rowText: { flex: 1, minWidth: "200px" },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    flexWrap: "wrap",
  },
  addRow: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    alignItems: "center",
    flexWrap: "wrap",
  },
  emptyState: { color: tokens.colorNeutralForeground3 },
  hintOk: { color: tokens.colorPaletteGreenForeground1 },
  hintWarn: { color: tokens.colorPaletteYellowForeground2 },
  // Weight-total bar under the rubric editor: fills to min(sum,100)%, green at 100 else amber.
  weightBar: {
    position: "relative",
    height: "6px",
    width: "100%",
    maxWidth: "320px",
    borderRadius: tokens.borderRadiusCircular,
    background: tokens.colorNeutralBackground3,
    overflow: "hidden",
  },
  weightBarFill: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    transition: "width 200ms ease, background 200ms ease",
  },
  checklistItem: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground2,
  },
  checklistItemRow: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    alignItems: "center",
    flexWrap: "wrap",
  },
  // Read-only SOP citation under an item (admin-only surface, P3 allows it here).
  sourceQuote: { color: tokens.colorNeutralForeground3, fontStyle: "italic" },
  errorText: { color: tokens.colorPaletteRedForeground1 },
});

// Kind → Badge color, so required / recommended / forbidden read at a glance.
export const KIND_COLOR: Record<string, "danger" | "success" | "warning" | "informative"> = {
  required: "success",
  recommended: "informative",
  forbidden: "danger",
};

export const KINDS = ["required", "recommended", "forbidden"] as const;

/** Runs an admin action and shows its error in the page's banner instead of throwing. */
export type Guard = (fn: () => Promise<void>) => Promise<void>;
