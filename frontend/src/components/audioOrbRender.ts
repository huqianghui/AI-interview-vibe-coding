/**
 * The audio orb's drawing, kept free of React so the maths can be tested without a canvas.
 *
 * One frame = a closed blob whose radius at each angle is the rest radius, a slow breath, the
 * overall loudness, and one low-order wave per voice band (bass moves the outline in broad lobes,
 * treble in finer ones). Colours are per state, the same vocabulary the status legend teaches, and
 * cross-fade rather than jump when the state changes.
 */
import { palette } from "../theme";
import type { AudioState } from "../types/voice";

export type Rgb = readonly [number, number, number];

/** A state's colours: the lit side of the sphere, its shaded rim, and the halo around it. */
export interface OrbLook {
  core: Rgb;
  edge: Rgb;
  glow: Rgb;
  /** Halo strength at rest; loudness adds to it. Zero for muted, which has no halo at all. */
  glowAlpha: number;
}

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export const ORB_LOOKS: Record<AudioState, OrbLook> = {
  idle: {
    core: hexToRgb(palette.violet),
    edge: hexToRgb(palette.action),
    glow: hexToRgb(palette.action),
    glowAlpha: 0.2,
  },
  listening: {
    core: hexToRgb(palette.magenta),
    edge: hexToRgb(palette.action),
    glow: hexToRgb(palette.magenta),
    glowAlpha: 0.32,
  },
  speaking: {
    core: hexToRgb("#5FAE8F"),
    edge: hexToRgb(palette.ok),
    glow: hexToRgb(palette.ok),
    glowAlpha: 0.3,
  },
  muted: {
    core: hexToRgb(palette.textFaint),
    edge: hexToRgb(palette.textMuted),
    glow: hexToRgb(palette.textMuted),
    glowAlpha: 0,
  },
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];

/** `t` of the way from look `a` to look `b`. */
export function mixLook(a: OrbLook, b: OrbLook, t: number): OrbLook {
  return {
    core: mixRgb(a.core, b.core, t),
    edge: mixRgb(a.edge, b.edge, t),
    glow: mixRgb(a.glow, b.glow, t),
    glowAlpha: lerp(a.glowAlpha, b.glowAlpha, t),
  };
}

/** Exponential follow with separate rise and fall times: a syllable lands at once and the orb
 * settles back gently, instead of flickering with every sample. Frame-rate independent. */
export function follow(current: number, target: number, dtMs: number, riseMs: number, fallMs: number) {
  const tau = target > current ? riseMs : fallMs;
  return target + (current - target) * Math.exp(-dtMs / tau);
}

export const ORB_RISE_MS = 60;
export const ORB_FALL_MS = 260;
/** How long a state's colours take to cross-fade into the next state's. */
export const ORB_LOOK_FADE_MS = 280;

/** Outline order and drift speed (rad/s) per band, low to high. Low bands make broad lobes. */
const BAND_WAVES: readonly { order: number; speed: number; phase: number }[] = [
  { order: 2, speed: 0.9, phase: 0 },
  { order: 3, speed: -1.3, phase: 1.7 },
  { order: 5, speed: 1.8, phase: 3.1 },
  { order: 7, speed: -2.4, phase: 4.6 },
];

/** How far, as a fraction of the rest radius, each part may push the outline. Their sum is the
 * orb's largest possible size (`ORB_MAX_SCALE`), which with `ORB_MAX_SHADOW_PX` is what AudioOrb
 * sizes its canvas from. */
const BREATH_AMP = 0.03;
const LEVEL_AMP = 0.12;
const BAND_AMP = 0.045;
const IDLE_WOBBLE_AMP = 0.012;
export const ORB_MAX_SCALE = 1 + BREATH_AMP + LEVEL_AMP + BAND_AMP * BAND_WAVES.length + IDLE_WOBBLE_AMP;
/** How many voice bands the outline responds to — what `readAudioLevels` must report. */
export const ORB_BAND_COUNT = BAND_WAVES.length;

/** The body's soft edge glow: blurred at rest by the first, plus the second at full loudness. The
 * sum is how far past the outline the drawing reaches, which AudioOrb's canvas leaves room for. */
const SHADOW_REST_PX = 16;
const SHADOW_LEVEL_PX = 14;
export const ORB_MAX_SHADOW_PX = SHADOW_REST_PX + SHADOW_LEVEL_PX;

export interface OrbFrame {
  /** Seconds since the orb mounted; drives the breath and the waves' drift. */
  timeS: number;
  /** Smoothed 0..1 loudness. */
  level: number;
  /** Smoothed 0..1 energy per band, low to high (missing bands count as silent). */
  bands: readonly number[];
  /** False under `prefers-reduced-motion`: a still, round sphere. */
  motion: boolean;
}

