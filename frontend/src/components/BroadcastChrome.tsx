/**
 * The interview stage's broadcast layout around a photo avatar (owner, 2026-10-17): one framed
 * window with a NAME PLATE over its bottom edge (who is interviewing), and a TOPIC STRIP under it
 * (what this interview is and how it works, taken from the orientation screen: guidance, never
 * the conversation). Modelled on a broadcast lower third, in the app's own palette.
 */
import { useEffect, useRef, useState } from "react";
import { makeStyles, mergeClasses, Text, tokens } from "@fluentui/react-components";
import { useTranslation } from "react-i18next";
import { fonts, palette } from "../theme";

/** The gap above the topic strip, and the most room the strip takes (its chips on two rows): the
 * framed window leaves this much under itself (AvatarView), so the strip is never pushed off. */
export const STRIP_GAP_PX = 22;
export const STRIP_MAX_PX = 114;
/** Template B: the masthead's height (the window sits below it), and the side notes' width and
 * gap; they show only when the free width beside the window holds them (`SideNotes`). */
export const MASTHEAD_PX = 46;
const SIDE_NOTE_PX = 170;
const SIDE_GAP_PX = 34;
/** The tips need this much height under the strip, the closing line this much more. */
const TIPS_MIN_PX = 150;
const QUOTE_MIN_PX = 240;
const CROP_LINE = `1px solid ${palette.textFaint}`;

const useStyles = makeStyles({
  plate: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 20,
    display: "flex",
    alignItems: "stretch",
    minHeight: "56px",
    backgroundColor: palette.surface,
    boxShadow: "0 -2px 10px rgba(40, 20, 70, 0.12)",
  },
  plateName: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: "34%",
    paddingLeft: "18px",
    paddingRight: "26px",
    backgroundColor: palette.action,
    color: "#fff",
    // The slanted edge of a broadcast lower third.
    clipPath: "polygon(0 0, 100% 0, calc(100% - 18px) 100%, 0 100%)",
    fontSize: tokens.fontSizeBase500,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: "0.01em",
  },
  plateRole: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    gap: "2px",
    paddingLeft: "10px",
    paddingRight: "14px",
    minWidth: 0,
  },
  roleTitle: { color: palette.ink, fontWeight: tokens.fontWeightSemibold },
  roleNote: { color: tokens.colorNeutralForeground3 },
  strip: {
    display: "flex",
    alignItems: "stretch",
    width: "100%",
    maxWidth: "760px",
    marginTop: `${STRIP_GAP_PX}px`,
    borderRadius: "10px",
    overflow: "hidden",
    backgroundColor: palette.ink,
    color: "#fff",
    boxShadow: "0 10px 26px rgba(40, 20, 70, 0.22)",
    flexShrink: 0,
  },
  stripLead: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "2px",
    minWidth: "150px",
    padding: "10px 16px",
    backgroundColor: palette.action,
  },
  stripKicker: {
    color: palette.lilac,
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
  },
  stripCount: { fontWeight: tokens.fontWeightSemibold },
  stripBody: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    gap: "8px",
    padding: "10px 18px",
    minWidth: 0,
  },
  stripTitle: {
    fontWeight: tokens.fontWeightSemibold,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  chips: { display: "flex", flexWrap: "wrap", gap: "6px" },
  chip: {
    padding: "2px 10px",
    borderRadius: "999px",
    backgroundColor: "rgba(255, 255, 255, 0.14)",
    fontSize: tokens.fontSizeBase200,
  },
  masthead: {
    fontFamily: fonts.display,
    position: "absolute",
    top: "14px",
    left: "40px",
    right: "40px",
    zIndex: 1,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: "16px",
    paddingBottom: "6px",
    borderBottom: `1px solid ${palette.line}`,
    color: palette.textFaint,
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: "0.16em",
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  },
  mastheadTitle: { color: palette.ink, letterSpacing: "0.22em" },
  crop: { position: "absolute", width: "20px", height: "20px" },
  // 14 px outside the window: clear of its 7 px frame, and of the masthead's rule above and the
  // topic strip below (22 px under the window).
  cropTL: { left: "-14px", top: "-14px", borderTop: CROP_LINE, borderLeft: CROP_LINE },
  cropTR: { right: "-14px", top: "-14px", borderTop: CROP_LINE, borderRight: CROP_LINE },
  cropBL: { left: "-14px", bottom: "-14px", borderBottom: CROP_LINE, borderLeft: CROP_LINE },
  cropBR: { right: "-14px", bottom: "-14px", borderBottom: CROP_LINE, borderRight: CROP_LINE },
  side: {
    position: "absolute",
    top: "72px",
    width: `${SIDE_NOTE_PX}px`,
    color: palette.textMuted,
    fontSize: tokens.fontSizeBase300,
    lineHeight: 1.5,
  },
  sideLeft: { right: `calc(100% + ${SIDE_GAP_PX}px)` },
  sideRight: { left: `calc(100% + ${SIDE_GAP_PX}px)`, textAlign: "right" },
  sideKicker: {
    fontFamily: fonts.display,
    display: "block",
    marginBottom: "8px",
    color: palette.ink,
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: "0.16em",
    textTransform: "uppercase",
  },
  sideBig: {
    fontFamily: fonts.display,
    display: "block",
    color: palette.ink,
    fontSize: "54px",
    fontWeight: tokens.fontWeightBold,
    lineHeight: 1,
  },
  brief: {
    flex: 1,
    minHeight: 0,
    width: "100%",
    maxWidth: "940px",
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    padding: "26px 40px 24px",
    overflow: "hidden",
  },
  tips: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: "30px",
    paddingTop: "18px",
    borderTop: `1px solid ${palette.line}`,
  },
  tipNumber: {
    display: "block",
    fontFamily: fonts.display,
    color: palette.lilac,
    fontSize: "32px",
    fontWeight: tokens.fontWeightBold,
  },
  tipTitle: {
    display: "block",
    margin: "2px 0 6px",
    fontFamily: fonts.display,
    color: palette.ink,
    fontWeight: tokens.fontWeightSemibold,
  },
  tipBody: { color: palette.textMuted, lineHeight: 1.5 },
  quote: {
    textAlign: "center",
    color: palette.ink,
    fontStyle: "italic",
    fontSize: tokens.fontSizeBase500,
    "::before": {
      content: '""',
      display: "block",
      width: "60px",
      margin: "0 auto 14px",
      borderTop: `2px solid ${palette.gold}`,
    },
  },
});

