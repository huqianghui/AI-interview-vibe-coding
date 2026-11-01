/**
 * AudioOrb (SPEC F9) — the interviewer's visual presence during a voice turn.
 *
 * A glass sphere drawn on a canvas, after the Foundry Voice Live orb: its colour tracks the Voice
 * Live audio lifecycle (idle / listening / speaking / muted), and the liquid inside it and the aura
 * around it move with the actual sound — the candidate's mic while listening, the interviewer's
 * playback whenever it is audible. This is the "avatar dominant" element of the interview layout
 * (P11) when no digital-human video track is present.
 *
 * Levels are read from analysers on our own Web Audio graphs (`useVoiceAudio.readAudioLevels`),
 * not from Azure's events: the playback tap sits after the jitter buffer, so the orb moves exactly
 * as long as the candidate hears the interviewer — Azure marks a response done seconds earlier.
 * Without a reader (the agent editor's static preview) the liquid just sways.
 *
 * The drawing itself lives in `audioOrbRender.ts`. The loop stops once a muted orb has settled, and
 * under `prefers-reduced-motion` the orb is drawn once per state, with a calm surface and no rings.
 */
import { useEffect, useRef, useState } from "react";
import { makeStyles, tokens, Text } from "@fluentui/react-components";
import { useTranslation } from "react-i18next";
import type { AudioLevelReader, AudioState } from "../types/voice";
import {
  advancePhase,
  drawOrb,
  follow,
  liveliness,
  mixLook,
  newAura,
  ORB_FALL_MS,
  ORB_LOOK_FADE_MS,
  ORB_BAND_COUNT,
  ORB_LOOKS,
  ORB_MAX_EXTENT,
  ORB_RISE_MS,
  updateAura,
  type OrbLook,
} from "./audioOrbRender";

/** The sphere's resting diameter — the same 160 px the CSS orb had, so layouts don't shift. */
const ORB_REST_RADIUS = 80;
/** The canvas is larger than the sphere so the aura and its rings are never cut off; the negative
 * margin gives that room back, so the orb still occupies 160 px in the layout. */
const CANVAS_PX = 2 * Math.ceil(ORB_REST_RADIUS * ORB_MAX_EXTENT);
const CANVAS_BLEED_PX = (CANVAS_PX - 2 * ORB_REST_RADIUS) / 2;
/** Beyond 2× the edge is already sharp at this size, and a 3× canvas is 2.25× the pixels to fill. */
const MAX_DPR = 2;

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "20px",
  },
  orbWrap: {
    position: "relative",
    width: `${2 * ORB_REST_RADIUS}px`,
    height: `${2 * ORB_REST_RADIUS}px`,
  },
  canvas: {
    display: "block",
    width: `${CANVAS_PX}px`,
    height: `${CANVAS_PX}px`,
    margin: `-${CANVAS_BLEED_PX}px`,
    pointerEvents: "none",
  },
  label: { color: tokens.colorNeutralForeground3 },
});

const STATUS_KEY: Record<AudioState, string> = {
  idle: "voice.idle",
  listening: "voice.listening",
  speaking: "voice.speaking",
  muted: "voice.muted",
};

/** How often a parked (muted, settled) orb checks whether the interviewer has started speaking, and
 * how loud they must be to wake it. */
