/** Shared by every filtered, paged admin table (see TablePager): page sizes and the toolbar's
 * layout (filter fields above the table, the pager line below it). */
import { makeStyles, tokens } from "@fluentui/react-components";

export const PAGE_SIZES = [20, 50, 100] as const;

export const useTableToolbarStyles = makeStyles({
  filters: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 200px), 1fr))",
    gap: tokens.spacingHorizontalM,
    alignItems: "end",
    marginBottom: tokens.spacingVerticalL,
  },
  // A select sizes itself to its longest option by default; a long bank or interviewer name then
  // spilled over the next filter (seen at 2000px). Each filter fits its grid cell instead.
  filter: { minWidth: 0 },
  control: { minWidth: 0, width: "100%" },
  pager: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalM,
    marginTop: tokens.spacingVerticalM,
  },
  pagerControls: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    whiteSpace: "nowrap",
  },
  // Pager labels keep their full width; the page-size select is what may narrow.
  pagerText: { flexShrink: 0, overflow: "visible" },
});
