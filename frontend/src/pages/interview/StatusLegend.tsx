/** The four voice states as a legend: every state's dot and name, and the live one highlighted with
 * its explanation. Shown in both channels (text keeps "ready" highlighted as a steady reference). */
import { useTranslation } from "react-i18next";
import { Text, mergeClasses } from "@fluentui/react-components";
import type { AudioState } from "../../types/voice";
import { STATUS_DOT_COLOR, STATUS_ORDER, useInterviewStyles } from "./styles";

export function StatusLegend({ badgeState }: { badgeState: AudioState }) {
  const styles = useInterviewStyles();
  const { t } = useTranslation();
  return (
    <div
      className={styles.statusLegend}
      role="group"
      aria-label={t("voice.statusLegendLabel")}
      data-testid="voice-status-legend"
    >
      {STATUS_ORDER.map((state) => {
        const active = badgeState === state;
        return (
          <div
            key={state}
            className={mergeClasses(
              styles.statusItem,
              active && styles.statusItemActive,
            )}
            data-state={state}
            data-active={active}
            aria-current={active ? "true" : undefined}
          >
            <span
              className={styles.statusDot}
              style={{ background: STATUS_DOT_COLOR[state] }}
              aria-hidden
            />
            <span className={styles.statusTextCol}>
              <Text size={200} className={styles.statusItemLabel}>
                {t(`voice.${state}`)}
              </Text>
              {/* The explanation belongs to the state you are IN. Rendering all four cost 248 of
                  the first 486 pixels on a 390px phone (measured), pushing the question itself
                  into the bottom third of the screen — the candidate scrolled past three
                  sentences about things that were not happening to read what they were asked.
                  Inactive states keep their dot and name, which is what carries the colour
                  vocabulary; only the live one explains itself. */}
              {active && (
                <Text size={100} className={styles.statusItemTip}>
                  {t(`voice.statusTips.${state}`)}
                </Text>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
