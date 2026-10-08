import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { DataTable, type DataColumn } from "./DataTable";
import { fitWidths } from "./dataTableWidths";

interface Row {
  id: string;
  name: string;
  note: string;
}

const ROWS: Row[] = [
  { id: "a", name: "Al", note: "short" },
  { id: "b", name: "A much longer name than the others", note: "x".repeat(400) },
];

function renderTable(columns: DataColumn<Row>[], onRow = vi.fn()) {
  render(
    <FluentProvider theme={webLightTheme}>
      <DataTable
        testId="t"
        items={ROWS}
        columns={columns}
        getRowId={(r) => r.id}
        rowProps={(r) => ({ onClick: () => onRow(r.id), "data-testid": `row-${r.id}` })}
      />
    </FluentProvider>,
  );
  return onRow;
}

describe("DataTable", () => {
  it("starts each column at the width its content needs, within its bounds", () => {
    const perChar = (s: string) => s.length * 8;
    const [name, flag, ctl, note, sorted] = fitWidths<Row>(
      [
        { id: "name", header: "Name", text: (r) => r.name, cell: (r) => r.name },
        { id: "flag", header: "F", text: () => "y", cell: () => "y" },
        { id: "ctl", header: "", width: 180, cell: () => null },
        { id: "note", header: "Note", long: true, text: (r) => r.note, cell: (r) => r.note },
        { id: "s", header: "Name", sort: { onToggle: () => {} }, text: () => "", cell: () => null },
      ],
      ROWS,
      perChar,
    );
    expect(name).toBe(34 * 8 + 28); // the longest name, plus the cell's padding
    expect(flag).toBe(64); // never narrower than the minimum
    expect(ctl).toBe(180); // a column of controls says its width
    expect(note).toBe(440); // long text is capped, not 400 characters wide
    expect(sorted).toBe(4 * 8 + 24 + 28); // a sortable header leaves room for its arrow
  });

  it("lets every column but the last be dragged", () => {
    renderTable([
      { id: "name", header: "Name", text: (r) => r.name, cell: (r) => r.name },
      { id: "flag", header: "F", text: () => "y", cell: () => "y" },
      { id: "note", header: "Note", long: true, text: (r) => r.note, cell: (r) => r.note },
    ]);
    expect(document.querySelectorAll("th .fui-TableResizeHandle")).toHaveLength(2);
  });

  it("keeps long text to one line until clicked, without opening the row", async () => {
    const user = userEvent.setup();
    const onRow = renderTable([
      { id: "name", header: "Name", text: (r) => r.name, cell: (r) => r.name },
      { id: "note", header: "Note", long: true, text: (r) => r.note, cell: (r) => r.note },
    ]);
    const [, long] = screen.getAllByRole("button", { expanded: false });
    expect(long).toHaveAttribute("title", "x".repeat(400)); // the whole text on hover
    await user.click(long);
    expect(long).toHaveAttribute("aria-expanded", "true");
    expect(onRow).not.toHaveBeenCalled();
    await user.click(long);
    expect(long).toHaveAttribute("aria-expanded", "false");

    await user.click(screen.getByText("Al")); // a plain cell still opens its row
    expect(onRow).toHaveBeenCalledWith("a");
  });

  it("sorts from a sortable header", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderTable([
      {
        id: "name",
        header: "Name",
        sort: { direction: "ascending", onToggle, testId: "sort-name" },
        text: (r) => r.name,
        cell: (r) => r.name,
      },
    ]);
    expect(screen.getByTestId("sort-name")).toHaveAttribute("aria-sort", "ascending");
    await user.click(screen.getByTestId("sort-name"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
