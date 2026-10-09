/** Filtering, sorting and paging one SOP library's documents, the way Interview results does it
 * (owner, 2026-10-09: same experience and design). Done in the browser: a library holds tens of
 * documents and the list is already loaded, so there is nothing for the server to page. */
import type { SopDocument } from "../../api/admin";

export type SopConversion = "pending" | "converted" | "failed";
export type SopSummaryState = "reviewed" | "draft" | "none" | "failed";

export interface SopFilters {
  name?: string;
  conversion?: SopConversion;
  status?: SopSummaryState;
}

export type SopSortKey = "name" | "sections" | "status";
export type SortOrder = "asc" | "desc";

export function conversionOf(d: SopDocument): SopConversion {
  if (d.converting || d.markdown_source === "") return "pending";
  return d.markdown_source === "failed" ? "failed" : "converted";
}

export function summaryStateOf(d: SopDocument): SopSummaryState {
  const s = d.summary_status;
  return s === "reviewed" || s === "draft" || s === "failed" ? s : "none";
}

// Status sorts by how far along the summary is: approved, draft, none, failed.
const STATUS_RANK: Record<SopSummaryState, number> = { reviewed: 0, draft: 1, none: 2, failed: 3 };

export function filterDocuments(docs: SopDocument[], f: SopFilters): SopDocument[] {
  const name = f.name?.trim().toLowerCase();
  return docs.filter(
    (d) =>
      (!name || d.name.toLowerCase().includes(name)) &&
      (!f.conversion || conversionOf(d) === f.conversion) &&
      (!f.status || summaryStateOf(d) === f.status),
  );
}

export function sortDocuments(docs: SopDocument[], key: SopSortKey, order: SortOrder) {
  const by = (d: SopDocument): string | number =>
    key === "sections" ? d.unit_count : key === "status" ? STATUS_RANK[summaryStateOf(d)] : "";
  const sign = order === "desc" ? -1 : 1;
  return [...docs].sort((a, b) => {
    const diff =
      key === "name"
        ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
        : (by(a) as number) - (by(b) as number);
    // Ties keep a stable, readable order: by name, A to Z.
    return sign * diff || a.name.localeCompare(b.name, undefined, { numeric: true });
  });
}

/** The page to show, kept inside the list when it shrinks (a filter, a delete). */
export function pageOf<T>(items: T[], page: number, pageSize: number) {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(page, pageCount - 1);
  return { page: current, rows: items.slice(current * pageSize, (current + 1) * pageSize) };
}
