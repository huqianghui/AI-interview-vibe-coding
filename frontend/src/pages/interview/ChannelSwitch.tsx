/** The text/voice channel switch: a segmented pill in the interviewing screen's top bar. */
import { useTranslation } from "react-i18next";
import { Button } from "@fluentui/react-components";
import { useInterviewStyles } from "./styles";

export type Channel = "text" | "voice";

export function ChannelSwitch({
  channel,
  onText,
  onVoice,
}: {
  channel: Channel;
  onText: () => void;
  onVoice: () => void;
}) {
  const styles = useInterviewStyles();
  const { t } = useTranslation();
  return (
    <div
      className={styles.segmented}
      role="tablist"
      aria-label={t("voice.useVoice")}
    >
      <Button
        className={styles.segBtn}
        size="small"
        appearance={channel === "text" ? "primary" : "subtle"}
        onClick={onText}
      >
        {t("voice.useText")}
      </Button>
      {/* Never permanently disabled: a transient failure (proxy hiccup, network blip) must stay
          retryable — startVoice clears voiceUnavailable on a successful reconnect. */}
      <Button
        className={styles.segBtn}
        size="small"
        appearance={channel === "voice" ? "primary" : "subtle"}
        onClick={onVoice}
      >
        {t("voice.useVoice")}
      </Button>
    </div>
  );
}