/** Radius at each of `points` evenly spaced angles, starting at 3 o'clock. */
export function orbRadii(points: number, restRadius: number, f: OrbFrame): number[] {
  const out: number[] = [];
  const breath = f.motion ? BREATH_AMP * Math.sin(f.timeS * ((2 * Math.PI) / 3.5)) : 0;
  for (let i = 0; i < points; i++) {
    const theta = (i / points) * 2 * Math.PI;
    let scale = 1 + breath + LEVEL_AMP * f.level;
    if (f.motion) {
      // A faint wobble even in silence, so the orb reads as alive rather than as a picture.
      scale += IDLE_WOBBLE_AMP * Math.sin(3 * theta + 0.6 * f.timeS);
      for (let k = 0; k < BAND_WAVES.length; k++) {
        const w = BAND_WAVES[k];
        const energy = f.bands[k] ?? 0;
        scale += BAND_AMP * energy * Math.sin(w.order * theta + w.speed * f.timeS + w.phase);
      }
    }
    out.push(restRadius * scale);
  }
  return out;
}

const rgba = (c: Rgb, a: number) =>
  `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${a.toFixed(3)})`;

/** Trace a smooth closed curve through the outline points (quadratic curves via the midpoints). */
function traceBlob(ctx: CanvasRenderingContext2D, cx: number, cy: number, radii: number[]) {
  const n = radii.length;
  const pt = (i: number) => {
    const theta = ((i % n) / n) * 2 * Math.PI;
    const r = radii[i % n];
    return [cx + r * Math.cos(theta), cy + r * Math.sin(theta)] as const;
  };
  const mid = (i: number) => {
    const [ax, ay] = pt(i);
    const [bx, by] = pt(i + 1);
    return [(ax + bx) / 2, (ay + by) / 2] as const;
  };
  ctx.beginPath();
  const [sx, sy] = mid(0);
  ctx.moveTo(sx, sy);
  for (let i = 1; i <= n; i++) {
    const [px, py] = pt(i);
    const [mx, my] = mid(i);
    ctx.quadraticCurveTo(px, py, mx, my);
  }
  ctx.closePath();
}

const OUTLINE_POINTS = 72;

/** Draw one frame into a canvas of CSS size `size` (the context is already scaled for the DPR). */
export function drawOrb(
  ctx: CanvasRenderingContext2D,
  size: number,
  restRadius: number,
  look: OrbLook,
  f: OrbFrame,
) {
  const c = size / 2;
  ctx.clearRect(0, 0, size, size);
  const radii = orbRadii(OUTLINE_POINTS, restRadius, f);

  // Halo: a soft outer ring that swells with loudness, then the body's own blurred shadow.
  const glow = look.glowAlpha * (1 + 1.6 * f.level);
  if (glow > 0.001) {
    // Capped at the canvas edge, where it has faded to nothing, so it is never visibly cut off.
    const haloR = Math.min(c, restRadius * (1.05 + 0.25 * f.level) * 1.35);
    const halo = ctx.createRadialGradient(c, c, restRadius * 0.8, c, c, haloR);
    halo.addColorStop(0, rgba(look.glow, Math.min(0.5, glow * 0.9)));
    halo.addColorStop(1, rgba(look.glow, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(c, c, haloR, 0, 2 * Math.PI);
    ctx.fill();
  }

  // Body: lit from the upper left, like the CSS sphere it replaces (radial-gradient at 35% 30%).
  traceBlob(ctx, c, c, radii);
  const body = ctx.createRadialGradient(
    c - restRadius * 0.3,
    c - restRadius * 0.4,
    restRadius * 0.05,
    c,
    c,
    restRadius * 1.25,
  );
  body.addColorStop(0, rgba(look.core, 1));
  body.addColorStop(0.7, rgba(look.edge, 1));
  body.addColorStop(1, rgba(look.edge, 1));
  ctx.save();
  ctx.shadowColor = rgba(look.glow, Math.min(0.6, glow));
  ctx.shadowBlur = SHADOW_REST_PX + SHADOW_LEVEL_PX * f.level;
  ctx.fillStyle = body;
  ctx.fill();
  ctx.restore();

  // Specular sheen, clipped to the body so it never spills past a pulled-in edge.
  ctx.save();
  traceBlob(ctx, c, c, radii);
  ctx.clip();
  const sheen = ctx.createRadialGradient(
    c - restRadius * 0.35,
    c - restRadius * 0.45,
    0,
    c - restRadius * 0.35,
    c - restRadius * 0.45,
    restRadius * 0.7,
  );
  sheen.addColorStop(0, "rgba(255, 255, 255, 0.28)");
  sheen.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, size, size);
  ctx.restore();

  // The centre dot the CSS orb had, so the two read as the same presence.
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.beginPath();
  ctx.arc(c, c, 8, 0, 2 * Math.PI);
  ctx.fill();
}
