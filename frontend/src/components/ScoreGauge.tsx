/**
 * ScoreGauge (SPEC F8 / P14) — the report's headline visual: a circular 0-100 gauge with the
 * letter grade at its center. An SVG arc (no chart lib) so it renders crisp at any size and is
 * trivially testable. Colour tracks the classification outcome tier when one is supplied (Meets → green,
 * Needs Improvement → marigold, Does Not Meet → red); otherwise it falls back to the letter grade
 * band (A/B green → F red) for the demo/stub bank.
 */
import { makeStyles, tokens, Text } from "@fluentui/react-components";
import type { Outcome } from "../api/client";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", alignItems: "center", gap: "4px" },
  wrap: { position: "relative", width: "160px", height: "160px" },
  center: {
    position: "absolute",
    inset: "0",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
  },
  grade: { fontSize: "48px", fontWeight: 700, lineHeight: "1" },
  score: { color: tokens.colorNeutralForeground3 },
});

function gradeColor(grade: string): string {
  switch (grade) {
    case "A":
    case "B":
      return tokens.colorPaletteGreenForeground1;
    case "C":
      return tokens.colorPaletteYellowForeground1;
    case "D":
      return tokens.colorPaletteMarigoldForeground1;
    default:
      return tokens.colorPaletteRedForeground1;
  }
}

function outcomeColor(outcome: Outcome): string {
  switch (outcome) {
    case "Meets Expectations":
      return tokens.colorPaletteGreenForeground1;
    case "Needs Improvement":
      return tokens.colorPaletteMarigoldForeground1;
    default:
      return tokens.colorPaletteRedForeground1;
  }
}

interface ScoreGaugeProps {
  score: number; // 0-100
  grade: string;
  // Classification tier. When present it drives the arc/center colour instead of the letter
  // grade band; the center still shows the letter grade so the numeric detail stays available.
  outcome?: Outcome | null;
}

export function ScoreGauge({ score, grade, outcome }: ScoreGaugeProps) {
  const styles = useStyles();
  const clamped = Math.max(0, Math.min(100, score));
  const radius = 70;
  const circumference = 2 * Math.PI * radius;
  const dash = (clamped / 100) * circumference;
  const color = outcome ? outcomeColor(outcome) : gradeColor(grade);

  return (
    <div
      className={styles.root}
      data-testid="score-gauge"
      data-grade={grade}
      data-outcome={outcome ?? ""}
    >
      <div className={styles.wrap}>
        <svg width="160" height="160" viewBox="0 0 160 160" aria-hidden="true">
          <circle
            cx="80"
            cy="80"
            r={radius}
            fill="none"
            stroke={tokens.colorNeutralStroke2}
            strokeWidth="12"
          />
          <circle
            cx="80"
            cy="80"
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth="12"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circumference}`}
            transform="rotate(-90 80 80)"
          />
        </svg>
        <div className={styles.center}>
          <span className={styles.grade} style={{ color }} data-testid="gauge-grade">
            {grade}
          </span>
          <Text className={styles.score} data-testid="gauge-score">
            {Math.round(clamped)}/100
          </Text>
        </div>
      </div>
    </div>
  );
}