const PARKED_CHECK_MS = 250;
const PARKED_WAKE_LEVEL = 0.02;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function usePrefersReducedMotion(): boolean {
  const get = () => typeof window !== "undefined" && !!window.matchMedia?.(REDUCED_MOTION_QUERY).matches;
  const [reduced, setReduced] = useState(get);
  useEffect(() => {
    const mq = typeof window !== "undefined" ? window.matchMedia?.(REDUCED_MOTION_QUERY) : undefined;
    if (!mq) return;
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

const SILENT = { level: 0, bands: [] as readonly number[] };

/** What the orb should be showing right now: the louder of what the candidate hears and (only
 * while listening) what they are saying. Muted silences the candidate's side only: the interviewer
 * can still be heard while the candidate is muted, so the grey orb still moves with them. */
function readTarget(reader: AudioLevelReader | undefined, state: AudioState) {
  if (!reader) return SILENT;
  const playback = reader("playback");
  const mic = state === "listening" ? reader("mic") : null;
  const pick = (mic?.level ?? 0) > (playback?.level ?? 0) ? mic : playback;
  return { level: pick?.level ?? 0, bands: pick?.bands ?? [] };
}

export function AudioOrb({
  audioState,
  readAudioLevels,
}: {
  audioState: AudioState;
  readAudioLevels?: AudioLevelReader;
}) {
  const styles = useStyles();
  const { t } = useTranslation();
  const reducedMotion = usePrefersReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // The loop reads these through refs so a state change never restarts it (and never resets the
  // smoothing or the colour cross-fade mid-way).
  const stateRef = useRef(audioState);
  stateRef.current = audioState;
  const readerRef = useRef(readAudioLevels);
  readerRef.current = readAudioLevels;
  /** Restarts a loop that stopped on a settled muted orb. Set by the effect below. */
  const wakeRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const canvas = canvasRef.current;
    // jsdom (unit tests) has no 2D context; the orb's state attributes still render.
    const ctx = canvas?.getContext?.("2d") ?? null;
    if (!canvas || !ctx) return;
    // The orb is decoration: a canvas that cannot draw (a lost GPU context, a partial stub) must
    // leave a blank circle and a working interview, never an exception out of a React effect.
    let failed = false;
    let readFailed = false; // only to log a failing reader once, not 60 times a second
    const safely = (draw: () => void) => {
      if (failed) return;
      try {
        draw();
      } catch (err) {
        failed = true;
        console.warn("[audio-orb] canvas drawing failed — the orb stays blank", err);
      }
    };
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    canvas.width = Math.round(CANVAS_PX * dpr);
    canvas.height = Math.round(CANVAS_PX * dpr);
    safely(() => ctx.setTransform(dpr, 0, 0, dpr, 0, 0));

    let look: OrbLook = ORB_LOOKS[stateRef.current];
    let level = 0;
    let phase = 0;
    const aura = newAura();
    const bands = new Array<number>(ORB_BAND_COUNT).fill(0);
    const start = performance.now();
    let last = start;
    let raf = 0;

    if (reducedMotion) {
      // One still frame per state; the effect below re-runs this through `wakeRef`.
      let painted: AudioState | null = null;
      const paint = () => {
        if (painted === stateRef.current) return;
        painted = stateRef.current;
        safely(() =>
          drawOrb(
            ctx,
            CANVAS_PX,
            ORB_REST_RADIUS,
            ORB_LOOKS[stateRef.current],
            { timeS: 0, phase: 0, level: 0, bands, motion: false },
            aura,
          ),
        );
      };
      paint();
      wakeRef.current = paint;
      return () => {
        wakeRef.current = () => undefined;
      };
    }

    const frame = (now: number) => {
      const dt = Math.min(100, now - last); // a backgrounded tab resumes without a jump
      last = now;
      const state = stateRef.current;
      // Read outside `safely`, but never allowed to escape: a throw here would skip the reschedule
      // below and leave the loop dead with a stale `raf`, so nothing could wake it again. A reader
      // that fails reads as silence for this frame, and the orb keeps drawing.
      let target = SILENT;
      try {
        target = readTarget(readerRef.current, state);
      } catch (err) {
        if (!readFailed) console.warn("[audio-orb] reading the audio level failed — drawing silence", err);
        readFailed = true;
      }
      level = follow(level, target.level, dt, ORB_RISE_MS, ORB_FALL_MS);
      for (let k = 0; k < ORB_BAND_COUNT; k++) {
        bands[k] = follow(bands[k], target.bands[k] ?? 0, dt, ORB_RISE_MS, ORB_FALL_MS);
      }
      look = mixLook(look, ORB_LOOKS[state], 1 - Math.exp(-dt / (ORB_LOOK_FADE_MS / 3)));
      const timeS = (now - start) / 1000;
      phase = advancePhase(phase, dt, level, liveliness(look));
      updateAura(aura, level, timeS);
      safely(() =>
        drawOrb(ctx, CANVAS_PX, ORB_REST_RADIUS, look, { timeS, phase, level, bands, motion: true }, aura),
      );
      // A muted orb is grey and still: once it has faded there, gone quiet and its last ring has
      // spread out, stop drawing, and only listen for the interviewer (who can still speak to a
      // muted candidate) to start again.
      const settled =
        state === "muted" &&
        level < 0.002 &&
        aura.rings.length === 0 &&
        Math.abs(look.glowAlpha - ORB_LOOKS.muted.glowAlpha) < 0.002;
      if (failed) raf = 0;
      else if (settled) {
        raf = 0;
        parkedTimer = setTimeout(checkParked, PARKED_CHECK_MS);
      } else raf = requestAnimationFrame(frame);
    };
    /** While parked: a cheap look at the playback level, four times a second, instead of a redraw
     * sixty times a second. */
    const checkParked = () => {
      parkedTimer = undefined;
      let heard = 0;
      try {
        heard = readTarget(readerRef.current, stateRef.current).level;
      } catch {
        // the frame loop logs a failing reader; here it only means "nothing heard"
      }
      if (heard > PARKED_WAKE_LEVEL) wakeRef.current();
      else parkedTimer = setTimeout(checkParked, PARKED_CHECK_MS);
    };
    let parkedTimer: ReturnType<typeof setTimeout> | undefined;
    raf = requestAnimationFrame(frame);
    wakeRef.current = () => {
      if (raf || failed) return;
      clearTimeout(parkedTimer);
      parkedTimer = undefined;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(parkedTimer);
      raf = 0;
      wakeRef.current = () => undefined;
    };
  }, [reducedMotion]);

  useEffect(() => {
    wakeRef.current();
  }, [audioState]);

  return (
    <div className={styles.root} role="img" aria-label={t(STATUS_KEY[audioState])} data-testid="audio-orb">
      <div className={styles.orbWrap} data-testid="orb-sphere" data-state={audioState}>
        <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" data-testid="orb-canvas" />
      </div>
      <Text weight="medium" className={styles.label} data-testid="orb-status-label">
        {t(STATUS_KEY[audioState])}
      </Text>
    </div>
  );
}
