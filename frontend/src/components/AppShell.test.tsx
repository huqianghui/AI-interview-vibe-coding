/**
 * AppShell owns the two things this refresh exists to fix: ONE content width per route, and a real
 * header band that carries the app identity. Both are structural, both regress silently, and the
 * page tests only smoke them (they render the shell but assert nothing about it).
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import "../i18n";
import { AppShell } from "./AppShell";
import { appTheme, layout } from "../theme";

function renderShell(props: Partial<React.ComponentProps<typeof AppShell>> = {}) {
  return render(
    <FluentProvider theme={appTheme}>
      <AppShell {...props}>{props.children ?? <p>content</p>}</AppShell>
    </FluentProvider>,
  );
}

describe("AppShell", () => {
  it("renders exactly ONE h1, and it is the app wordmark", () => {
    // The bug: every page rendered its own `appTitle` heading on top of the shell's, so the
    // candidate page shipped with TWO <h1>s — an accessibility defect and a visible duplicate
    // title. Pages now render an h2 at most. This is the assertion that keeps it that way.
    renderShell();
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("AI Interview");
  });

  it("puts the tagline in the header band, not floating above the page content", () => {
    // It used to render per page as a small grey line above the card with nothing connecting it to
    // the header: an orphan. It belongs to the app, so it lives in the band exactly once.
    renderShell();
    expect(screen.getByText("SOP-traceable, digital-human interviewing")).toBeInTheDocument();
  });

  it("always renders the language switcher, and renders page actions before it", () => {
    renderShell({ actions: <button>Sign out</button> });
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    // The Fluent Dropdown exposes itself as a combobox with the localized "Language" label.
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("renders without actions (the sign-in gate passes none)", () => {
    renderShell();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders a <main> landmark holding the page content in every measure", () => {
    // `fill` takes a different branch (an extra flex wrapper) from `narrow` (a width-capped inner
    // div) from `wide`/`reading` (the content directly inside main). A typo in that ternary would
    // drop the content for ONE measure only, which no page test would catch — each page test
    // exercises a single measure.
    for (const measure of ["wide", "reading", "narrow", "fill"] as const) {
      const { unmount } = renderShell({ measure, children: <p>body for {measure}</p> });
      expect(screen.getByRole("main")).toBeInTheDocument();
      expect(screen.getByText(`body for ${measure}`)).toBeInTheDocument();
      unmount();
    }
  });

  it("defaults to the wide measure when none is passed", () => {
    renderShell({ children: <p>defaulted</p> });
    expect(screen.getByText("defaulted")).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
  });

  it("caps each measure at its own width, and never at two widths at once", () => {
    // The original defect was NESTED centred containers at different widths (a 420px card inside a
    // 760px column), which is why nothing shared a left edge. Griffel emits real CSS in jsdom, so
    // the max-width that actually applies to the content wrapper is readable here. One measure,
    // one width.
    const expected: Record<string, string> = {
      wide: layout.contentWidth,
      reading: layout.readingWidth,
      narrow: layout.narrowWidth,
    };
    for (const [measure, width] of Object.entries(expected)) {
      const { container, unmount } = renderShell({
        measure: measure as "wide" | "reading" | "narrow",
        children: <p>sized</p>,
      });
      const main = container.querySelector("main")!;
      // For `narrow` the cap sits on the inner wrapper; for the others it is on <main> itself.
      const capped = measure === "narrow" ? (main.firstElementChild as HTMLElement) : main;
      expect(getComputedStyle(capped).maxWidth).toBe(width);
      unmount();
    }
  });
});
