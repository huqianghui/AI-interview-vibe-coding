/**
 * The candidate sign-in screen, as approved.
 *
 * This exists because the first implementation got it wrong in a way worth recording. The approved
 * direction (`docs/planning/design-ui-refresh-foundry-purple.md`, variant **D-purple**) is an
 * ASYMMETRIC EDITORIAL composition: a 58/42 split, the tagline promoted to a 32-62px display
 * headline as the page's visual hero, the interviewer's own portrait framed on a mat below it, and
 * the form panel offset DOWNWARD on the right. What shipped in v0.41.0.0 was a 440px form card
 * centred on a plain ground — which is variant **B**'s layout wearing D's palette. The palette and
 * the typefaces were right; the composition was a generic form-centring pattern that no one
 * approved, and the owner spotted it immediately ("这个应该是B").
 *
 * How: AppShell was built first, as four abstract "measures", and then the design was fitted into
 * the abstraction instead of the abstraction being built for the design. The tagline had nowhere to
 * live in a centred card, so it was moved into the header band and rationalised as fixing an
 * "orphan" — deleting the element that was supposed to be the hero.
 *
 * The verification missed it just as badly: every live check was a TOKEN check (background colour,
 * button colour, font family, one `<h1>`) and all of them pass on the wrong layout too. Composition
 * needs its own assertions, which is what `CandidateSignIn.test.tsx` is for.
 */
import { useTranslation } from "react-i18next";
import { Body1, makeStyles, tokens } from "@fluentui/react-components";
import { LoginCard, type LoginCardProps } from "./LoginCard";
import {
  CDN_BASE,
  DEFAULT_AVATAR_CHARACTER,
  DEFAULT_AVATAR_STYLE,
} from "../data/avatarCharacters";
import { fonts, layout, palette } from "../theme";

const useStyles = makeStyles({
  /** 58/42, deliberately NOT 50/50 — the asymmetry is the direction. */
  split: {
    display: "grid",
    gridTemplateColumns: "58fr 42fr",
    gap: tokens.spacingHorizontalXXL,
    maxWidth: layout.contentWidth,
    marginInline: "auto",
    paddingInline: layout.gutter,
    paddingBlock: tokens.spacingVerticalXXL,
    // 64px is the header band. border-box is REQUIRED here: this app sets no global
    // `box-sizing`, so without it `minHeight` is the CONTENT height and the 64px of vertical
    // padding is added on top — the column overran the viewport by exactly that, clipping the
    // portrait's bottom edge by 1px and giving the page a 49px scroll it should not have.
    minHeight: "calc(100vh - 64px)",
    boxSizing: "border-box",
    [`@media (max-width: ${layout.stackBelow})`]: {
      gridTemplateColumns: "1fr",
      paddingInline: layout.gutterNarrow,
      paddingBlock: tokens.spacingVerticalXL,
      minHeight: 0,
    },
  },

  /** Left: the editorial column. */
  editorial: { display: "flex", flexDirection: "column", minWidth: 0 },
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
    // The hero. clamp() so it stays the hero on a laptop and still fits a phone.
    fontSize: "clamp(32px, 4.4vw, 62px)",
    lineHeight: 1.04,
    letterSpacing: "-0.032em",
    color: palette.ink,
    margin: 0,
  },
  /**
   * One clause per line, as blocks.
   *
   * Letting the three clauses reflow inside a `max-width` broke "digital-human" across lines at
   * 1440px — the accent clause, which is the one thing that must read as a unit, split on its own
   * hyphen. Relying on a character-based max-width to land a three-line composition only works at
   * the width you happened to test. Blocks make the composition structural, so it is the same on
   * every viewport and no clause can ever be cut in half.
   *
   * It also happens to fix the portrait: at two lines the left column overran the viewport by 1px
   * and clipped the frame's bottom edge.
   */
  clause: { display: "block" },
  /** The middle clause carries the action colour against the headline's darker ink. */
  headlineAccent: { display: "block", color: palette.action },
  sub: {
    display: "block",
    marginTop: tokens.spacingVerticalXL,
    maxWidth: "34ch",
    color: tokens.colorNeutralForeground2,
    lineHeight: tokens.lineHeightBase400,
    [`@media (max-width: ${layout.stackBelow})`]: { maxWidth: "none" },
  },

  /** The interviewer's portrait, framed like a photograph on a wall. */
  frame: {
    marginTop: "auto",
    marginBottom: tokens.spacingVerticalXXL,
    width: "min(54%, 310px)",
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow4,
    padding: tokens.spacingVerticalM,
    [`@media (max-width: ${layout.stackBelow})`]: {
      marginTop: tokens.spacingVerticalXXL,
      marginBottom: 0,
      width: "min(70%, 280px)",
    },
  },
  mat: {
    position: "relative",
    overflow: "hidden",
    borderRadius: tokens.borderRadiusLarge,
    aspectRatio: "1 / 1",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    // The portrait PNG is transparent, so the mat supplies the wall.
    backgroundImage: `radial-gradient(78% 116% at 50% 112%, rgba(92,46,145,.18) 0%, transparent 62%), linear-gradient(180deg, #F0EAF8 0%, #E2D7EF 100%)`,
  },
  portrait: {
    position: "absolute",
    left: "50%",
    top: "-13%",
    transform: "translateX(-50%)",
    // 133% at -13% shows the subject from head to hands. Measured against the 359x557 source:
    // the visible window lands on roughly rows 10%-85%, which is the composition in the approved
    // mockup. Anchoring to the bottom instead cropped the head off entirely.
    height: "133%",
    width: "auto",
    objectFit: "contain",
  },
  livePill: {
    position: "absolute",
    left: tokens.spacingHorizontalS,
    top: tokens.spacingVerticalS,
    zIndex: 2,
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    height: "25px",
    paddingInline: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: "rgba(255,253,249,.88)",
    backdropFilter: "blur(8px)",
    boxShadow: tokens.shadow2,
    fontFamily: fonts.display,
    fontSize: "11px",
    fontWeight: 700,
    letterSpacing: "0.05em",
    color: palette.ink,
  },
  liveDot: {
    width: "6px",
    height: "6px",
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: palette.ok,
    boxShadow: `0 0 0 3px rgba(30,122,92,.18)`,
  },
  caption: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginTop: tokens.spacingVerticalS,
    paddingInline: tokens.spacingHorizontalXS,
    fontFamily: fonts.display,
    fontSize: tokens.fontSizeBase300,
    fontWeight: 600,
    color: tokens.colorNeutralForeground2,
  },
  captionName: { color: tokens.colorNeutralForeground3, fontWeight: 500 },

  /** Right: the form panel, offset DOWNWARD rather than vertically centred. */
  panelCol: {
    display: "flex",
    justifyContent: "center",
    paddingTop: "clamp(24px, 9vh, 104px)",
    [`@media (max-width: ${layout.stackBelow})`]: { paddingTop: tokens.spacingVerticalXXL },
  },
  panel: { width: "100%", maxWidth: layout.narrowWidth },
});

