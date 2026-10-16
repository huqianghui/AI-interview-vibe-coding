import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { DataTable, type DataColumn } from "./DataTable";
import { CELL_CHROME, fitWidths } from "./dataTableWidths";

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
    expect(name).toBe(34 * 8 + CELL_CHROME); // the longest name, plus the cell's padding
    expect(flag).toBe(64); // never narrower than the minimum
    expect(ctl).toBe(180); // a column of controls says its width
    expect(note).toBe(440); // long text is capped, not 400 characters wide
    expect(sorted).toBe(4 * 8 + 24 + CELL_CHROME); // a sortable header leaves room for its arrow
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

  it("sorts its own rows from any column with text, and flips on a second click", async () => {
    const user = userEvent.setup();
    const rows = [
      { id: "1", name: "SOP 10", n: 3 },
      { id: "2", name: "—", n: 9 },
      { id: "3", name: "SOP 2", n: null },
    ];
    render(
      <FluentProvider theme={webLightTheme}>
        <DataTable
          testId="t"
          items={rows}
          getRowId={(r) => r.id}
          rowProps={(r) => ({ "data-testid": `row-${r.id}` })}
          columns={[
            { id: "name", header: "Name", text: (r) => r.name, cell: (r) => r.name },
            {
              id: "n",
              header: "N",
              text: (r) => String(r.n ?? "—"),
              sortValue: (r) => r.n,
              cell: (r) => r.n,
            },
            { id: "ctl", header: "", width: 80, cell: () => null },
            { id: "op", header: "Op", sortable: false, text: (r) => r.id, cell: (r) => r.id },
          ]}
        />
      </FluentProvider>,
    );
    const order = () =>
      screen.getAllByTestId(/^row-/).map((r) => r.getAttribute("data-testid")?.slice(4));
    expect(order()).toEqual(["1", "2", "3"]); // as given until a header is clicked
    expect(screen.queryByTestId("t-sort-ctl")).toBeNull(); // controls have nothing to sort by
    expect(screen.queryByTestId("t-sort-op")).toBeNull(); // opted out

    await user.click(screen.getByTestId("t-sort-name"));
    expect(screen.getByTestId("t-sort-name")).toHaveAttribute("aria-sort", "ascending");
    expect(order()).toEqual(["3", "1", "2"]); // "SOP 2" before "SOP 10"; the blank "—" last
    await user.click(screen.getByTestId("t-sort-name"));
    expect(screen.getByTestId("t-sort-name")).toHaveAttribute("aria-sort", "descending");
    expect(order()).toEqual(["1", "3", "2"]); // reversed, the blank still last

    await user.click(screen.getByTestId("t-sort-n")); // a number starts largest first
    expect(screen.getByTestId("t-sort-n")).toHaveAttribute("aria-sort", "descending");
    expect(screen.getByTestId("t-sort-name")).not.toHaveAttribute("aria-sort", "ascending");
    expect(order()).toEqual(["2", "1", "3"]);
    await user.click(screen.getByTestId("t-sort-n"));
    expect(order()).toEqual(["1", "2", "3"]);
  });

  it("leaves sorting to the owner once any column has its own sort", () => {
    renderTable([
      {
        id: "name",
        header: "Name",
        sort: { onToggle: () => {}, testId: "sort-name" },
        text: (r) => r.name,
        cell: (r) => r.name,
      },
      { id: "note", header: "Note", text: (r) => r.note, cell: (r) => r.note },
    ]);
    // The owner pages the rows: sorting one page here would look right and be wrong.
    expect(screen.queryByTestId("t-sort-note")).toBeNull();
    expect(document.querySelectorAll("th[aria-sort]")).toHaveLength(1);
  });

  it("holds a sorted order while a cell changes, and sorts again when rows come or go", async () => {
    const user = userEvent.setup();
    const table = (rows: { id: string; v: string }[]) => (
      <FluentProvider theme={webLightTheme}>
        <DataTable
          testId="t"
          items={rows}
          getRowId={(r) => r.id}
          rowProps={(r) => ({ "data-testid": `row-${r.id}` })}
          columns={[{ id: "v", header: "V", text: (r) => r.v, cell: (r) => r.v }]}
        />
      </FluentProvider>
    );
    const { rerender } = render(table([{ id: "1", v: "b" }, { id: "2", v: "a" }]));
    const order = () =>
      screen.getAllByTestId(/^row-/).map((r) => r.getAttribute("data-testid")?.slice(4));
    await user.click(screen.getByTestId("t-sort-v"));
    expect(order()).toEqual(["2", "1"]);
    rerender(table([{ id: "1", v: "b" }, { id: "2", v: "z" }])); // an edit: the row stays put
    expect(order()).toEqual(["2", "1"]);
    rerender(table([{ id: "1", v: "b" }, { id: "2", v: "z" }, { id: "3", v: "a" }]));
    expect(order()).toEqual(["3", "1", "2"]); // a new row: sorted again
  });
});
