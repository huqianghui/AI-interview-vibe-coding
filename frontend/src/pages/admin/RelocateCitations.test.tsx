import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../../i18n";
import i18n from "../../i18n";
import * as admin from "../../api/admin";
import { RELOCATE_POLL_MS, RelocateCitations } from "./RelocateCitations";

const DONE: admin.CitationRun = {
  run_id: "r1", status: "done", done: 2, total: 2, error: "", created_at: null,
  rows: [
    {
      question_no: 1, question: "Q?", item: "Gets sign-off",
      old: { document_name: "Widget SOP.pdf", quote: "Widget SOP section 4.2" },
      new: { sections: [{ document_name: "Widget SOP.pdf", section: "4.2", title: "Approval" }], quote: "Sign within 24 hours." },
      how: "label",
    },
    {
      question_no: 1, question: "Q?", item: "Speaks with confidence",
      old: { document_name: "", quote: "SOP Handbook" },
      new: { sections: [], quote: "" },
      how: "none",
    },
  ],
};

describe("RelocateCitations", () => {
  it("runs in the background, then shows each item's old and new citation", async () => {
    await i18n.changeLanguage("en-US");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const get = vi.spyOn(admin, "getCitationRun").mockResolvedValue(null);
      const post = vi
        .spyOn(admin, "relocateCitations")
        .mockResolvedValue({ ...DONE, status: "running", done: 0, rows: [] });
      const onDone = vi.fn();
      const onOpenQuestion = vi.fn();
      render(
        <FluentProvider theme={webLightTheme}>
          <RelocateCitations bankId="b1" onDone={onDone} onOpenQuestion={onOpenQuestion} />
        </FluentProvider>,
      );
      await user.click(await screen.findByTestId("relocate-start"));
      expect(post).toHaveBeenCalledWith("b1", false);
      expect(screen.getByTestId("relocate-start")).toHaveTextContent("Relocating… 0 / 2");

      get.mockResolvedValue(DONE);
      await vi.advanceTimersByTimeAsync(RELOCATE_POLL_MS);
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId("relocate-summary")).toHaveTextContent(
        "2 items: 1 from their label, 0 found by search, 1 with no SOP found, 0 on a subject the SOPs do not cover, 0 failed, 0 edited",
      );
      // The results open in the drawer, not on the page; what needs a decision comes first.
      const drawer = await screen.findByTestId("relocate-drawer");
      const attention = screen.getByTestId("relocate-attention");
      expect(drawer).toContainElement(attention);
      expect(attention).toHaveTextContent("SOP Handbook");
      expect(attention).toHaveTextContent("No SOP found");
      expect(attention).not.toHaveTextContent("Gets sign-off");
      // The question is the first column, then the rubric item.
      const headers = Array.from(attention.querySelectorAll("th")).map((h) => h.textContent);
      expect(headers.slice(0, 2)).toEqual(["Question", "Rubric item"]);
      expect(attention.querySelector("tbody td")).toHaveTextContent("1. Q?");

      // The other items are collapsed when something needs attention, and open on a click.
      expect(screen.queryByTestId("relocate-rows")).toBeNull();
      await user.click(screen.getByTestId("relocate-rows-toggle"));
      expect(screen.getByTestId("relocate-rows")).toHaveTextContent(
        "Widget SOP.pdf · 4.2 Approval — “Sign within 24 hours.”",
      );

      // "Open in editor" closes the drawer and hands over the row.
      await user.click(
        screen.getAllByRole("button", { name: "Open in editor" })[0],
      );
      expect(onOpenQuestion).toHaveBeenCalledWith(DONE.rows[1]);
      await waitFor(() => expect(screen.queryByTestId("relocate-attention")).toBeNull());
      // ...and the summary on the page reopens it.
      await user.click(screen.getByTestId("relocate-show"));
      expect(await screen.findByTestId("relocate-attention")).toBeInTheDocument();
      await user.click(screen.getByTestId("relocate-close"));
      await waitFor(() => expect(screen.queryByTestId("relocate-attention")).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows nothing once the results have been published", async () => {
    await i18n.changeLanguage("en-US");
    vi.spyOn(admin, "getCitationRun").mockResolvedValue({ ...DONE, published: true });
    render(
      <FluentProvider theme={webLightTheme}>
        <RelocateCitations bankId="b1" onDone={vi.fn()} onOpenQuestion={vi.fn()} />
      </FluentProvider>,
    );
    expect(await screen.findByTestId("relocate-fresh")).toBeInTheDocument(); // the run loaded
    expect(screen.queryByTestId("relocate-summary")).toBeNull();
    expect(screen.queryByTestId("relocate-drawer")).toBeNull();
  });

  it("says why a run failed", async () => {
    await i18n.changeLanguage("en-US");
    vi.spyOn(admin, "getCitationRun").mockResolvedValue({ ...DONE, status: "failed", error: "interrupted", rows: [] });
    render(
      <FluentProvider theme={webLightTheme}>
        <RelocateCitations bankId="b1" onDone={vi.fn()} onOpenQuestion={vi.fn()} />
      </FluentProvider>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Relocation failed: interrupted");
  });
});
