import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../../i18n";
import i18n from "../../i18n";
import * as admin from "../../api/admin";
import type { SourceRef } from "../../api/admin";
import { CitationEditor } from "./CitationEditor";

const DOC: admin.SopDocument = {
  document_id: "d1", name: "Widget SOP.pdf", library_id: "lib1", status: "chunked", size: 1, chunk_count: 1,
  markdown_source: "document_intelligence", section_count: 2, markdown_error: "", converting: false,
  summary_status: "", summary_error: "", summarizing: false,
};

function renderEditor(refs: SourceRef[], onChange = vi.fn()) {
  render(
    <FluentProvider theme={webLightTheme}>
      <CitationEditor refs={refs} index={0} onChange={onChange} />
    </FluentProvider>,
  );
  return onChange;
}

describe("CitationEditor", () => {
  it("adds a section picked from a converted document, and removes one", async () => {
    await i18n.changeLanguage("en-US");
    const user = userEvent.setup();
    vi.spyOn(admin, "listSopDocuments").mockResolvedValue([
      DOC,
      { ...DOC, document_id: "d2", name: "Unconverted.pdf", section_count: 0 },
    ]);
    vi.spyOn(admin, "listSopSections").mockResolvedValue([
      { order_index: 0, number: "4", title: "RELEASE", level: 1, parent_index: null, page_start: 3, page_end: 4, full_length: 90 },
      { order_index: 1, number: "4.2", title: "Approval", level: 2, parent_index: 0, page_start: 4, page_end: 4, full_length: 40 },
    ]);
    const existing: SourceRef = {
      document_id: "d1", document_name: "Widget SOP.pdf", section: "5", title: "RECORDS", found: false,
    };
    const onChange = renderEditor([existing]);
    expect(screen.getByTestId("checklist-citations-0")).toHaveTextContent("5 RECORDS (section no longer exists)");

    await user.click(screen.getByTestId("checklist-cite-0"));
    await user.click(screen.getByTestId("checklist-cite-doc-0"));
    expect(screen.queryByRole("option", { name: "Unconverted.pdf" })).toBeNull(); // nothing to cite
    await user.click(screen.getByRole("option", { name: "Widget SOP.pdf" }));
    await user.click(await screen.findByTestId("checklist-cite-section-0"));
    await user.click(screen.getByRole("option", { name: "4.2 Approval" }));
    expect(onChange).toHaveBeenLastCalledWith([
      existing,
      expect.objectContaining({ document_id: "d1", section: "4.2", title: "Approval" }),
    ]);

    await user.click(screen.getByRole("button", { name: /5 RECORDS/ }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});
