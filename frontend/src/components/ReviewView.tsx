/**
 * ReviewView (requirement 4) — the pre-scoring review screen.
 *
 * After the candidate answers the last question, the interview is `completed` but NOT yet scored.
 * This screen lets them read back every question + their own finalized answer, in bank order
 * (requirement 2), and hold the whole thing in view before committing. Scoring only starts when
 * they explicitly click "提交并评测" (requirement 4: no auto-score on the last answer).
 *
 * Candidate-safe (P3): prompt + the answer they gave. Deliberately NO score/rubric/checklist —
 * that stays interviewer-internal until the report renders after this button is pressed.
 */
import { useTranslation } from "react-i18next";
import {
  Body1,
  Button,
  Card,
  CardHeader,
  Text,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import type { AnsweredQuestion } from "../api/client";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: "16px" },
  intro: { display: "flex", flexDirection: "column", gap: "4px" },
  card: { display: "flex", flexDirection: "column", gap: "8px" },
  eyebrow: {
    color: tokens.colorNeutralForeground3,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  answer: {
    padding: "12px",
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground2,
    whiteSpace: "pre-wrap",
  },
  actions: { display: "flex", justifyContent: "flex-end", marginTop: "8px" },
});

export function ReviewView({
  answers,
  busy,
  onSubmit,
}: {
  answers: AnsweredQuestion[];
  busy: boolean;
  onSubmit: () => void;
}) {
  const styles = useStyles();
  const { t } = useTranslation();

  return (
    <div className={styles.root} data-testid="review">
      <div className={styles.intro}>
        <Title3 as="h1">{t("review.title")}</Title3>
        <Body1>{t("review.body")}</Body1>
      </div>

      {answers.map((a, i) => (
        <Card key={a.question_id} className={styles.card}>
          <CardHeader
            header={
              <Text size={200} weight="semibold" className={styles.eyebrow}>
                {t("report.questionN", { n: i + 1 })}
              </Text>
            }
          />
          <Text weight="semibold">{a.prompt}</Text>
          <div className={styles.answer} data-testid="review-answer">
            <Text>{a.answer_text}</Text>
          </div>
        </Card>
      ))}

      <div className={styles.actions}>
        <Button
          appearance="primary"
          onClick={onSubmit}
          disabled={busy}
          data-testid="submit-and-evaluate"
        >
          {t("review.action")}
        </Button>
      </div>
    </div>
  );
}
