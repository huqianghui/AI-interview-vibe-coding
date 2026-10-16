/** How the shared table (DataTable.tsx) sorts the rows it was given, when its owner does not.
 *
 * A column sorts by its `sortValue`, else by its `text` (owner, 2026-10-16: every column that shows
 * something can be sorted). Text compares the way people read it ("SOP 2" before "SOP 10"),
 * numbers as numbers. Blanks (nothing, "", or the "—" the app shows for nothing) sort last in both
 * directions, so a sorted table never opens on empty cells. Equal rows keep the order they came
 * in. */
import type { DataColumn } from "./DataTable";

export type SortOrder = "asc" | "desc";
export type SortValue = string | number | null | undefined;

/** The value a column sorts by, or null when it cannot be sorted (a column of controls). */
export function sortValueOf<T>(c: DataColumn<T>): ((item: T) => SortValue) | null {
  if (c.sortable === false) return null;
  return c.sortValue ?? c.text ?? null;
}

const blank = (v: SortValue) => v == null || v === "" || v === "—" || Number.isNaN(v);

/** Numbers start largest first (newest, highest score); text starts A to Z. */
export function firstOrder<T>(items: T[], value: (item: T) => SortValue): SortOrder {
  const first = items.map(value).find((v) => !blank(v));
  return typeof first === "number" ? "desc" : "asc";
}

export function sortRows<T>(items: T[], value: (item: T) => SortValue, order: SortOrder): T[] {
  const sign = order === "desc" ? -1 : 1;
  return items
    .map((item, index) => ({ item, index, v: value(item) }))
    .sort((a, b) => {
      const ab = blank(a.v);
      const bb = blank(b.v);
      if (ab || bb) return ab === bb ? a.index - b.index : ab ? 1 : -1;
      const diff =
        typeof a.v === "number" && typeof b.v === "number"
          ? a.v - b.v
          : String(a.v).localeCompare(String(b.v), undefined, {
              numeric: true,
              sensitivity: "base",
            });
      return sign * diff || a.index - b.index;
    })
    .map((r) => r.item);
}
