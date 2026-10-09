/** The one table every list in the app uses (owner, 2026-10-09): the same look everywhere, each
 * column starting at the width its content needs, every column resizable by dragging the edge of
 * its header, and long text kept to one line until it is clicked.
 *
 * Widths: a column with `text` is measured — its header and every cell's text, in the table's own
 * font — and starts at that width, between `minWidth` and `maxWidth`. A column of controls
 * (selects, buttons) has no text to measure and says its `width` instead. Dragged widths last
 * until the page reloads (owner's choice: not remembered). Built on Fluent's own column sizing,
 * the feature its DataGrid uses. */
import {
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  createTableColumn,
  makeStyles,
  useTableColumnSizing_unstable,
  useTableFeatures,
  type TableColumnSizingOptions,
} from "@fluentui/react-components";
import { fitWidths, makeMeasure, MIN_WIDTH } from "./dataTableWidths";

export interface DataColumn<T> {
  id: string;
  header: ReactNode;
  /** The header as plain text, when `header` is not a string (for measuring). */
  headerText?: string;
  cell: (item: T) => ReactNode;
  /** The cell as plain text: the column starts as wide as its longest value. */
  text?: (item: T) => string;
  /** Extra pixels around the measured text (a button's own padding). */
  pad?: number;
  /** Long text: one line with an ellipsis, expanded in place by a click. */
  long?: boolean;
  /** A starting width for a column with nothing to measure (controls). */
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  /** A sortable header: the current direction (if this is the sorted column) and the toggle. */
  sort?: { direction?: "ascending" | "descending"; onToggle: () => void; testId?: string };
}

export type RowProps = HTMLAttributes<HTMLTableRowElement> & { "data-testid"?: string };

export interface DataTableProps<T> {
  items: T[];
  columns: DataColumn<T>[];
  getRowId: (item: T) => string;
  rowProps?: (item: T) => RowProps;
  size?: "small" | "medium";
  testId?: string;
  "aria-busy"?: boolean;
}

const useStyles = makeStyles({
  wrap: { overflowX: "auto" },
  // Fluent's cells clip; long text needs its own block to put an ellipsis on.
  clamp: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    cursor: "pointer",
  },
  expanded: { display: "block", whiteSpace: "normal", overflowWrap: "anywhere", cursor: "pointer" },
  cell: { overflow: "hidden" },
});

function LongText({ children, title }: { children: ReactNode; title?: string }) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const toggle = (e: { stopPropagation: () => void }) => {
    e.stopPropagation(); // a click on long text expands it; it does not also open the row
    setOpen((v) => !v);
  };
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={open}
      title={open ? undefined : title}
      className={open ? styles.expanded : styles.clamp}
      onClick={toggle}
      onKeyDown={(e: KeyboardEvent) => (e.key === "Enter" || e.key === " ") && toggle(e)}
      data-expanded={open}
    >
      {children}
    </div>
  );
}

export function DataTable<T>({
  items,
  columns,
  getRowId,
  rowProps,
  size,
  testId,
  "aria-busy": ariaBusy,
}: DataTableProps<T>) {
  const styles = useStyles();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [font, setFont] = useState<string | null>(null);
  // Measured until the web font has loaded, a width is the fallback font's: measure again then.
  const [fontsLoaded, setFontsLoaded] = useState(0);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof getComputedStyle === "undefined") return;
    const cs = getComputedStyle(el);
    if (cs.fontFamily) setFont(`${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`);
  }, []);
  useLayoutEffect(() => {
    let live = true;
    void document.fonts?.ready.then(() => live && setFontsLoaded((n) => n + 1));
    return () => {
      live = false;
    };
  }, []);

  // Each column's starting width, measured from its content. A string key keeps the options
  // stable across renders that change nothing, so a drag is not undone by the next render.
  const widths = useMemo(
    () => fitWidths(columns, items, makeMeasure(font)),
    // fontsLoaded: the same font string measures differently once the web font is in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columns, items, font, fontsLoaded],
  );
  const widthKey = widths.join(",");
  const columnSizingOptions = useMemo<TableColumnSizingOptions>(() => {
    const out: TableColumnSizingOptions = {};
    columns.forEach((c, i) => {
      out[c.id] = {
        idealWidth: widths[i],
        defaultWidth: widths[i],
        // Rows stay one line (owner: tables clean and tidy). Only long text, which has its own
        // ellipsis, gives way on a narrow page; every other column keeps its content's width and
        // the table scrolls sideways instead of wrapping a cell onto a second line.
        minWidth: c.long ? Math.min(c.minWidth ?? MIN_WIDTH, widths[i]) : widths[i],
      };
    });
    return out;
    // widthKey stands for `widths`; the column ids only change with the columns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widthKey, columns.map((c) => c.id).join(",")]);

  const tableColumns = useMemo(
    () => columns.map((c) => createTableColumn<T>({ columnId: c.id })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columns.map((c) => c.id).join(",")],
  );
  const { columnSizing_unstable: sizing, tableRef } = useTableFeatures<T>(
    { columns: tableColumns, items },
    [useTableColumnSizing_unstable({ columnSizingOptions })],
  );

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <Table
        ref={tableRef}
        size={size}
        data-testid={testId}
        aria-busy={ariaBusy}
        {...sizing.getTableProps()}
      >
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHeaderCell
                key={c.id}
                {...sizing.getTableHeaderCellProps(c.id)}
                {...(c.sort
                  ? {
                      sortable: true,
                      sortDirection: c.sort.direction,
                      onClick: c.sort.onToggle,
                      "data-testid": c.sort.testId,
                    }
                  : {})}
                data-column={c.id}
              >
                {c.header}
              </TableHeaderCell>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((it) => (
            <TableRow key={getRowId(it)} {...rowProps?.(it)}>
              {columns.map((c) => (
                <TableCell key={c.id} className={styles.cell} {...sizing.getTableCellProps(c.id)}>
                  {c.long ? <LongText title={c.text?.(it)}>{c.cell(it)}</LongText> : c.cell(it)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
