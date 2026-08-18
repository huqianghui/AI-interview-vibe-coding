/**
 * Transcript (SPEC F9) — the running dialogue, SECONDARY to the avatar/question in the layout
 * (P11 rule #4). Interviewer and candidate turns are visually distinct. Citations never appear
 * here (P12: raw SOP citations are not candidate-facing during live Q&A — they surface only in
 * the scoring/report phase), so this component renders text turns only.
 */
import { makeStyles, tokens, Text } from "@fluentui/react-components";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { TranscriptSegment } from "../types/voice";

const useStyles = makeStyles({
  // Fills its flex parent (the control column's grow area) instead of a fixed max-height, so the
  // transcript adapts to the available space and scrolls internally when the dialogue is long.
  root: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    flex: 1,
    minHeight: "120px",
    overflowY: "auto",
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  // Empty state: keep the area present (so the layout doesn't jump) with a quiet hint.
  empty: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: tokens.colorNeutralForeground4,
    textAlign: "center",
  },
  turn: { display: "flex", flexDirection: "column", gap: "3px" },
  user: { alignItems: "flex-end" },
  assistant: { alignItems: "flex-start" },
  bubble: {
    maxWidth: "82%",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusXLarge,
    lineHeight: tokens.lineHeightBase300,
    boxShadow: tokens.shadow2,
  },
  userBubble: {
    background: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    borderBottomRightRadius: tokens.borderRadiusSmall,
  },
  assistantBubble: {
    background: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    borderBottomLeftRadius: tokens.borderRadiusSmall,
  },
  role: { color: tokens.colorNeutralForeground3, paddingInline: "6px" },
});

export function Transcript({ segments }: { segments: TranscriptSegment[] }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const endRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest turn in view as the dialogue grows.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [segments]);

  if (segments.length === 0) {
    return (
      <div className={`${styles.root} ${styles.empty}`} data-testid="transcript" aria-live="polite">
        <Text size={200}>{t("voice.transcriptEmpty")}</Text>
      </div>
    );
  }

  return (
    <div className={styles.root} data-testid="transcript" aria-live="polite">
      {segments.map((seg) => (
        <div
          key={seg.id}
          className={`${styles.turn} ${seg.role === "user" ? styles.user : styles.assistant}`}
        >
          <Text size={100} className={styles.role}>
            {seg.role === "user" ? t("voice.roleYou") : t("voice.roleInterviewer")}
          </Text>
          <div
            className={`${styles.bubble} ${seg.role === "user" ? styles.userBubble : styles.assistantBubble}`}
          >
            <Text>{seg.content}</Text>
          </div>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
