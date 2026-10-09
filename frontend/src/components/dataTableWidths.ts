/** How the shared table (DataTable.tsx) sizes its columns before anyone drags them. */
import type { DataColumn } from "./DataTable";

// Fluent's cell padding (8px a side) plus a little air; sortable headers also show an arrow.
export const CELL_CHROME = 20;
export const SORT_ICON = 24;
export const MIN_WIDTH = 64;
export const MAX_WIDTH = 320;
export const MAX_LONG_WIDTH = 440;

/** Measures strings in a given CSS font; falls back to a per-character estimate (tests, SSR). */
export function makeMeasure(font: string | null): (s: string) => number {
  const ctx =
    font && typeof document !== "undefined"
      ? (() => {
          try {
            return document.createElement("canvas").getContext("2d");
          } catch {
            return null;
          }
        })()
      : null;
  if (ctx && font) {
    ctx.font = font;
    return (s) => ctx.measureText(s).width;
  }
  return (s) => s.length * 7.5;
}

/** Each column's starting width: its header and longest cell text, between its bounds. */
export function fitWidths<T>(
  columns: DataColumn<T>[],
  items: T[],
  measure: (s: string) => number,
): number[] {
  return columns.map((c) => {
    const min = c.minWidth ?? MIN_WIDTH;
    if (c.width != null) return Math.max(c.width, min);
    const max = c.maxWidth ?? (c.long ? MAX_LONG_WIDTH : MAX_WIDTH);
    const head = typeof c.header === "string" ? c.header : (c.headerText ?? "");
    let need = measure(head) + (c.sort ? SORT_ICON : 0);
    if (c.text) for (const it of items) need = Math.max(need, measure(c.text(it)));
    return Math.round(Math.min(max, Math.max(min, need + CELL_CHROME + (c.pad ?? 0))));
  });
}

