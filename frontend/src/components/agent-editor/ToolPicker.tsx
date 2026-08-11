/**
 * "Select a tool" dialog — mirrors the Azure AI Foundry portal's tool picker.
 *
 * Configured / Catalog / Custom tabs, a search box, grid/list view toggle, and a card per tool.
 * Supported tools (code_interpreter / web_search / public MCP) can be added and really sync to the
 * Foundry agent; the rest carry a "Preview" badge and are not selectable (parity, not fake function).
 * Selecting the MCP card reveals a small server-url form before the tool can be added.
 */
import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogActions,
  Field,
  Input,
  Text,
  TabList,
  Tab,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  TOOL_CATALOG,
  type ToolCatalogEntry,
  type ToolConfig,
  type ToolTab,
} from "../../data/agentTools";

const useStyles = makeStyles({
  surface: { maxWidth: "860px", width: "90vw" },
  content: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
  },
  search: { flex: 1 },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, 1fr)",
    gap: tokens.spacingHorizontalM,
    maxHeight: "48vh",
    overflowY: "auto",
    paddingRight: tokens.spacingHorizontalXS,
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    ...shorthands.border("1px", "solid", tokens.colorNeutralStroke2),
    cursor: "pointer",
    textAlign: "left",
    backgroundColor: tokens.colorNeutralBackground1,
  },
  cardSelected: { ...shorthands.borderColor(tokens.colorBrandStroke1) },
  cardDisabled: { opacity: 0.6, cursor: "not-allowed" },
  cardHeader: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS },
  desc: { color: tokens.colorNeutralForeground3 },
  configForm: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    marginTop: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
});

const TABS: { value: ToolTab; label: string }[] = [
  { value: "configured", label: "Configured" },
  { value: "catalog", label: "Catalog" },
  { value: "custom", label: "Custom" },
];

export interface ToolPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the tool config to add when the user confirms a supported tool. */
  onAdd: (tool: ToolConfig) => void;
  /** Types already added (so we can mark them / avoid dupes). */
  existingTypes: string[];
}

export function ToolPicker({ open, onOpenChange, onAdd, existingTypes }: ToolPickerProps) {
  const styles = useStyles();
  const [tab, setTab] = useState<ToolTab>("configured");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ToolCatalogEntry | null>(null);
  // MCP config form state.
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpLabel, setMcpLabel] = useState("");

  const reset = () => {
    setSelected(null);
    setMcpUrl("");
    setMcpLabel("");
    setQuery("");
  };

  const close = () => {
    reset();
    onOpenChange(false);
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return TOOL_CATALOG.filter(
      (t) =>
        t.tab === tab &&
        (!q || t.label.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)),
    );
  }, [tab, query]);

  const canAdd =
    selected != null &&
    selected.supported &&
    (selected.id !== "mcp" || mcpUrl.trim().length > 0);

  const confirm = () => {
    if (!selected || !selected.supported) return;
    if (selected.id === "mcp") {
      if (!mcpUrl.trim()) return;
      onAdd({
        type: "mcp",
        server_url: mcpUrl.trim(),
        server_label: mcpLabel.trim() || "custom-mcp",
      });
    } else {
      onAdd({ type: selected.id });
    }
    close();
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => (d.open ? onOpenChange(true) : close())}>
      <DialogSurface className={styles.surface} data-testid="tool-picker">
        <DialogBody>
          <DialogTitle>Select a tool</DialogTitle>

          <div className={styles.content}>
            <TabList
              selectedValue={tab}
              onTabSelect={(_, d) => {
                setTab(d.value as ToolTab);
                setSelected(null);
              }}
            >
              {TABS.map((t) => (
                <Tab key={t.value} value={t.value} data-testid={`tool-tab-${t.value}`}>
                  {t.label}
                </Tab>
              ))}
            </TabList>

            <div className={styles.toolbar}>
              <Input
                className={styles.search}
                placeholder="Search"
                value={query}
                onChange={(_, d) => setQuery(d.value)}
                data-testid="tool-search"
              />
            </div>

            <div className={styles.grid} data-testid="tool-grid">
            {visible.map((t) => {
              const already = existingTypes.includes(t.id) && t.id !== "mcp";
              const disabled = !t.supported || already;
              const isSel = selected?.id === t.id;
              return (
                <div
                  key={t.id}
                  role="button"
                  tabIndex={disabled ? -1 : 0}
                  aria-disabled={disabled}
                  aria-pressed={isSel}
                  data-testid={`tool-card-${t.id}`}
                  className={[
                    styles.card,
                    isSel ? styles.cardSelected : "",
                    disabled ? styles.cardDisabled : "",
                  ].join(" ")}
                  onClick={() => !disabled && setSelected(t)}
                  onKeyDown={(e) => {
                    if (!disabled && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      setSelected(t);
                    }
                  }}
                >
                  <div className={styles.cardHeader}>
                    <Text weight="semibold">{t.label}</Text>
                    {t.preview && (
                      <Badge size="small" appearance="outline" color="informative">
                        Preview
                      </Badge>
                    )}
                    {already && (
                      <Badge size="small" appearance="tint" color="success">
                        Added
                      </Badge>
                    )}
                  </div>
                  <Text size={200} className={styles.desc}>
                    {t.description}
                  </Text>
                </div>
              );
            })}
          </div>

          {/* MCP needs a server URL before it can be added. */}
          {selected?.id === "mcp" && (
            <div className={styles.configForm} data-testid="mcp-config-form">
              <Field label="MCP server URL" required>
                <Input
                  value={mcpUrl}
                  placeholder="https://your-mcp-server/mcp"
                  onChange={(_, d) => setMcpUrl(d.value)}
                  data-testid="mcp-server-url"
                />
              </Field>
              <Field label="Server label">
                <Input
                  value={mcpLabel}
                  placeholder="custom-mcp"
                  onChange={(_, d) => setMcpLabel(d.value)}
                  data-testid="mcp-server-label"
                />
              </Field>
            </div>
          )}
          </div>

          <DialogActions>
            <Button appearance="secondary" onClick={close} data-testid="tool-cancel">
              Cancel
            </Button>
            <Button
              appearance="primary"
              disabled={!canAdd}
              onClick={confirm}
              data-testid="tool-add"
            >
              Add tool
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
