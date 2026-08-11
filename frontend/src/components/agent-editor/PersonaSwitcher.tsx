/**
 * Top-bar persona switcher — the Foundry portal's "‹ AgentName ▾" agent picker.
 *
 * A dropdown of interviewer personas (name + default/sync badges) plus a "New persona" button.
 * Selecting one drives the editor; purely presentational — the page owns data and selection.
 */
import {
  Badge,
  Button,
  Dropdown,
  Option,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { AddRegular } from "@fluentui/react-icons";
import type { PersonaOut } from "../../api/personas";

const useStyles = makeStyles({
  root: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalM, minWidth: 0 },
  dropdown: { minWidth: "220px" },
  optionRow: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalXS },
  dot: { width: "8px", height: "8px", borderRadius: "50%", flexShrink: 0 },
});

export interface PersonaSwitcherProps {
  personas: PersonaOut[];
  selectedId: string | null;
  isNew: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
}

export function PersonaSwitcher({
  personas,
  selectedId,
  isNew,
  onSelect,
  onNew,
}: PersonaSwitcherProps) {
  const styles = useStyles();
  const selected = personas.find((p) => p.id === selectedId);
  const value = isNew ? "New persona" : (selected?.name ?? "");

  return (
    <div className={styles.root} data-testid="persona-switcher">
      <Dropdown
        className={styles.dropdown}
        aria-label="Select interviewer persona"
        data-testid="persona-select"
        placeholder="Select a persona"
        selectedOptions={selectedId && !isNew ? [selectedId] : []}
        value={value}
        onOptionSelect={(_, d) => d.optionValue && onSelect(d.optionValue)}
      >
        {personas.map((p) => (
          <Option key={p.id} value={p.id} text={p.name} data-testid={`persona-item-${p.id}`}>
            <span className={styles.optionRow}>
              <span
                className={styles.dot}
                style={{
                  backgroundColor: p.enabled
                    ? tokens.colorPaletteGreenBackground3
                    : tokens.colorNeutralForeground4,
                }}
              />
              <Text weight="semibold">{p.name}</Text>
              {p.is_default && (
                <Badge size="small" appearance="tint" color="brand">
                  default
                </Badge>
              )}
              <Badge size="small" appearance="outline">
                {p.agent_sync_status}
              </Badge>
            </span>
          </Option>
        ))}
      </Dropdown>
      <Button
        appearance="primary"
        icon={<AddRegular />}
        onClick={onNew}
        data-testid="persona-new"
      >
        New persona
      </Button>
    </div>
  );
}
