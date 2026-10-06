/** Scoring-in-progress beat (P10). With streamed progress the bar is determinate (real per-question
 * grading progress off /report/stream); without it, spinner-only. The opt-in SOP coverage audit
 * gets its own second line and bar. */
import { Card, ProgressBar, Spinner, Text } from "@fluentui/react-components";
import type { Progress } from "./useScoringFlow";

export function ScoringProgressCard({
  narration,
  coverageNarration,
  scoringProgress,
  coverageProgress,
}: {
  narration: string;
  coverageNarration: string | null;
  scoringProgress: Progress | null;
  coverageProgress: Progress | null;
}) {
  return (
    <Card>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: 12,
        }}
      >
        <Spinner size="small" />
        <div>
          <Text block>{narration}</Text>
          {coverageNarration && (
            <Text block size={200} data-testid="coverage-progress">
              {coverageNarration}
            </Text>
          )}
        </div>
      </div>
      {scoringProgress && (
        <div style={{ padding: "0 12px 12px" }}>
          <ProgressBar
            value={scoringProgress.done}
            max={scoringProgress.total}
          />
        </div>
      )}
      {coverageProgress && (
        <div style={{ padding: "0 12px 12px" }}>
          <ProgressBar
            value={coverageProgress.done}
            max={coverageProgress.total}
          />
        </div>
      )}
    </Card>
  );
}
