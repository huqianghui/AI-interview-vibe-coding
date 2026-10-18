/**
 * The interview stage's broadcast layout around a photo avatar (owner, 2026-10-17): one framed
 * window with a NAME PLATE over its bottom edge (who is interviewing), and a TOPIC STRIP under it
 * (what this interview is and how it works, taken from the orientation screen: guidance, never
 * the conversation). Modelled on a broadcast lower third, in the app's own palette.
 */
import { makeStyles, Text, tokens } from "@fluentui/react-components";
import { useTranslation } from "react-i18next";
import { palette } from "../theme";

/** The gap above the topic strip, and the most room the strip takes (its chips on two rows): the
 * framed window leaves this much under itself (AvatarView), so the strip is never pushed off. */
export const STRIP_GAP_PX = 22;
export const STRIP_MAX_PX = 114;

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
