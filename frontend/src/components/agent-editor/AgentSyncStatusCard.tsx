/**
 * Foundry agent-sync status card (Phase 3).
 *
 * Surfaces the persona's Foundry prompt-agent binding — status (none/pending/synced/failed),
 * agent id + version, any sync error — plus a Retry-sync action. A failed sync is a recorded
 * state here, exactly as the backend models it (never a crash).
 */
import {
  Badge,
  Button,
  Caption1,
  Card,
  CardHeader,
  Text,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { ArrowSync16Regular } from "@fluentui/react-icons";
import type { AgentSyncStatus } from "../../api/personas";

const useStyles = makeStyles({
  row: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS, flexWrap: "wrap" },
  meta: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, marginTop: tokens.spacingVerticalS },
  mono: { fontFamily: tokens.fontFamilyMonospace },
  error: { color: tokens.colorPaletteRedForeground1 },
});

const STATUS: Record<AgentSyncStatus, { label: string; color: "success" | "warning" | "danger" | "subtle" }> = {
  synced: { label: "Synced", color: "success" },
  pending: { label: "Pending", color: "warning" },
  failed: { label: "Failed", color: "danger" },
  none: { label: "Not synced", color: "subtle" },
};

export interface AgentSyncStatusCardProps {
  status: AgentSyncStatus;
  agentId: string | null;
  agentVersion: string | null;
  syncError: string | null;
  onRetry?: () => void;
  retrying?: boolean;
  /** A brand-new persona has no agent yet — hide the retry action. */
  isNew?: boolean;
}

export function AgentSyncStatusCard({
  status,
  agentId,
  agentVersion,
  syncError,
  onRetry,
  retrying,
  isNew,
}: AgentSyncStatusCardProps) {
  const styles = useStyles();
  const s = STATUS[status] ?? STATUS.none;
  return (
    <Card data-testid="agent-sync-status">
      <CardHeader header={<Title3>AI Foundry agent</Title3>} />
      <div className={styles.row}>
        <Badge appearance="filled" color={s.color} data-testid="agent-sync-badge">
          {s.label}
        </Badge>
        {!isNew && onRetry && (
          <Button
            size="small"
            icon={<ArrowSync16Regular />}
            disabled={retrying}
            onClick={onRetry}
            data-testid="agent-retry-sync"
          >
            {retrying ? "Syncing…" : "Retry sync"}
          </Button>
        )}
      </div>
      <div className={styles.meta}>
        {agentId && (
          <Caption1 className={styles.mono}>agent: {agentId}</Caption1>
        )}
        {agentVersion && (
          <Caption1 className={styles.mono}>version: {agentVersion}</Caption1>
        )}
        {isNew && <Caption1>Save the persona to create its Foundry agent.</Caption1>}
        {status === "failed" && syncError && (
          <Text size={200} className={styles.error} data-testid="agent-sync-error">
            {syncError}
          </Text>
        )}
      </div>
    </Card>
  );
}
