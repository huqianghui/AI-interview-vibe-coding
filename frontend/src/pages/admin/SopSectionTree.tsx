/** A document's sections as a tree (owner, 2026-10-09): every level opens and closes on its own,
 * top-level sections show first, and Expand all / Collapse all sit above the tree. A click on a
 * section's title still shows its full passage below. */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Text, Tree, TreeItem, TreeItemLayout } from "@fluentui/react-components";
import type { SopSection } from "../../api/admin";

export function SopSectionTree({
  sections,
  onOpen,
}: {
  sections: SopSection[];
  onOpen: (orderIndex: number) => void;
}) {
  const { t } = useTranslation();
  const children = useMemo(() => {
    const byParent = new Map<number | null, SopSection[]>();
    for (const s of sections) {
      const key = s.parent_index ?? null;
      byParent.set(key, [...(byParent.get(key) ?? []), s]);
    }
    return byParent;
  }, [sections]);
  const branches = useMemo(
    () => sections.filter((s) => (children.get(s.order_index) ?? []).length > 0),
    [sections, children],
  );
  // Closed by default: only the top level shows until a section is opened.
  const [open, setOpen] = useState<Set<string>>(new Set());

  const label = (s: SopSection) =>
    s.number.startsWith("§") ? s.title || t("admin.sop.preamble") : `${s.number} ${s.title}`;
  const meta = (s: SopSection) =>
    t("admin.sop.sectionMeta", {
      pages: s.page_start === s.page_end ? s.page_start : `${s.page_start}-${s.page_end}`,
      chars: s.full_length,
    });

  const render = (s: SopSection) => {
    const kids = children.get(s.order_index) ?? [];
    return (
      <TreeItem
        key={s.order_index}
        value={String(s.order_index)}
        itemType={kids.length > 0 ? "branch" : "leaf"}
        data-testid={`sop-section-node-${s.order_index}`}
      >
        <TreeItemLayout
          aside={<Text size={200}>{meta(s)}</Text>}
          onClick={() => onOpen(s.order_index)}
          data-testid={`sop-section-${s.order_index}`}
        >
          {label(s)}
        </TreeItemLayout>
        {kids.length > 0 && <Tree>{kids.map(render)}</Tree>}
      </TreeItem>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {branches.length > 0 && (
        <div style={{ display: "flex", gap: 8 }}>
          <Button
            size="small"
            data-testid="sop-sections-expand"
            onClick={() => setOpen(new Set(branches.map((s) => String(s.order_index))))}
          >
            {t("admin.sop.expandAll")}
          </Button>
          <Button size="small" data-testid="sop-sections-collapse" onClick={() => setOpen(new Set())}>
            {t("admin.sop.collapseAll")}
          </Button>
        </div>
      )}
      <Tree
        aria-label={t("admin.sop.sectionsLabel")}
        data-testid="sop-sections"
        openItems={open}
        onOpenChange={(_, d) => setOpen(new Set([...d.openItems].map(String)))}
      >
        {(children.get(null) ?? []).map(render)}
      </Tree>
    </div>
  );
}
