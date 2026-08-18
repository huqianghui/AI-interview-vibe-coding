/**
 * QuestionProgress (SPEC F9 / P11) — a horizontal progress rail showing interview position.
 *
 * A NEW component (no analog in the reference Avatar layer). It fills the width of its container
 * (the global top bar) rather than hugging one side: a fraction label on the left, then a rail that
 * flex-grows to consume the remaining width. An animated fill advances to the current question, with
 * one dot per question spread evenly along the rail in three states — answered (past), active
 * (current, gently pulsing), or remaining (future). The candidate always sees "question n of N" and
 * how far they've come without scrolling the transcript (P11 layout rule #3).
 */
import { makeStyles, tokens, Text } from "@fluentui/react-components";
import { useTranslation } from "react-i18next";

const pulse = {
  "0%, 100%": { boxShadow: `0 0 0 3px ${tokens.colorBrandBackground2}` },
  "50%": { boxShadow: `0 0 0 6px ${tokens.colorBrandBackground2}` },
};

const useStyles = makeStyles({
  root: { display: "flex", alignItems: "center", gap: "14px", width: "100%", minWidth: 0 },
  label: { color: tokens.colorNeutralForeground2, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" },
  // The rail grows to fill whatever width the top bar leaves after the label.
  rail: { position: "relative", flex: 1, minWidth: "80px", height: "16px", display: "flex", alignItems: "center" },
  // Full-width track + an animated fill that advances to the active dot.
  track: {
    position: "absolute",
    left: 0,
    right: 0,
    height: "4px",
    borderRadius: "2px",
    background: tokens.colorNeutralStroke2,
  },
  fill: {
    position: "absolute",
    left: 0,
    height: "4px",
    borderRadius: "2px",
    background: `linear-gradient(90deg, ${tokens.colorPaletteGreenForeground1}, ${tokens.colorBrandBackground})`,
    transition: "width 450ms cubic-bezier(0.22, 1, 0.36, 1)",
  },
  // Dots ride on top of the rail, evenly spaced end-to-end.
  dots: { position: "relative", zIndex: 1, display: "flex", justifyContent: "space-between", width: "100%" },
  dot: { width: "12px", height: "12px", borderRadius: "50%", transition: "all 200ms ease" },
  answered: { background: tokens.colorPaletteGreenForeground1 },
  active: {
    background: tokens.colorBrandBackground,
    transform: "scale(1.4)",
    animationName: pulse,
    animationDuration: "1.8s",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
  },
  remaining: {
    background: tokens.colorNeutralBackground1,
    border: `2px solid ${tokens.colorNeutralStroke2}`,
    boxSizing: "border-box",
  },
});

interface QuestionProgressProps {
  /** 0-based index of the active question. */
  current: number;
  total: number;
}

export function QuestionProgress({ current, total }: QuestionProgressProps) {
  const styles = useStyles();
  const { t } = useTranslation();

  // Fill reaches the center of the active dot: 0% at the first question, 100% at the last. With a
  // single question the rail is fully filled (nothing to advance through).
  const fillPct = total > 1 ? (Math.min(current, total - 1) / (total - 1)) * 100 : 100;

  return (
    <div className={styles.root} data-testid="question-progress">
      <Text size={200} weight="semibold" className={styles.label}>
        {t("questionProgress", { index: Math.min(current + 1, total), total })}
      </Text>
      <div className={styles.rail}>
        <span className={styles.track} aria-hidden />
        <span className={styles.fill} style={{ width: `${fillPct}%` }} aria-hidden />
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
      </div>
    </div>
  );
}
