/**
 * Knowledge (Foundry IQ) status strip (Phase 3) — read-only.
 *
 * The interviewer agent's knowledge base is bound from the GLOBAL AI Foundry config, not per
 * persona (the backend has no persona-level KB override). So this shows the currently-configured
 * knowledge base and links to the Admin config page to change it — honest about where the setting
 * actually lives, rather than a picker that would imply a per-persona override that doesn't exist.
 */
import { useEffect, useState } from "react";
import { Badge, Caption1, Link, Spinner, makeStyles, tokens } from "@fluentui/react-components";
import { getAiFoundryConfig } from "../../api/admin";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS },
  row: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS, flexWrap: "wrap" },
});

export function KnowledgeStatus() {
  const styles = useStyles();
  const [kb, setKb] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    getAiFoundryConfig()
      .then((c) => active && setKb(c.knowledge_base ?? ""))
      .catch(() => {
        /* best-effort */
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className={styles.root} data-testid="knowledge-status">
      <div className={styles.row}>
        {loading ? (
          <Spinner size="tiny" label="Loading knowledge base…" />
        ) : kb ? (
          <Badge appearance="tint" color="brand" data-testid="knowledge-kb">
            {kb}
          </Badge>
        ) : (
          <Caption1 data-testid="knowledge-none">No knowledge base configured</Caption1>
        )}
      </div>
      <Caption1>
        Foundry IQ knowledge is bound automatically on sync from the global config.{" "}
        <Link href="/admin">Change under Admin</Link>.
      </Caption1>
    </div>
  );
}
