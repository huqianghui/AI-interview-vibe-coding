/**
 * "Connect knowledge base" dialog — mirrors the Azure AI Foundry portal's KB connect flow.
 *
 * Two cascading dropdowns: pick an Azure AI Search connection, then a Foundry IQ knowledge base
 * behind it (the KB dropdown is disabled until a connection is chosen and repopulates on change).
 * Confirming posts {connection_name, connection_target (from the selected connection), index_name};
 * the parent persists it and the persona re-syncs (an MCPTool per KB) server-side.
 */
import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogActions,
  Dropdown,
  Field,
  Option,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  listKbConnections,
  listKnowledgeBases,
  type KbConnection,
  type KbOption,
} from "../../api/personaKnowledge";

const useStyles = makeStyles({
  surface: { maxWidth: "520px", width: "90vw" },
  body: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  error: { color: tokens.colorPaletteRedForeground1 },
});

export interface ConnectKbDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the KB to attach when the user confirms. */
  onAdd: (body: { connection_name: string; connection_target: string; index_name: string }) => void;
}

export function ConnectKbDialog({ open, onOpenChange, onAdd }: ConnectKbDialogProps) {
  const styles = useStyles();
  const [connections, setConnections] = useState<KbConnection[]>([]);
  const [kbs, setKbs] = useState<KbOption[]>([]);
  const [connName, setConnName] = useState<string>("");
  const [kbName, setKbName] = useState<string>("");
  const [loadingConns, setLoadingConns] = useState(false);
  const [loadingKbs, setLoadingKbs] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load connections when the dialog opens; reset selection each open.
  useEffect(() => {
    if (!open) return;
    setConnName("");
    setKbName("");
    setKbs([]);
    setError(null);
    setLoadingConns(true);
    let active = true;
    listKbConnections()
      .then((cs) => active && setConnections(cs))
      .catch((e) => active && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => active && setLoadingConns(false));
    return () => {
      active = false;
    };
  }, [open]);

  // Load knowledge bases whenever the chosen connection changes.
  useEffect(() => {
    if (!connName) {
      setKbs([]);
      return;
    }
    setLoadingKbs(true);
    setKbName("");
    let active = true;
    listKnowledgeBases(connName)
      .then((k) => active && setKbs(k))
      .catch((e) => active && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => active && setLoadingKbs(false));
    return () => {
      active = false;
    };
  }, [connName]);

  const selectedConn = connections.find((c) => c.name === connName);
  const canAdd = Boolean(connName && kbName);

  const confirm = () => {
    if (!selectedConn || !kbName) return;
    onAdd({
      connection_name: selectedConn.name,
      connection_target: selectedConn.target,
      index_name: kbName,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface className={styles.surface} data-testid="connect-kb-dialog">
        <DialogBody>
          <DialogTitle>Connect knowledge base</DialogTitle>
          <div className={styles.body}>
            <Field label="Connection">
              {loadingConns ? (
                <Spinner size="tiny" label="Loading connections…" />
              ) : (
                <Dropdown
                  placeholder="Select an Azure AI Search connection"
                  selectedOptions={connName ? [connName] : []}
                  value={
                    selectedConn
                      ? `${selectedConn.name}${selectedConn.is_default ? " (default)" : ""}`
                      : ""
                  }
                  onOptionSelect={(_, d) => setConnName(d.optionValue ?? "")}
                  data-testid="kb-connection-dropdown"
                >
                  {connections.map((c) => (
                    <Option key={c.name} value={c.name} text={c.name}>
                      {c.name}
                      {c.is_default ? " (default)" : ""}
                    </Option>
                  ))}
                </Dropdown>
              )}
            </Field>

            <Field label="Knowledge base">
              {loadingKbs ? (
                <Spinner size="tiny" label="Loading knowledge bases…" />
              ) : (
                <Dropdown
                  placeholder="Select a knowledge base"
                  disabled={!connName}
                  selectedOptions={kbName ? [kbName] : []}
                  value={kbs.find((k) => k.value === kbName)?.label ?? kbName}
                  onOptionSelect={(_, d) => setKbName(d.optionValue ?? "")}
                  data-testid="kb-index-dropdown"
                >
                  {kbs.map((k) => (
                    <Option key={k.value} value={k.value} text={k.label}>
                      {k.label}
                    </Option>
                  ))}
                </Dropdown>
              )}
            </Field>

            {error && (
              <Text size={200} className={styles.error} data-testid="kb-dialog-error">
                {error}
              </Text>
            )}
          </div>
          <DialogActions>
            <Button
              appearance="secondary"
              onClick={() => onOpenChange(false)}
              data-testid="kb-cancel"
            >
              Cancel
            </Button>
            <Button
              appearance="primary"
              disabled={!canAdd}
              onClick={confirm}
              data-testid="kb-add"
            >
              Add
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
