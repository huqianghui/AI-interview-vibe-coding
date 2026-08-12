/**
 * Knowledge (Foundry IQ) section — per-persona, editable (SPEC F5).
 *
 * Each interviewer persona binds its OWN knowledge bases (there is no global KB). This lists the
 * KBs attached to the current persona and lets an admin connect/remove them via ConnectKbDialog;
 * every add/remove re-syncs the persona's Foundry prompt agent server-side (an MCPTool per KB). A
 * not-yet-saved persona has no id to attach against, so it prompts to save first.
 */
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Caption1, Spinner, makeStyles, tokens } from "@fluentui/react-components";
import { ConnectKbDialog } from "./ConnectKbDialog";
import {
  addPersonaKnowledge,
  listPersonaKnowledge,
  removePersonaKnowledge,
  type PersonaKnowledgeConfig,
} from "../../api/personaKnowledge";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  row: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS, flexWrap: "wrap" },
  item: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
  },
  error: { color: tokens.colorPaletteRedForeground1 },
});

export interface KnowledgeSectionProps {
  /** The saved persona id; null for a not-yet-saved (new) persona. */
  personaId: string | null;
}

export function KnowledgeSection({ personaId }: KnowledgeSectionProps) {
  const styles = useStyles();
  const [configs, setConfigs] = useState<PersonaKnowledgeConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!personaId) {
      setConfigs([]);
      return;
    }
    setLoading(true);
    setError(null);
    listPersonaKnowledge(personaId)
      .then(setConfigs)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [personaId]);

  useEffect(() => {
    let active = true;
    if (!personaId) {
      setConfigs([]);
      return;
    }
    setLoading(true);
    setError(null);
    listPersonaKnowledge(personaId)
      .then((c) => active && setConfigs(c))
      .catch((e) => active && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [personaId]);

  const onAdd = async (body: {
    connection_name: string;
    connection_target: string;
    index_name: string;
  }) => {
    if (!personaId) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await addPersonaKnowledge(personaId, body);
      setConfigs(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (configId: string) => {
    setBusy(true);
    setError(null);
    try {
      await removePersonaKnowledge(configId);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!personaId) {
    return (
      <Caption1 data-testid="knowledge-needs-save">
        Save the persona first to attach knowledge bases.
      </Caption1>
    );
  }

  return (
    <div className={styles.root} data-testid="knowledge-section">
      {loading ? (
        <Spinner size="tiny" label="Loading knowledge bases…" />
      ) : configs.length === 0 ? (
        <Caption1 data-testid="knowledge-none">No knowledge base configured</Caption1>
      ) : (
        configs.map((c) => (
          <div key={c.id} className={styles.item} data-testid={`knowledge-item-${c.id}`}>
            <div className={styles.row}>
              <Badge appearance="tint" color="brand">
                {c.index_name}
              </Badge>
              <Caption1>{c.connection_name}</Caption1>
            </div>
            <Button
              size="small"
              appearance="subtle"
              disabled={busy}
              onClick={() => onRemove(c.id)}
              data-testid={`knowledge-remove-${c.id}`}
            >
              Remove
            </Button>
          </div>
        ))
      )}

      <div className={styles.row}>
        <Button
          appearance="secondary"
          disabled={busy}
          onClick={() => setDialogOpen(true)}
          data-testid="knowledge-connect"
        >
          Connect knowledge base
        </Button>
        {busy && <Spinner size="tiny" label="Syncing…" />}
      </div>

      <Caption1>Each knowledge base is bound to this persona's agent on sync.</Caption1>

      {error && (
        <Caption1 className={styles.error} data-testid="knowledge-error">
          {error}
        </Caption1>
      )}

      <ConnectKbDialog open={dialogOpen} onOpenChange={setDialogOpen} onAdd={onAdd} />
    </div>
  );
}
