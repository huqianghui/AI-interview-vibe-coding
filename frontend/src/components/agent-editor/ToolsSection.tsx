/**
 * Tools section for the agent-definition left panel — mirrors the Foundry portal's "Tools" block.
 *
 * Shows the persona's enabled tools as removable chips, an "Add ▾" menu (Web search + Code
 * interpreter quick toggles, and "Add tools…" opening the full ToolPicker dialog), and a disabled
 * "Upload files" button for parity. Tools sync into the Foundry prompt agent (execution is in the
 * Foundry runtime); only supported types actually reach it (see data/agentTools + backend gate).
 */
import { useState } from "react";
import {
  Badge,
  Button,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
  MenuItemCheckbox,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { AddRegular, DismissRegular } from "@fluentui/react-icons";
import { ToolPicker } from "./ToolPicker";
import { toolLabel, type ToolConfig } from "../../data/agentTools";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  chips: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS },
  chip: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  chipLabel: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalXS, minWidth: 0 },
  actions: { display: "flex", gap: tokens.spacingHorizontalS },
  empty: { color: tokens.colorNeutralForeground3 },
});

export interface ToolsSectionProps {
  tools: ToolConfig[];
  onChange: (tools: ToolConfig[]) => void;
}

export function ToolsSection({ tools, onChange }: ToolsSectionProps) {
  const styles = useStyles();
  const [pickerOpen, setPickerOpen] = useState(false);

  const has = (type: string) => tools.some((t) => t.type === type);
  const existingTypes = tools.map((t) => t.type);

  const toggleSimple = (type: string) => {
    if (has(type)) onChange(tools.filter((t) => t.type !== type));
    else onChange([...tools, { type }]);
  };

  const addTool = (tool: ToolConfig) => {
    // MCP can be added multiple times (different servers); others are single-instance.
    if (tool.type !== "mcp" && has(tool.type)) return;
    onChange([...tools, tool]);
  };

  const removeAt = (idx: number) => onChange(tools.filter((_, i) => i !== idx));

  return (
    <div className={styles.root} data-testid="tools-section">
      {tools.length === 0 ? (
        <Text size={200} className={styles.empty}>
          No tools yet. Add web search, code interpreter, or an MCP server.
        </Text>
      ) : (
        <div className={styles.chips}>
          {tools.map((t, i) => (
            <div key={`${t.type}-${i}`} className={styles.chip} data-testid={`tool-chip-${t.type}`}>
              <span className={styles.chipLabel}>
                <Text truncate>
                  {toolLabel(t.type)}
                  {t.type === "mcp" && t.server_label ? ` · ${t.server_label}` : ""}
                </Text>
                {t.type === "mcp" && (
                  <Badge size="small" appearance="tint">
                    MCP
                  </Badge>
                )}
              </span>
              <Button
                appearance="subtle"
                size="small"
                icon={<DismissRegular />}
                aria-label={`Remove ${toolLabel(t.type)}`}
                onClick={() => removeAt(i)}
                data-testid={`tool-remove-${i}`}
              />
            </div>
          ))}
        </div>
      )}

      <div className={styles.actions}>
        <Menu
          checkedValues={{
            tool: [...(has("web_search") ? ["web_search"] : []), ...(has("code_interpreter") ? ["code_interpreter"] : [])],
          }}
        >
          <MenuTrigger disableButtonEnhancement>
            <Button icon={<AddRegular />} data-testid="tools-add-menu">
              Add
            </Button>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <MenuItemCheckbox
                name="tool"
                value="web_search"
                onClick={() => toggleSimple("web_search")}
                data-testid="tools-add-web-search"
              >
                Web search
              </MenuItemCheckbox>
              <MenuItemCheckbox
                name="tool"
                value="code_interpreter"
                onClick={() => toggleSimple("code_interpreter")}
                data-testid="tools-add-code-interpreter"
              >
                Code interpreter
              </MenuItemCheckbox>
              <MenuItem onClick={() => setPickerOpen(true)} data-testid="tools-add-more">
                Add tools…
              </MenuItem>
            </MenuList>
          </MenuPopover>
        </Menu>
        <Button disabled data-testid="tools-upload">
          Upload files
        </Button>
      </div>

      <ToolPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onAdd={addTool}
        existingTypes={existingTypes}
      />
    </div>
  );
}
