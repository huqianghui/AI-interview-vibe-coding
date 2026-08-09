/**
 * MicPermissionDialog (SPEC F9 AC #4) — shown when `getUserMedia` is denied while starting a
 * voice turn. Text input always remains available as a fallback, so a denied mic never blocks the
 * interview (P13: never solely at the mercy of voice).
 */
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Text,
  tokens,
} from "@fluentui/react-components";
import { useTranslation } from "react-i18next";

interface MicPermissionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
  onUseTextInstead: () => void;
  /** True once a retry has failed again — shows the persistent-denial hint. */
  stillDenied?: boolean;
}

export function MicPermissionDialog({
  open,
  onOpenChange,
  onRetry,
  onUseTextInstead,
  stillDenied = false,
}: MicPermissionDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{t("micDialog.title")}</DialogTitle>
          <DialogContent>
            <Text as="p">{t("micDialog.body")}</Text>
            {stillDenied && (
              <Text as="p" style={{ color: tokens.colorPaletteRedForeground1, marginTop: 8 }}>
                {t("micDialog.stillDenied")}
              </Text>
            )}
          </DialogContent>
          <DialogActions>
            <Button
              appearance="secondary"
              onClick={() => {
                onUseTextInstead();
                onOpenChange(false);
              }}
            >
              {t("micDialog.useTextInstead")}
            </Button>
            <Button appearance="primary" onClick={onRetry}>
              {t("micDialog.retry")}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
