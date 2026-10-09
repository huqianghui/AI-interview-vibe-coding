/** A document's sections as the units a person and the AI both use (owner, 2026-10-09): sections
 * merged or opened to 500-4000 characters, in document order. A merged unit is named by its range
 * ("1–3 PURPOSE / SCOPE / DEFINITIONS"); a click shows its whole passage below, where every
 * section inside keeps its own heading. */
import { useTranslation } from "react-i18next";
import type { SopUnit } from "../../api/admin";
import { DataTable, type DataColumn } from "../../components/DataTable";

export function SopUnitList({
  units,
  selected,
  onOpen,
}: {
  units: SopUnit[];
  selected: number | null;
  onOpen: (index: number) => void;
}) {
  const { t } = useTranslation();
  const pages = (u: SopUnit) =>
    u.page_start === u.page_end ? String(u.page_start) : `${u.page_start}–${u.page_end}`;
  const label = (u: SopUnit) => u.label || t("admin.sop.preamble");
  const columns: DataColumn<SopUnit>[] = [
    { id: "section", header: t("admin.sop.colSection"), long: true, text: label, cell: label },
    { id: "pages", header: t("admin.sop.colPages"), text: pages, cell: pages },
    {
      id: "chars",
      header: t("admin.sop.colChars"),
      text: (u) => String(u.length),
      cell: (u) => u.length.toLocaleString(),
    },
  ];
  return (
    <DataTable
      size="small"
      testId="sop-units"
      items={units}
      getRowId={(u) => String(u.index)}
      rowProps={(u) => ({
        "data-testid": `sop-unit-${u.index}`,
        "aria-selected": u.index === selected,
        style: { cursor: "pointer" },
        tabIndex: 0,
        onClick: () => onOpen(u.index),
        onKeyDown: (e: { key: string }) => e.key === "Enter" && onOpen(u.index),
      })}
      columns={columns}
    />
  );
}
