/**
 * Center agent-definition panel (Phase 3) — the portal's middle column.
 *
 * Digital-human preview (reusing AvatarView) + identity + agent-sync status + model (informational)
 * + voice-mode toggle + instructions + knowledge status. Presentational: the page owns form state
 * and passes the editable slice + change callbacks.
 */
import {
  Card,
  CardHeader,
  Field,
  Input,
  Switch,
  Text,
  Textarea,
  Title3,
  Tooltip,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { AvatarView } from "../AvatarView";
import { AgentSyncStatusCard } from "./AgentSyncStatusCard";
import { ModelSelect } from "./ModelSelect";
import { KnowledgeStatus } from "./KnowledgeStatus";
import type { AgentSyncStatus } from "../../api/personas";
import type { PersonaFormState } from "../../pages/agentEditorForm";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL, maxWidth: "720px" },
  previewCard: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  previewBox: { height: "220px", position: "relative" },
  row: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalL, flexWrap: "wrap" },
});

export interface AgentDefinitionPanelProps {
  form: PersonaFormState;
  onChange: (patch: Partial<PersonaFormState>) => void;
  /** Voice mode is on when a character is set; toggling clears/sets character+style. */
  onToggleVoiceMode: (on: boolean) => void;
  syncStatus: AgentSyncStatus;
  agentId: string | null;
  agentVersion: string | null;
  syncError: string | null;
  isNew: boolean;
  onRetrySync?: () => void;
  retrying?: boolean;
  /** Greeting for the active locale, shown under the preview. */
  activeGreeting: string;
}

export function AgentDefinitionPanel({
  form,
  onChange,
  onToggleVoiceMode,
  syncStatus,
  agentId,
  agentVersion,
  syncError,
  isNew,
  onRetrySync,
  retrying,
  activeGreeting,
}: AgentDefinitionPanelProps) {
  const styles = useStyles();
  const voiceModeOn = Boolean(form.character);

  return (
    <div className={styles.root}>
      {/* Digital-human preview (static: no live WebRTC session in the editor). */}
      <Card className={styles.previewCard} data-testid="digital-human-preview">
        <CardHeader header={<Title3>Preview</Title3>} />
        <div className={styles.previewBox}>
          <AvatarView audioState="idle" isAvatarConnected={false} />
        </div>
        <Text size={200}>
          {voiceModeOn ? `Avatar: ${form.character} / ${form.style}` : "Voice-only (no avatar)"}
        </Text>
        {activeGreeting && <Text size={200} italic>“{activeGreeting}”</Text>}
      </Card>

      {/* Identity */}
      <Card>
        <CardHeader header={<Title3>Identity</Title3>} />
        <Field label="Name" required>
          <Input
            value={form.name}
            onChange={(_, d) => onChange({ name: d.value })}
            data-testid="persona-name"
          />
        </Field>
        <div className={styles.row} style={{ marginTop: tokens.spacingVerticalM }}>
          <Switch
            label="Enabled"
            checked={form.enabled}
            onChange={(_, d) => onChange({ enabled: d.checked })}
            data-testid="persona-enabled"
          />
          <Tooltip
            content={form.enabled ? "Make this the default interviewer" : "Enable the persona first"}
            relationship="label"
          >
            <Switch
              label="Default"
              checked={form.is_default}
              disabled={!form.enabled}
              onChange={(_, d) => onChange({ is_default: d.checked })}
              data-testid="persona-default"
            />
          </Tooltip>
        </div>
      </Card>

      {/* Agent-sync status */}
      <AgentSyncStatusCard
        status={syncStatus}
        agentId={agentId}
        agentVersion={agentVersion}
        syncError={syncError}
        onRetry={onRetrySync}
        retrying={retrying}
        isNew={isNew}
      />

      {/* Model (informational) */}
      <Card>
        <CardHeader header={<Title3>Model</Title3>} />
        <ModelSelect />
      </Card>

      {/* Voice mode + instructions */}
      <Card>
        <CardHeader header={<Title3>Agent definition</Title3>} />
        <Switch
          label="Voice mode (digital-human avatar)"
          checked={voiceModeOn}
          onChange={(_, d) => onToggleVoiceMode(d.checked)}
          data-testid="voice-mode"
        />
        <Field label="Instructions" style={{ marginTop: tokens.spacingVerticalM }}>
          <Textarea
            value={form.prompt_fragment}
            resize="vertical"
            rows={6}
            onChange={(_, d) => onChange({ prompt_fragment: d.value })}
            data-testid="persona-instructions"
          />
        </Field>
      </Card>

      {/* Knowledge (read-only status) */}
      <Card>
        <CardHeader header={<Title3>Knowledge & tools</Title3>} />
        <KnowledgeStatus />
      </Card>
    </div>
  );
}