export type CandidateSignInProps = Pick<
  LoginCardProps,
  "error" | "busy" | "onSubmit"
>;

export function CandidateSignIn({ error, busy, onSubmit }: CandidateSignInProps) {
  const styles = useStyles();
  const { t } = useTranslation();

  // The sign-in screen is pre-auth, so there is no session and no persona yet — the portrait shows
  // the deployment's DEFAULT interviewer, the same constants the backend falls back to.
  const portraitUrl = `${CDN_BASE}/${DEFAULT_AVATAR_CHARACTER}-${DEFAULT_AVATAR_STYLE}.png`;

  return (
    <div className={styles.split} data-testid="candidate-signin-split">
      <section className={styles.editorial}>
        <p className={styles.kicker}>{t("candidate.loginTitle")}</p>
        {/* The tagline, promoted to the page's hero. It is one sentence in three clauses, and the
            middle one carries the accent colour — so it is split rather than interpolated, which
            also keeps each clause translatable on its own. */}
        <h2 className={styles.headline} data-testid="signin-headline">
          <span className={styles.clause}>{t("taglineLead")}</span>
          <span className={styles.headlineAccent}>{t("taglineAccent")}</span>
          <span className={styles.clause}>{t("taglineTail")}</span>
        </h2>
        <Body1 className={styles.sub}>{t("candidate.loginReassurance")}</Body1>

        <figure className={styles.frame} data-testid="signin-portrait">
          <div className={styles.mat}>
            <img className={styles.portrait} src={portraitUrl} alt="" />
            <span className={styles.livePill}>
              <i className={styles.liveDot} aria-hidden />
              {t("candidate.livePill")}
            </span>
          </div>
          <figcaption className={styles.caption}>
            <span>{t("voice.roleInterviewer")}</span>
            <span className={styles.captionName}>
              {t("candidate.defaultInterviewerName")}
            </span>
          </figcaption>
        </figure>
      </section>

      <div className={styles.panelCol}>
        <div className={styles.panel}>
          <LoginCard
            title={t("candidate.loginTitle")}
            body={t("candidate.loginBody")}
            error={error}
            busy={busy}
            onSubmit={onSubmit}
            testIdPrefix="candidate"
            titleAs="h2"
          />
        </div>
      </div>
    </div>
  );
}
