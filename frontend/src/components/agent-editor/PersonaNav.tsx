/**
 * Left-nav persona list (Phase 3) — the editor's "agents list" analog.
 *
 * Lists personas (name + enabled dot + default badge + agent-sync status chip) and a "New persona"
 * button. Selecting one drives the center/rail editor. Purely presentational — the page owns the
 * data and selection.
 */
import {
  Badge,
  Button,
  Text,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { AddRegular } from "@fluentui/react-icons";
import type { AgentSyncStatus, PersonaOut } from "../../api/personas";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, padding: tokens.spacingVerticalS },
  newBtn: { marginBottom: tokens.spacingVerticalS },
  item: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalS),
    borderRadius: tokens.borderRadiusMedium,
    cursor: "pointer",
    textAlign: "left",
    ...shorthands.border("2px", "solid", "transparent"),
    backgroundColor: tokens.colorNeutralBackground1,
  },
  itemSelected: {
    ...shorthands.borderColor(tokens.colorBrandStroke1),
    backgroundColor: tokens.colorNeutralBackground1Selected,
  },
  nameRow: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalXS },
  dot: { width: "8px", height: "8px", borderRadius: "50%", flexShrink: 0 },
  metaRow: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalXS, flexWrap: "wrap" },
});

const SYNC_COLOR: Record<AgentSyncStatus, "success" | "warning" | "danger" | "subtle"> = {
  synced: "success",
  pending: "warning",
  failed: "danger",
  none: "subtle",
};

export interface PersonaNavProps {
  personas: PersonaOut[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}

export function PersonaNav({ personas, selectedId, onSelect, onNew }: PersonaNavProps) {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      <Button
        appearance="primary"
        icon={<AddRegular />}
        className={styles.newBtn}
        onClick={onNew}
        data-testid="persona-new"
      >
        New persona
      </Button>
      <ul data-testid="persona-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {personas.map((p) => (
          <li key={p.id}>
            <div
              role="button"
              tabIndex={0}
              aria-pressed={p.id === selectedId}
              data-testid={`persona-item-${p.id}`}
              className={`${styles.item} ${p.id === selectedId ? styles.itemSelected : ""}`}
              onClick={() => onSelect(p.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(p.id);
                }
              }}
            >
              <div className={styles.nameRow}>
                <span
                  className={styles.dot}
                  style={{
                    backgroundColor: p.enabled
                      ? tokens.colorPaletteGreenBackground3
                      : tokens.colorNeutralForeground4,
                  }}
                />
                <Text weight="semibold" truncate>
                  {p.name}
                </Text>
              </div>
              <div className={styles.metaRow}>
                {p.is_default && (
                  <Badge size="small" appearance="tint" color="brand">
                    default
                  </Badge>
                )}
                <Badge size="small" appearance="outline" color={SYNC_COLOR[p.agent_sync_status]}>
                  {p.agent_sync_status}
                </Badge>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
