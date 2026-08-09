/**
 * Transcript (SPEC F9) — the running dialogue, SECONDARY to the avatar/question in the layout
 * (P11 rule #4). Interviewer and candidate turns are visually distinct. Citations never appear
 * here (P12: raw SOP citations are not candidate-facing during live Q&A — they surface only in
 * the scoring/report phase), so this component renders text turns only.
 */
import { makeStyles, tokens, Text } from "@fluentui/react-components";
import type { TranscriptSegment } from "../types/voice";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    maxHeight: "220px",
    overflowY: "auto",
    padding: "8px",
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground2,
  },
  turn: { display: "flex", flexDirection: "column", gap: "2px" },
  user: { alignItems: "flex-end" },
  assistant: { alignItems: "flex-start" },
  bubble: { maxWidth: "80%", padding: "8px 12px", borderRadius: tokens.borderRadiusLarge },
  userBubble: { background: tokens.colorBrandBackground2, color: tokens.colorNeutralForeground1 },
  assistantBubble: { background: tokens.colorNeutralBackground3 },
  role: { color: tokens.colorNeutralForeground3 },
});

export function Transcript({ segments }: { segments: TranscriptSegment[] }) {
  const styles = useStyles();
  if (segments.length === 0) return null;

  return (
    <div className={styles.root} data-testid="transcript" aria-live="polite">
      {segments.map((seg) => (
        <div
          key={seg.id}
          className={`${styles.turn} ${seg.role === "user" ? styles.user : styles.assistant}`}
        >
          <Text size={100} className={styles.role}>
            {seg.role === "user" ? "You" : "Interviewer"}
          </Text>
          <div
            className={`${styles.bubble} ${seg.role === "user" ? styles.userBubble : styles.assistantBubble}`}
          >
            <Text>{seg.content}</Text>
          </div>
        </div>
      ))}
    </div>
  );
}
