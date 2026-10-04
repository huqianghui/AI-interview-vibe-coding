/**
 * The interviewer, framed like a photograph on a wall.
 *
 * Shared by every pre-interview screen (sign-in, idle, orientation) so the same person is present
 * from the first screen onward — which is the product's actual promise, and what the sign-in screen
 * shipped without. Extracted rather than copied because the framing is fiddly in two ways that were
 * both got wrong once already: the crop window, and the `<figure>` UA margin.
 */
import { useTranslation } from "react-i18next";
import { makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import {
  CDN_BASE,
  DEFAULT_AVATAR_CHARACTER,
  DEFAULT_AVATAR_STYLE,
} from "../data/avatarCharacters";
import { fonts, palette } from "../theme";

const useStyles = makeStyles({
  frame: {
    // Load-bearing zeros: the UA stylesheet gives <figure> `margin: 1em 40px`, so overriding only
    // the block sides leaves 40px on the inline ones. That shipped on the sign-in screen and put
    // the portrait 40px right of the headline it lines up with (measured live: headline 92px,
    // frame 132px). Longhands rather than `marginInline` because jsdom does not resolve the
    // logical property back to left/right, so the guarding test could not see it.
    marginLeft: 0,
    marginRight: 0,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow4,
    padding: tokens.spacingVerticalM,
  },
  mat: {
    position: "relative",
    overflow: "hidden",
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    // The portrait PNG is transparent, so the mat supplies the studio wall.
    backgroundImage:
      "radial-gradient(76% 112% at 50% 112%, rgba(92,46,145,.20) 0%, transparent 62%), linear-gradient(180deg, #F0EAF8 0%, #DFD2EF 100%)",
  },
  square: { aspectRatio: "1 / 1" },
  tall: { aspectRatio: "4 / 5" },
  img: {
    position: "absolute",
    left: "50%",
    width: "auto",
    objectFit: "contain",
    filter: "drop-shadow(0 18px 36px rgba(36,31,26,.22))",
  },
  // Crop windows, measured against the 359x557 source rather than guessed. Square shows roughly
  // rows 10%-85% (head to hands); tall has more room so it needs less of an upward pull. Anchoring
  // to the BOTTOM instead — the obvious choice — crops the head off entirely.
  imgSquare: { top: "-13%", height: "133%", transform: "translateX(-50%)" },
  imgTall: { top: "-6%", height: "116%", transform: "translateX(-50%)" },
  pill: {
    position: "absolute",
    left: tokens.spacingHorizontalS,
    top: tokens.spacingVerticalS,
    zIndex: 2,
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    height: "26px",
    paddingInline: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: "rgba(255,253,249,.9)",
    backdropFilter: "blur(8px)",
    boxShadow: tokens.shadow2,
    fontFamily: fonts.display,
    fontSize: "11px",
    fontWeight: 700,
    letterSpacing: "0.05em",
    color: palette.ink,
  },
  dot: {
    width: "6px",
    height: "6px",
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: palette.ok,
    boxShadow: "0 0 0 3px rgba(30,122,92,.18)",
  },
  cap: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalS,
    paddingInline: tokens.spacingHorizontalXS,
    fontFamily: fonts.display,
    fontSize: tokens.fontSizeBase300,
    fontWeight: 600,
    color: tokens.colorNeutralForeground2,
  },
  capName: { color: tokens.colorNeutralForeground3, fontWeight: 500 },
});

export interface InterviewerPortraitProps {
  /** `square` for a column beside prose; `tall` when the portrait is the screen's hero. */
  shape?: "square" | "tall";
  /** Pill text. `ready` before the interview starts, `live` once a session is up. */
  state?: "ready" | "live";
  className?: string;
}

export function InterviewerPortrait({
  shape = "square",
  state = "ready",
  className,
}: InterviewerPortraitProps) {
  const styles = useStyles();
  const { t } = useTranslation();

  // Every pre-interview screen is either pre-auth or pre-`startInterview()`, so no persona is
  // loaded and none of them can know a persona-specific character. They all show the deployment's
  // DEFAULT interviewer, which is the same constant the backend falls back to.
  const src = `${CDN_BASE}/${DEFAULT_AVATAR_CHARACTER}-${DEFAULT_AVATAR_STYLE}.png`;
  const tall = shape === "tall";

  return (
    <figure
      className={mergeClasses(styles.frame, className)}
      data-testid="interviewer-portrait"
    >
      <div className={mergeClasses(styles.mat, tall ? styles.tall : styles.square)}>
        <img
          className={mergeClasses(styles.img, tall ? styles.imgTall : styles.imgSquare)}
          src={src}
          alt=""
        />
        <span className={styles.pill}>
          <i className={styles.dot} aria-hidden />
          {state === "live" ? t("candidate.livePill") : t("candidate.readyPill")}
        </span>
      </div>
      <figcaption className={styles.cap}>
        <span>{t("candidate.yourInterviewer")}</span>
        <span className={styles.capName}>{t("candidate.defaultInterviewerName")}</span>
      </figcaption>
    </figure>
  );
}
