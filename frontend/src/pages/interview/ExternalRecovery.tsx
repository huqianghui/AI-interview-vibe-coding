/** Phase 2: a stalled external turn (recovery_required, or awaiting seen on resume). The candidate
 * clears it with an explicit 恢复, which re-drives the same committed state (idempotent). */
import { useTranslation } from "react-i18next";
import { Button, Text } from "@fluentui/react-components";
import { useInterviewStyles } from "./styles";

export function ExternalRecovery({ busy, onRecover }: { busy: boolean; onRecover: () => void }) {
  const styles = useInterviewStyles();
  const { t } = useTranslation();
  return (
    <div className={styles.recoveryBlock} data-testid="external-recovery">
      <Text weight="semibold">{t("external.recoveryTitle")}</Text>
      <Text size={200}>{t("external.recoveryBody")}</Text>
      <div>
        <Button appearance="primary" disabled={busy} onClick={onRecover}>
          {busy ? t("external.recovering") : t("external.recover")}
        </Button>
      </div>
    </div>
  );
}
