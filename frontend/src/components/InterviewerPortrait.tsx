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
import { interviewerIdentity } from "../data/avatarCharacters";
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
  // A PHOTO avatar's thumbnail is an opaque square with its own wall, so it fills the frame instead
  // of being cropped like a transparent cut-out (which showed only the top of the head).
  imgPhoto: {
    inset: 0,
    left: 0,
    width: "100%",
    height: "100%",
    objectFit: "cover",
    objectPosition: "50% 20%",
    filter: "none",
  },
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
  /** The session's avatar character once known; blank = the deployment's default interviewer. */
  character?: string | null;
  /** The character is still being looked up: blank portrait and name, never the wrong person. */
  pending?: boolean;
  className?: string;
}

export function InterviewerPortrait({
  shape = "square",
  state = "ready",
  character,
  pending = false,
  className,
}: InterviewerPortraitProps) {
  const styles = useStyles();
  const { t } = useTranslation();

  // Idle runs before `startInterview()` and passes the candidate's assigned character (looked up
  // ahead of the session); orientation passes the session's own. Blank = the default interviewer.
  // Name and picture both come from the roster.
  const { name, portraitUrl: src, isPhoto } = interviewerIdentity(character);
  const tall = shape === "tall";

  return (
    <figure
      className={mergeClasses(styles.frame, className)}
      data-testid="interviewer-portrait"
    >
      <div className={mergeClasses(styles.mat, tall ? styles.tall : styles.square)}>
        {!pending && (
          <img
            className={mergeClasses(
              styles.img,
              isPhoto ? styles.imgPhoto : tall ? styles.imgTall : styles.imgSquare,
            )}
            src={src}
            alt=""
          />
        )}
        <span className={styles.pill}>
          <i className={styles.dot} aria-hidden />
          {state === "live" ? t("candidate.livePill") : t("candidate.readyPill")}
        </span>
      </div>
      <figcaption className={styles.cap}>
        <span>{t("candidate.yourInterviewer")}</span>
        <span className={styles.capName}>{pending ? "" : name}</span>
      </figcaption>
    </figure>
  );
}