/** Who is interviewing: the name, and that the questions are read exactly as written. */
export function NamePlate({ name }: { name: string }) {
  const styles = useStyles();
  const { t } = useTranslation();
  return (
    <div className={styles.plate} data-testid="stage-name-plate">
      <div className={styles.plateName}>{name}</div>
      <div className={styles.plateRole}>
        <Text size={300} className={styles.roleTitle}>
          {t("stage.role")}
        </Text>
        <Text size={200} className={styles.roleNote}>
          {t("stage.roleNote")}
        </Text>
      </div>
    </div>
  );
}

/** What this interview is and how it works. `total` is null when the interviewer drives the flow
 * (no fixed question count), as on the orientation screen. */
export function TopicStrip({ title, total }: { title: string | null; total: number | null }) {
  const styles = useStyles();
  const { t } = useTranslation();
  return (
    <div className={styles.strip} data-testid="stage-topic-strip">
      <div className={styles.stripLead}>
        <span className={styles.stripKicker}>{t("stage.kicker")}</span>
        <Text size={400} className={styles.stripCount}>
          {total ? t("stage.questions", { count: total }) : t("stage.guided")}
        </Text>
      </div>
      <div className={styles.stripBody}>
        <Text
          size={400}
          className={styles.stripTitle}
          title={title || undefined}
          data-testid="stage-topic-title"
        >
          {title || t("stage.untitled")}
        </Text>
        <div className={styles.chips}>
          {(["chipChannel", "chipDone", "chipPace"] as const).map((k) => (
            <span key={k} className={styles.chip}>
              {t(`stage.${k}`)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export type StageVoice = "ready" | "listening" | "speaking" | "muted";

/** Template B's masthead: the page's name for itself, and where the candidate is. */
export function Masthead({
  index,
  total,
  language,
  voice,
}: {
  index: number | null;
  total: number | null;
  language: string;
  voice: StageVoice;
}) {
  const styles = useStyles();
  const { t } = useTranslation();
  const pad = (n: number) => String(n).padStart(2, "0");
  const where = index && total ? `${t("stage.issue")} ${pad(index)} / ${pad(total)} · ` : "";
  return (
    <div className={styles.masthead} data-testid="stage-masthead">
      <span className={styles.mastheadTitle}>{t("stage.masthead")}</span>
      <span>{`${where}${language} · ${t(`stage.voice.${voice}`)}`}</span>
    </div>
  );
}

/** Printer's crop marks at the window's four corners (drawn in the window's own box). */
export function CropMarks() {
  const styles = useStyles();
  return (
    <>
      {(["cropTL", "cropTR", "cropBL", "cropBR"] as const).map((k) => (
        <span key={k} className={mergeClasses(styles.crop, styles[k])} data-testid="stage-crop-mark" />
      ))}
    </>
  );
}

/** The two notes beside the window: which question this is, and the voice's state in calm words.
 * Shown only when the free width beside the window holds them. */
export function SideNotes({
  gutter,
  index,
  total,
  voice,
}: {
  gutter: number;
  index: number | null;
  total: number | null;
  voice: StageVoice;
}) {
  const styles = useStyles();
  const { t } = useTranslation();
  if (gutter < SIDE_NOTE_PX + SIDE_GAP_PX + 16) return null;
  return (
    <>
      {index && total ? (
        <div className={mergeClasses(styles.side, styles.sideLeft)} data-testid="stage-side-question">
          <span className={styles.sideKicker}>{t("stage.thisQuestion")}</span>
          <span className={styles.sideBig}>{String(index).padStart(2, "0")}</span>
          {t("stage.ofTotal", { count: total })}
        </div>
      ) : null}
      <div className={mergeClasses(styles.side, styles.sideRight)} data-testid="stage-side-voice">
        <span className={styles.sideKicker}>{t("stage.yourVoice")}</span>
        {t(`stage.voiceNote.${voice}`)}
      </div>
    </>
  );
}

/** Numbered tips and a closing line, in the space left under the strip: each shows only when it
 * fits, so a short screen gets fewer words rather than clipped ones. */
export function StageBrief() {
  const styles = useStyles();
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setRoom(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className={styles.brief} data-testid="stage-brief">
      {room >= TIPS_MIN_PX && (
        <div className={styles.tips} data-testid="stage-tips">
          {([1, 2, 3] as const).map((n) => (
            <div key={n}>
              <span className={styles.tipNumber}>{`0${n}`}</span>
              <Text size={400} className={styles.tipTitle}>
                {t(`stage.tip${n}Title`)}
              </Text>
              <Text size={300} className={styles.tipBody}>
                {t(`stage.tip${n}Body`)}
              </Text>
            </div>
          ))}
        </div>
      )}
      {room >= QUOTE_MIN_PX && (
        <Text className={styles.quote} data-testid="stage-quote">
          {t("stage.quote")}
        </Text>
      )}
    </div>
  );
}
