import { describe, expect, it } from "vitest";
import type { SopDocument } from "../../api/admin";
import { filterDocuments, pageOf, sortDocuments } from "./sopTable";

const doc = (name: string, over: Partial<SopDocument> = {}): SopDocument => ({
  document_id: name, name, library_id: "l", status: "chunked", size: 1, chunk_count: 1,
  markdown_source: "document_intelligence", section_count: 1, unit_count: 1, markdown_error: "",
  converting: false, summary_status: "", summary_error: "", summarizing: false, ...over,
});

describe("sopTable", () => {
  const docs = [
    doc("SOP 10.pdf", { section_count: 5, unit_count: 5, summary_status: "reviewed" }),
    doc("SOP 2.pdf", { section_count: 5, unit_count: 5, summary_status: "draft" }),
    doc("Plan.docx", { markdown_source: "failed", section_count: 0 }),
    doc("New.pdf", { markdown_source: "", converting: true, section_count: 0 }),
  ];

  it("filters by name (any case), conversion and summary status together", () => {
    expect(filterDocuments(docs, { name: "sop" }).map((d) => d.name)).toEqual(["SOP 10.pdf", "SOP 2.pdf"]);
    expect(filterDocuments(docs, { conversion: "failed" }).map((d) => d.name)).toEqual(["Plan.docx"]);
    expect(filterDocuments(docs, { conversion: "pending" }).map((d) => d.name)).toEqual(["New.pdf"]);
    expect(filterDocuments(docs, { name: "sop", status: "reviewed" }).map((d) => d.name)).toEqual([
      "SOP 10.pdf",
    ]);
    expect(filterDocuments(docs, { status: "none" })).toHaveLength(2);
  });

  it("sorts names as people read them and breaks ties by name in either direction", () => {
    expect(sortDocuments(docs, "name", "asc").map((d) => d.name)).toEqual([
      "New.pdf", "Plan.docx", "SOP 2.pdf", "SOP 10.pdf",
    ]);
    expect(sortDocuments(docs, "sections", "desc").map((d) => d.name)).toEqual([
      "SOP 2.pdf", "SOP 10.pdf", "New.pdf", "Plan.docx",
    ]);
    expect(sortDocuments(docs, "status", "asc")[0].name).toBe("SOP 10.pdf"); // approved first
  });

  it("keeps the page inside the list when the list shrinks", () => {
    const items = Array.from({ length: 45 }, (_, i) => i);
    expect(pageOf(items, 2, 20)).toEqual({ page: 2, rows: [40, 41, 42, 43, 44] });
    expect(pageOf(items.slice(0, 10), 2, 20)).toEqual({ page: 0, rows: items.slice(0, 10) });
    expect(pageOf([], 3, 20)).toEqual({ page: 0, rows: [] });
  });
});

describe("page sizes", () => {
  it("offers 5 and 10 as well, and defaults to 20 (owner, 2026-10-09)", async () => {
    const { PAGE_SIZES, DEFAULT_PAGE_SIZE } = await import("../../components/tableToolbar");
    expect(PAGE_SIZES).toEqual([5, 10, 20, 50, 100]);
    expect(DEFAULT_PAGE_SIZE).toBe(20);
  });
});
