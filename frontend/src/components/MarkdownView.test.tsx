import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownView } from "./MarkdownView";
import { prepareMarkdown } from "./markdownText";

describe("MarkdownView", () => {
  it("renders headings, lists, pipe tables and task lists", () => {
    const { container } = render(
      <MarkdownView
        testId="md"
        text={[
          "## 4.2 Release",
          "",
          "- Inspect the widget",
          "- Sign the log",
          "",
          "| Role | Task |",
          "| --- | --- |",
          "| Inspector | Checks |",
          "",
          "- [x] Signed",
          "- [ ] Archived",
        ].join("\n")}
      />,
    );
    expect(screen.getByRole("heading", { name: "4.2 Release" })).toBeInTheDocument();
    expect(container.querySelectorAll("li")).toHaveLength(4);
    expect(screen.getByRole("table")).toHaveTextContent("InspectorChecks");
    const boxes = container.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    expect([...boxes].map((b) => b.checked)).toEqual([true, false]);
  });

  it("renders Document Intelligence's HTML tables with merged cells", () => {
    render(
      <MarkdownView
        text={
          "<table><tr><th colspan=\"2\">Approvals</th></tr>" +
          "<tr><td>QA</td><td>Head of QA</td></tr></table>"
        }
      />,
    );
    const header = screen.getByRole("columnheader", { name: "Approvals" });
    expect(header).toHaveAttribute("colspan", "2");
    expect(screen.getByRole("cell", { name: "Head of QA" })).toBeInTheDocument();
  });

  it("strips scripts, handlers and javascript links from uploaded text", () => {
    const { container } = render(
      <MarkdownView
        text={
          '<script>alert(1)</script><img src="x" onerror="alert(1)">' +
          '<a href="javascript:alert(1)">bad</a> ok'
        }
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent("ok");
  });

  it("turns DI's page breaks into a rule, drops its comments and shows its selection marks", () => {
    expect(prepareMarkdown("a\n<!-- PageBreak -->\nb :selected: c :unselected:")).toBe(
      "a\n\n\n---\n\n\nb ☒ c ☐",
    );
    expect(prepareMarkdown(":selected: Done\n:unselected: Open")).toBe("- [x] Done\n- [ ] Open");
    const { container } = render(
      <MarkdownView text={'<!-- PageHeader="Number: DOC-001" -->\n\nBody\n\n<!-- PageBreak -->\n\nNext'} />,
    );
    expect(container).not.toHaveTextContent("PageHeader");
    expect(container.querySelector("hr")).not.toBeNull();
  });

  it("keeps a document's single line breaks", () => {
    const { container } = render(<MarkdownView text={"2.1\nInspector:"} />);
    expect(container.querySelector("br")).not.toBeNull();
  });
});
