/** "Restart interview" confirmation (v0.38.3.0): abandoning progress is destructive, so the header
 * button only opens this; the fresh start happens on explicit confirm. */
import { useTranslation } from "react-i18next";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Text,
} from "@fluentui/react-components";

export function RestartDialog({
  open,
  onOpenChange,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{t("candidate.restartTitle")}</DialogTitle>
          <DialogContent>
            <Text as="p">{t("candidate.restartBody")}</Text>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>
              {t("candidate.restartCancel")}
            </Button>
            <Button
              appearance="primary"
              disabled={busy}
              onClick={onConfirm}
              data-testid="candidate-restart-confirm"
            >
              {t("candidate.restartConfirm")}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
