/**
 * Idle: signed in, nothing started.
 *
 * What shipped before this was ONE full-width "Start interview" button at the top of an otherwise
 * empty 900px page — and full-width by accident, from the same `align-items: stretch` that blew up
 * the orientation button.
 *
 * The composition deliberately INVERTS the sign-in screen's weighting. There, the headline was the
 * hero and the portrait a supporting note. Here the candidate has already signed in and the only
 * thing left to decide is "shall we begin", so the person they are about to talk to becomes the
 * hero and the product's actual promise is on screen instead of a button on a void.
 *
 * What this screen can HONESTLY say is constrained: the interview does not exist until
 * `startInterview()` runs, so there is no question count and no persona here. It states the three
 * facts that hold regardless, and points forward for the count rather than inventing one.
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
    // 46/54, portrait dominant. Not 50/50 — the asymmetry is the direction.
    gridTemplateColumns: "46fr 54fr",
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
    maxWidth: "460px",
    marginLeft: "auto",
    [`@media (max-width: ${layout.stackBelow})`]: { marginInline: "auto", maxWidth: "340px" },
  },
  brief: { minWidth: 0, maxWidth: "560px" },
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
    fontSize: "clamp(28px, 3.4vw, 46px)",
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
    maxWidth: "42ch",
    color: tokens.colorNeutralForeground2,
    lineHeight: tokens.lineHeightBase400,
  },
  /** The purple ramp doing work rather than only tinting a button. */
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
  n3: { backgroundColor: palette.magenta },
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
  /** Explicit height/padding so this is never the accidental full-width banner it used to be. */
  start: { height: "50px", paddingInline: tokens.spacingHorizontalXXL, fontFamily: fonts.display },
  note: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
});

export interface CandidateIdleProps {
  busy: boolean;
  onStart: () => void;
}

export function CandidateIdle({ busy, onStart }: CandidateIdleProps) {
  const styles = useStyles();
  const { t } = useTranslation();

  const facts = [
    { n: styles.n1, title: "candidate.idle.fact1Title", body: "candidate.idle.fact1Body" },
    { n: styles.n2, title: "candidate.idle.fact2Title", body: "candidate.idle.fact2Body" },
    { n: styles.n3, title: "candidate.idle.fact3Title", body: "candidate.idle.fact3Body" },
  ];

  return (
    <div className={styles.split} data-testid="candidate-idle-split">
      <InterviewerPortrait shape="tall" state="ready" className={styles.portrait} />

      <section className={styles.brief}>
        <p className={styles.kicker}>{t("candidate.idle.kicker")}</p>
        <h2 className={styles.headline} data-testid="idle-headline">
          <span className={styles.clause}>{t("candidate.idle.headlineLead")}</span>
          <span className={styles.accent}>{t("candidate.idle.headlineAccent")}</span>
        </h2>
        <Body1 className={styles.lede}>{t("candidate.idle.lede")}</Body1>

        <div className={styles.facts} data-testid="idle-facts">
          {facts.map((f, i) => (
            <div key={f.title} className={styles.fact}>
              <span className={mergeClasses(styles.num, f.n)}>{i + 1}</span>
              <span>
                <span className={styles.factTitle}>{t(f.title)}</span>
                <span className={styles.factBody}>{t(f.body)}</span>
              </span>
            </div>
          ))}
        </div>

        <div className={styles.actions}>
          <Button
            appearance="primary"
            disabled={busy}
            onClick={onStart}
            className={styles.start}
            data-testid="candidate-start"
          >
            {busy ? t("starting") : t("start")}
          </Button>
          <span className={styles.note}>{t("candidate.idle.startNote")}</span>
        </div>
      </section>
    </div>
  );
}
