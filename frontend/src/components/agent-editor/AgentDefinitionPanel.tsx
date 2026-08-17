/**
 * Left agent-definition column — the Foundry portal's left panel.
 *
 * Divider-separated sections (Identity / Model / Voice mode / Agent sync / Instructions /
 * Knowledge), not stacked Cards, matching the portal's collapsible-section look. Presentational: the
 * page owns form state and passes the editable slice + change callbacks. The digital-human preview is
 * NOT here — it lives in the center Playground column (AvatarPreview).
 */
import {
  Divider,
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
import { AgentSyncStatusCard } from "./AgentSyncStatusCard";
import { ModelSelect } from "./ModelSelect";
import { KnowledgeSection } from "./KnowledgeSection";
import { ToolsSection } from "./ToolsSection";
import type { AgentSyncStatus } from "../../api/personas";
import type { PersonaFormState } from "../../pages/agentEditorForm";
import type { ToolConfig } from "../../data/agentTools";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column" },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalL}`,
  },
  row: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalL, flexWrap: "wrap" },
  hint: { color: tokens.colorNeutralForeground3 },
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
  tools: ToolConfig[];
  onToolsChange: (tools: ToolConfig[]) => void;
  /** Saved persona id (null for a new, unsaved persona) — drives the per-persona Knowledge section. */
  personaId: string | null;
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
  tools,
  onToolsChange,
  personaId,
}: AgentDefinitionPanelProps) {
  const styles = useStyles();
  const voiceModeOn = Boolean(form.character);

  return (
    <div className={styles.root} data-testid="agent-definition-sections">
      {/* Identity */}
      <div className={styles.section}>
        <Title3>Identity</Title3>
        <Field label="Name" required>
          <Input
            value={form.name}
            onChange={(_, d) => onChange({ name: d.value })}
            data-testid="persona-name"
          />
        </Field>
        <div className={styles.row}>
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
      </div>

      <Divider />

      {/* Voice mode */}
      <div className={styles.section}>
        <Title3>Voice mode</Title3>
        <Switch
          label="Voice mode (digital-human avatar)"
          checked={voiceModeOn}
          onChange={(_, d) => onToggleVoiceMode(d.checked)}
          data-testid="voice-mode"
        />
        <Text size={200} className={styles.hint}>
          {voiceModeOn
            ? "The interviewer speaks with a digital-human avatar (pick the character under Configure)."
            : "Voice-only presence (no avatar face)."}
        </Text>
      </div>

      <Divider />

      {/* Model (per-persona) */}
      <div className={styles.section}>
        <Title3>Model</Title3>
        <ModelSelect value={form.model} onChange={(model) => onChange({ model })} />
      </div>

      <Divider />

      {/* Agent sync */}
      <div className={styles.section}>
        <Title3>AI Foundry agent</Title3>
        <AgentSyncStatusCard
          status={syncStatus}
          agentId={agentId}
          agentVersion={agentVersion}
          syncError={syncError}
          onRetry={onRetrySync}
          retrying={retrying}
          isNew={isNew}
        />
      </div>

      <Divider />

      {/* Instructions */}
      <div className={styles.section}>
        <Title3>Instructions</Title3>
        <Field>
          <Textarea
            value={form.prompt_fragment}
            resize="vertical"
            rows={8}
            onChange={(_, d) => onChange({ prompt_fragment: d.value })}
            data-testid="persona-instructions"
          />
        </Field>
      </div>

      <Divider />

      {/* Tools (per-persona, synced to the Foundry agent) */}
      <div className={styles.section}>
        <Title3>Tools</Title3>
        <Text size={200} className={styles.hint}>
          Give the agent extra capabilities. Executed in the Foundry runtime; synced with the agent.
        </Text>
        <ToolsSection tools={tools} onChange={onToolsChange} />
      </div>

      <Divider />

      {/* Knowledge (per-persona Foundry IQ) */}
      <div className={styles.section}>
        <Title3>Knowledge</Title3>
        <KnowledgeSection personaId={personaId} />
      </div>
    </div>
  );
}
