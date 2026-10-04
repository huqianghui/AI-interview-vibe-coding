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
 *
 * The design job here is making RE-READING easy, because that is the only thing this screen is for.
 * So: the question in display type, the candidate's own words in the body serif at reading size,
 * and the irreversible action visually separated from the list by a divider and its own note —
 * previously it was a plain button flush against the last card, where a scroll could land on it.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Body1,
  Button,
  Switch,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import type { AnsweredQuestion } from "../api/client";
import { fonts, palette } from "../theme";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column" },
  kicker: {
    fontFamily: fonts.display,
    fontSize: tokens.fontSizeBase300,
    fontWeight: 600,
    color: palette.action,
    margin: `0 0 ${tokens.spacingVerticalM}`,
  },
  headline: {
    fontFamily: fonts.display,
    fontWeight: 800,
    fontSize: "clamp(26px, 2.8vw, 38px)",
    lineHeight: 1.08,
    letterSpacing: "-0.028em",
    color: palette.ink,
    margin: 0,
  },
  accent: { color: palette.action },
  lede: {
    display: "block",
    marginTop: tokens.spacingVerticalL,
    maxWidth: "52ch",
    color: tokens.colorNeutralForeground2,
    lineHeight: tokens.lineHeightBase400,
  },

  list: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
    marginTop: tokens.spacingVerticalXXL,
  },
  card: {
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow4,
    padding: tokens.spacingVerticalXL,
  },
  eyebrow: {
    display: "block",
    fontFamily: fonts.display,
    fontSize: tokens.fontSizeBase200,
    fontWeight: 700,
    color: palette.magenta,
    letterSpacing: "0.02em",
    marginBottom: tokens.spacingVerticalS,
  },
  prompt: {
    fontFamily: fonts.display,
    fontWeight: 700,
    fontSize: tokens.fontSizeBase500,
    letterSpacing: "-0.02em",
    lineHeight: tokens.lineHeightBase500,
    color: palette.ink,
    margin: `0 0 ${tokens.spacingVerticalM}`,
  },
  answer: {
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalL}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground3,
    // Preserved from the original: a candidate's typed answer can carry its own line breaks, and
    // collapsing them would be showing them something other than what was recorded.
    whiteSpace: "pre-wrap",
  },
  answerLabel: {
    display: "block",
    fontFamily: fonts.display,
    fontSize: tokens.fontSizeBase200,
    fontWeight: 600,
    color: tokens.colorNeutralForeground3,
    marginBottom: tokens.spacingVerticalXS,
  },
  answerText: {
    display: "block",
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase500,
    color: tokens.colorNeutralForeground1,
  },

  /** The opt-in coverage audit. Reads as an aside rather than a step, because it is optional and
   *  changes nothing about the score. */
  option: {
    display: "flex",
    gap: tokens.spacingHorizontalL,
    alignItems: "flex-start",
    marginTop: tokens.spacingVerticalXXL,
    padding: tokens.spacingVerticalXL,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: "none",
  },
  optionMark: {
    flexShrink: 0,
    width: "30px",
    height: "30px",
    borderRadius: tokens.borderRadiusCircular,
    display: "grid",
    placeItems: "center",
    backgroundColor: palette.magenta,
    color: palette.surface,
    fontFamily: fonts.display,
    fontSize: tokens.fontSizeBase400,
    fontWeight: 700,
    lineHeight: 1,
  },
  optionBody: { minWidth: 0 },
  optionHint: {
    display: "block",
    marginTop: tokens.spacingVerticalXS,
    color: tokens.colorNeutralForeground2,
    lineHeight: tokens.lineHeightBase300,
  },

  /** A divider plus a consequence note between the list and the one-way action. */
  divider: {
    height: "1px",
    backgroundColor: tokens.colorNeutralStroke2,
    marginBlock: tokens.spacingVerticalXXL,
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalL,
    flexWrap: "wrap",
  },
  submit: {
    height: "50px",
    paddingInline: tokens.spacingHorizontalXXL,
    fontFamily: fonts.display,
  },
  consequence: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    maxWidth: "40ch",
  },
});

export function ReviewView({
  answers,
  busy,
  onSubmit,
}: {
  answers: AnsweredQuestion[];
  busy: boolean;
  onSubmit: (sopCoverageCheck: boolean) => void;
}) {
  const styles = useStyles();
  const { t } = useTranslation();
  // Feature D opt-in: default OFF. Ticked, it runs the reference-only "SOP coverage" audit that is
  // appended to the report and never changes a score.
  const [sopCoverageCheck, setSopCoverageCheck] = useState(false);

  return (
    <div className={styles.root} data-testid="review">
      <p className={styles.kicker}>{t("review.kicker")}</p>
      <h2 className={styles.headline} data-testid="review-headline">
        {t("review.headlineLead")}{" "}
        <span className={styles.accent}>
          {t("review.headlineAccent", { count: answers.length })}
        </span>
      </h2>
      <Body1 className={styles.lede}>{t("review.body")}</Body1>

      <div className={styles.list} data-testid="review-list">
        {answers.map((a, i) => (
          <article key={a.question_id} className={styles.card}>
            <span className={styles.eyebrow}>
              {t("report.questionN", { n: i + 1 })}
            </span>
            <p className={styles.prompt}>{a.prompt}</p>
            <div className={styles.answer} data-testid="review-answer">
              <span className={styles.answerLabel}>{t("review.yourAnswer")}</span>
              <Text className={styles.answerText}>{a.answer_text}</Text>
            </div>
          </article>
        ))}
      </div>

      <div className={styles.option} data-testid="sop-coverage-option">
        <span className={styles.optionMark} aria-hidden>
          +
        </span>
        <div className={styles.optionBody}>
          <Switch
            label={t("review.sopCoverageCheck.label")}
            checked={sopCoverageCheck}
            disabled={busy}
            onChange={(_, d) => setSopCoverageCheck(d.checked)}
            data-testid="sop-coverage-check"
          />
          <Text size={200} className={styles.optionHint}>
            {t("review.sopCoverageCheck.hint")}
          </Text>
        </div>
      </div>

      <div className={styles.divider} />
      <div className={styles.actions}>
        <Button
          appearance="primary"
          onClick={() => onSubmit(sopCoverageCheck)}
          disabled={busy}
          className={styles.submit}
          data-testid="submit-and-evaluate"
        >
          {t("review.action")}
        </Button>
        {/* The consequence, next to the action rather than buried above it: this is the one
            irreversible button in the candidate's whole flow. */}
        <span className={styles.consequence}>{t("review.consequence")}</span>
      </div>
    </div>
  );
}
