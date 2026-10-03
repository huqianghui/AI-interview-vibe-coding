/**
 * AudioOrb (SPEC F9) — the interviewer's visual presence during a voice turn.
 *
 * A pulsating sphere whose state tracks the Voice Live audio lifecycle (idle / listening /
 * speaking / muted). This is the "avatar dominant" element of the interview layout (P11) when no
 * digital-human video track is present — WebRTC audio transport doesn't carry avatar video in
 * preview, so the orb is the primary presence. Pure CSS animation, no RAF loop.
 */
import { makeStyles, mergeClasses, tokens, Text } from "@fluentui/react-components";
import { palette } from "../theme";
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
    background: `radial-gradient(circle at 35% 30%, ${palette.violet}, ${palette.action} 70%)`,
    boxShadow: "0 0 25px rgba(92,46,145,0.20)",
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
    background: `radial-gradient(circle at 35% 30%, ${palette.magenta}, ${palette.action} 70%)`,
    boxShadow: "0 0 55px rgba(194,57,179,0.40)",
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
    background: `radial-gradient(circle at 35% 30%, #5FAE8F, ${palette.ok} 70%)`,
    boxShadow: "0 0 55px rgba(30,122,92,0.38)",
    animationName: {
      "0%": { transform: "scale(1)" },
      "50%": { transform: "scale(1.07)" },
      "100%": { transform: "scale(1)" },
    },
    animationDuration: "0.9s",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
  },
  // Re-tinted onto the approved palette (2026-10-03). These four gradients were off-palette
  // one-offs (#7c3aed violet, #6d28d9, and — against this direction's one hard rule — the COOL
  // GREYS #64748b / #334155 for muted). The orb is the voice-only fallback, so it appears during a
  // live interview on the warm page: left alone it read as a foreign element pasted onto the app.
  // Each state keeps its OWN hue, because the colour vocabulary is what the status legend teaches.
  muted: {
    background: `radial-gradient(circle at 35% 30%, ${palette.textFaint}, ${palette.textMuted} 70%)`,
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
