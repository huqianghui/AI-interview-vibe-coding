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
  markdown_source: "document_intelligence", section_count: 2, unit_count: 2, markdown_error: "", converting: false,
  summary_status: "", summary_error: "", summarizing: false,
};

function renderEditor(refs: SourceRef[], onChange = vi.fn()) {
  render(
    <FluentProvider theme={webLightTheme}>
      <CitationEditor refs={refs} index={0} onChange={onChange} libraryId="lib1" />
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
      { ...DOC, document_id: "d3", name: "Other library.pdf", library_id: "lib2" },
    ]);
    // The picker offers units, the same set the SOP tab shows (owner, 2026-10-09).
    vi.spyOn(admin, "listSopUnits").mockResolvedValue([
      {
        index: 0, label: "1–3 PURPOSE / SCOPE / RECORDS", page_start: 1, page_end: 2, length: 900,
        section: "1", through: "3", own: false, members: ["1", "2", "3"],
      },
      {
        index: 1, label: "4.2 Approval", page_start: 4, page_end: 4, length: 1200,
        section: "4.2", through: "", own: false, members: ["4.2"],
      },
    ]);
    const existing: SourceRef = {
      document_id: "d1", document_name: "Widget SOP.pdf", section: "5", title: "RECORDS", found: false,
    };
    const onChange = renderEditor([existing]);
    expect(screen.getByTestId("checklist-citations-0")).toHaveTextContent("5 RECORDS (section no longer exists)");

    await user.click(screen.getByTestId("checklist-cite-0"));
    await user.click(screen.getByTestId("checklist-cite-doc-0"));
    expect(screen.queryByRole("option", { name: "Unconverted.pdf" })).toBeNull(); // nothing to cite
    // Only the bank's own SOP library can be cited (spec-sop-libraries).
    expect(screen.queryByRole("option", { name: "Other library.pdf" })).toBeNull();
    await user.click(screen.getByRole("option", { name: "Widget SOP.pdf" }));
    await user.click(await screen.findByTestId("checklist-cite-section-0"));
    await user.click(screen.getByRole("option", { name: "4.2 Approval" }));
    expect(onChange).toHaveBeenLastCalledWith([
      existing,
      expect.objectContaining({ document_id: "d1", section: "4.2", title: "Approval" }),
    ]);
    // A merged unit is cited as one run, and its chip is named by the run.
    await user.click(screen.getByTestId("checklist-cite-0"));
    await user.click(screen.getByTestId("checklist-cite-doc-0"));
    await user.click(screen.getByRole("option", { name: "Widget SOP.pdf" }));
    await user.click(await screen.findByTestId("checklist-cite-section-0"));
    await user.click(screen.getByRole("option", { name: "1–3 PURPOSE / SCOPE / RECORDS" }));
    const run = onChange.mock.lastCall?.[0].at(-1);
    expect(run).toEqual(
      expect.objectContaining({ section: "1", through: "3", title: "PURPOSE / SCOPE / RECORDS" }),
    );
    expect(run).not.toHaveProperty("part");

    await user.click(screen.getByRole("button", { name: /5 RECORDS/ }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});
