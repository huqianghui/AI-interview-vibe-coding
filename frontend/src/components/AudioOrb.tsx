/**
 * AudioOrb (SPEC F9) — the interviewer's visual presence during a voice turn.
 *
 * A pulsating sphere whose state tracks the Voice Live audio lifecycle (idle / listening /
 * speaking / muted). This is the "avatar dominant" element of the interview layout (P11) when no
 * digital-human video track is present — WebRTC audio transport doesn't carry avatar video in
 * preview, so the orb is the primary presence. Pure CSS animation, no RAF loop.
 */
import { makeStyles, mergeClasses, tokens, Text } from "@fluentui/react-components";
import { useTranslation } from "react-i18next";
import type { AudioState } from "../types/voice";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "20px",
  },
  orbWrap: { position: "relative", display: "flex", alignItems: "center", justifyContent: "center" },
  orb: {
    width: "160px",
    height: "160px",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "transform 150ms ease, box-shadow 300ms ease",
  },
  idle: {
    background: "radial-gradient(circle at 35% 30%, #a78bfa, #7c3aed 70%)",
    boxShadow: "0 0 25px rgba(168,85,247,0.2)",
    animationName: {
      "0%": { transform: "scale(1)" },
      "50%": { transform: "scale(1.04)" },
      "100%": { transform: "scale(1)" },
    },
    animationDuration: "3.5s",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
  },
  listening: {
    background: "radial-gradient(circle at 35% 30%, #a855f7, #6d28d9 70%)",
    boxShadow: "0 0 55px rgba(168,85,247,0.45)",
    animationName: {
      "0%": { transform: "scale(1)" },
      "50%": { transform: "scale(1.09)" },
      "100%": { transform: "scale(1)" },
    },
    animationDuration: "1.4s",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
  },
  speaking: {
    background: "radial-gradient(circle at 35% 30%, #34d399, #15803d 70%)",
    boxShadow: "0 0 55px rgba(34,197,94,0.45)",
    animationName: {
      "0%": { transform: "scale(1)" },
      "50%": { transform: "scale(1.07)" },
      "100%": { transform: "scale(1)" },
    },
    animationDuration: "0.9s",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
  },
  muted: {
    background: "radial-gradient(circle at 35% 30%, #64748b, #334155 70%)",
    boxShadow: "none",
  },
  dot: { width: "16px", height: "16px", borderRadius: "50%", background: "rgba(255,255,255,0.85)" },
  label: { color: tokens.colorNeutralForeground3 },
});

const STATUS_KEY: Record<AudioState, string> = {
  idle: "voice.idle",
  listening: "voice.listening",
  speaking: "voice.speaking",
  muted: "voice.muted",
};

export function AudioOrb({ audioState }: { audioState: AudioState }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const stateClass = styles[audioState];

  return (
    <div className={styles.root} role="img" aria-label={t(STATUS_KEY[audioState])} data-testid="audio-orb">
      <div className={styles.orbWrap}>
        <div className={mergeClasses(styles.orb, stateClass)} data-testid="orb-sphere" data-state={audioState}>
          <span className={styles.dot} />
        </div>
      </div>
      <Text weight="medium" className={styles.label} data-testid="orb-status-label">
        {t(STATUS_KEY[audioState])}
      </Text>
    </div>
  );
}
