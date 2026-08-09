/**
 * QuestionProgress (SPEC F9 / P11) — a dot-stepper showing interview position.
 *
 * A NEW component (no analog in the reference Avatar layer). Each question is a dot in one of
 * three states: answered (past), active (current), or remaining (future). Sits high in the
 * interview layout so the candidate always sees "question n of N" without scrolling the
 * transcript (P11 layout rule #3).
 */
import { makeStyles, tokens, Text } from "@fluentui/react-components";
import { useTranslation } from "react-i18next";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: "8px", alignItems: "center" },
  dots: { display: "flex", gap: "10px", alignItems: "center" },
  dot: { width: "12px", height: "12px", borderRadius: "50%", transition: "all 200ms ease" },
  answered: { background: tokens.colorPaletteGreenForeground1 },
  active: {
    background: tokens.colorBrandBackground,
    transform: "scale(1.4)",
    boxShadow: `0 0 0 3px ${tokens.colorBrandBackground2}`,
  },
  remaining: { background: tokens.colorNeutralStroke2 },
  label: { color: tokens.colorNeutralForeground3 },
});

interface QuestionProgressProps {
  /** 0-based index of the active question. */
  current: number;
  total: number;
}

export function QuestionProgress({ current, total }: QuestionProgressProps) {
  const styles = useStyles();
  const { t } = useTranslation();

  return (
    <div className={styles.root} data-testid="question-progress">
      <div className={styles.dots} role="list" aria-label={t("questionProgress", { index: current + 1, total })}>
        {Array.from({ length: total }, (_, i) => {
          const state = i < current ? "answered" : i === current ? "active" : "remaining";
          return (
            <span
              key={i}
              role="listitem"
              className={`${styles.dot} ${styles[state]}`}
              data-state={state}
              aria-current={i === current ? "step" : undefined}
            />
          );
        })}
      </div>
      <Text size={200} className={styles.label}>
        {t("questionProgress", { index: Math.min(current + 1, total), total })}
      </Text>
    </div>
  );
}
