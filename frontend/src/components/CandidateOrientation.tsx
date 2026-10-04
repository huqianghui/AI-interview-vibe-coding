/**
 * Orientation: the last beat before question 1.
 *
 * This screen exists for ONE piece of information that the idle screen could not have: the question
 * count, which only exists once `startInterview()` has run. So the count IS the screen — set as
 * display type with a rail previewing every question — and the "how this works" material lives on
 * idle, before it. Previously both screens explained the same things, so the candidate passed two
 * near-identical "are you ready" gates.
 *
 * External-brain sessions have no fixed count (the interviewer drives turn by turn), so the
 * headline falls back to the count-free copy rather than rendering "0 questions".
 */
import { useTranslation } from "react-i18next";
import {
  Body1,
  Button,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import { InterviewerPortrait } from "./InterviewerPortrait";
import { fonts, layout, palette } from "../theme";

const useStyles = makeStyles({
  split: {
    display: "grid",
    gridTemplateColumns: "40fr 60fr",
    gap: tokens.spacingHorizontalXXXL,
    alignItems: "center",
    maxWidth: layout.contentWidth,
    marginInline: "auto",
    paddingInline: layout.gutter,
    paddingBlock: tokens.spacingVerticalXXL,
    minHeight: "calc(100vh - 64px)",
    boxSizing: "border-box",
    [`@media (max-width: ${layout.stackBelow})`]: {
      gridTemplateColumns: "1fr",
      gap: tokens.spacingVerticalXXL,
      alignItems: "start",
      paddingInline: layout.gutterNarrow,
      minHeight: 0,
    },
  },
  portrait: {
    width: "100%",
    maxWidth: "380px",
    marginLeft: "auto",
    [`@media (max-width: ${layout.stackBelow})`]: { marginInline: "auto", maxWidth: "320px" },
  },
  brief: { minWidth: 0 },
  kicker: {
    fontFamily: fonts.display,
    fontSize: tokens.fontSizeBase300,
    fontWeight: 600,
    color: palette.action,
    margin: `0 0 ${tokens.spacingVerticalL}`,
  },
  headline: {
    fontFamily: fonts.display,
    fontWeight: 800,
    fontSize: "clamp(30px, 3.6vw, 50px)",
    lineHeight: 1.06,
    letterSpacing: "-0.03em",
    color: palette.ink,
    margin: 0,
  },
  clause: { display: "block" },
  accent: { display: "block", color: palette.action },
  lede: {
    display: "block",
    marginTop: tokens.spacingVerticalL,
    maxWidth: "44ch",
    color: tokens.colorNeutralForeground2,
    lineHeight: tokens.lineHeightBase400,
  },
  railWrap: { marginTop: tokens.spacingVerticalXXL },
  railLabel: {
    display: "block",
    fontFamily: fonts.display,
    fontSize: tokens.fontSizeBase200,
    fontWeight: 600,
    color: tokens.colorNeutralForeground3,
    marginBottom: tokens.spacingVerticalS,
  },
  rail: { display: "flex", gap: "5px", flexWrap: "wrap" },
  tick: {
    width: "26px",
    height: "5px",
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralStroke1,
    display: "block",
  },
  tickNow: {
    backgroundColor: palette.magenta,
    boxShadow: "0 0 0 3px rgba(194,57,179,.16)",
  },
  facts: {
    marginTop: tokens.spacingVerticalXXL,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow4,
    overflow: "hidden",
  },
  fact: {
    display: "flex",
    gap: tokens.spacingHorizontalL,
    alignItems: "flex-start",
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalXL}`,
    ":not(:first-child)": { borderTop: `1px solid ${tokens.colorNeutralStroke2}` },
  },
  num: {
    flexShrink: 0,
    width: "30px",
    height: "30px",
    borderRadius: tokens.borderRadiusCircular,
    display: "grid",
    placeItems: "center",
    fontFamily: fonts.display,
    fontSize: "12.5px",
    fontWeight: 700,
    color: palette.surface,
  },
  n1: { backgroundColor: palette.action },
  n2: { backgroundColor: palette.violet },
  factTitle: {
    display: "block",
    fontFamily: fonts.display,
    fontSize: tokens.fontSizeBase400,
    fontWeight: 700,
    color: tokens.colorNeutralForeground1,
    marginBottom: "3px",
  },
  factBody: {
    display: "block",
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase400,
    color: tokens.colorNeutralForeground2,
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalL,
    flexWrap: "wrap",
    marginTop: tokens.spacingVerticalXXL,
  },
  begin: { height: "50px", paddingInline: tokens.spacingHorizontalXXL, fontFamily: fonts.display },
  note: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
});

export interface CandidateOrientationProps {
  /** Question count. 0 for an external-brain session, which has no fixed total. */
  total: number;
  isExternal: boolean;
  onBegin: () => void;
}

export function CandidateOrientation({
  total,
  isExternal,
  onBegin,
}: CandidateOrientationProps) {
  const styles = useStyles();
  const { t } = useTranslation();

  // Cap the rail: a 40-question bank would wrap into a block of ticks that reads as noise rather
  // than as a preview. Beyond 12 the count in the headline carries the information on its own.
  const ticks = isExternal ? 0 : Math.min(total, 12);

  return (
    <div className={styles.split} data-testid="candidate-orientation-split">
      <InterviewerPortrait shape="square" state="ready" className={styles.portrait} />

      <section className={styles.brief}>
        <p className={styles.kicker}>{t("orientation.title")}</p>
        <h2 className={styles.headline} data-testid="orientation-headline">
          {isExternal ? (
            <span className={styles.clause}>{t("orientation.bodyExternal")}</span>
          ) : (
            <>
              <span className={styles.clause}>
                {t("orientation.headlineLead", { total })}
              </span>
              <span className={styles.accent}>{t("orientation.headlineAccent")}</span>
            </>
          )}
        </h2>
        {!isExternal && <Body1 className={styles.lede}>{t("orientation.lede")}</Body1>}

        {ticks > 0 && (
          <div className={styles.railWrap}>
            <span className={styles.railLabel}>{t("orientation.railLabel")}</span>
            <span className={styles.rail} aria-hidden data-testid="orientation-rail">
              {Array.from({ length: ticks }, (_, i) => (
                // mergeClasses, NOT template-string concatenation: griffel resolves conflicting
                // properties through its own merge, so a raw `a + " " + b` leaves the winner to CSS
                // source order rather than intent. Concatenating here silently dropped the magenta
                // "you are here" marker — all ten ticks rendered the same beige, and it only
                // surfaced by comparing the render against the mockup.
                <i
                  key={i}
                  className={mergeClasses(styles.tick, i === 0 && styles.tickNow)}
                />
              ))}
            </span>
          </div>
        )}

        <div className={styles.facts}>
          <div className={styles.fact}>
            <span className={mergeClasses(styles.num, styles.n1)}>1</span>
            <span>
              <span className={styles.factTitle}>{t("orientation.fact1Title")}</span>
              <span className={styles.factBody}>{t("orientation.fact1Body")}</span>
            </span>
          </div>
          <div className={styles.fact}>
            <span className={mergeClasses(styles.num, styles.n2)}>2</span>
            <span>
              <span className={styles.factTitle}>{t("orientation.fact2Title")}</span>
              <span className={styles.factBody}>{t("orientation.fact2Body")}</span>
            </span>
          </div>
        </div>

        <div className={styles.actions}>
          <Button
            appearance="primary"
            onClick={onBegin}
            className={styles.begin}
            data-testid="candidate-begin"
          >
            {t("orientation.begin")}
          </Button>
          <span className={styles.note}>{t("orientation.beginNote")}</span>
        </div>
      </section>
    </div>
  );
}
