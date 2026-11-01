/**
 * The audio orb's drawing, kept free of React so the maths can be tested without a canvas.
 *
 * Modelled on the Foundry Voice Live orb: a still glass sphere, pale at the top, with a liquid in
 * the state's colour filling the lower half. The voice moves the liquid, not the glass: louder
 * speech raises the surface and roughens it (low voice bands swell the long wave, high bands the
 * short ripple), and a bright crest line rides the surface. Around the sphere, a soft aura glows
 * with the level and a ring ripples outward on each loud syllable. Colours are per state, the
 * vocabulary the status legend teaches, and cross-fade when the state changes.
 */
import { palette } from "../theme";
import type { AudioState } from "../types/voice";

export type Rgb = readonly [number, number, number];

/** A state's colours: the glass above the liquid, the liquid at its surface and at the bottom, and
 * the aura around the sphere. */
export interface OrbLook {
  top: Rgb;
  surface: Rgb;
  deep: Rgb;
  glow: Rgb;
  /** Aura strength at rest; loudness adds to it. Zero for muted, which has no aura at all. */
  glowAlpha: number;
}

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];
const WHITE: Rgb = [255, 255, 255];

/** A state's look from its two palette colours: `light` lights the liquid's surface and tints the
 * glass, `deep` is the bottom of the liquid and the aura. */
function lookFrom(light: string, deep: string, glowAlpha: number): OrbLook {
  const surface = hexToRgb(light);
  return {
    top: mixRgb(surface, WHITE, 0.86),
    surface: mixRgb(surface, WHITE, 0.18),
    deep: hexToRgb(deep),
    glow: surface,
    glowAlpha,
  };
}

export const ORB_LOOKS: Record<AudioState, OrbLook> = {
  idle: lookFrom(palette.violet, palette.action, 0.14),
  listening: lookFrom(palette.magenta, palette.action, 0.2),
  speaking: lookFrom("#5FAE8F", palette.ok, 0.2),
  muted: lookFrom(palette.textFaint, palette.textMuted, 0),
};

/** `t` of the way from look `a` to look `b`. */
export function mixLook(a: OrbLook, b: OrbLook, t: number): OrbLook {
  return {
    top: mixRgb(a.top, b.top, t),
    surface: mixRgb(a.surface, b.surface, t),
    deep: mixRgb(a.deep, b.deep, t),
    glow: mixRgb(a.glow, b.glow, t),
    glowAlpha: lerp(a.glowAlpha, b.glowAlpha, t),
  };
}

/** Exponential follow with separate rise and fall times: a syllable lands at once and the orb
 * settles back gently, instead of flickering with every sample. Frame-rate independent. */
export function follow(current: number, target: number, dtMs: number, riseMs: number, fallMs: number) {
  // A non-finite input would otherwise stick (NaN in, NaN out) until a gradient throws on it and the
  // orb goes blank for the rest of the session; read it as silence instead.
  if (!Number.isFinite(current)) current = 0;
  if (!Number.isFinite(target)) target = 0;
  if (!Number.isFinite(dtMs) || dtMs < 0) dtMs = 0;
  const tau = target > current ? riseMs : fallMs;
  return target + (current - target) * Math.exp(-dtMs / tau);
}

export const ORB_RISE_MS = 60;
export const ORB_FALL_MS = 260;
/** How long a state's colours take to cross-fade into the next state's. */
export const ORB_LOOK_FADE_MS = 280;

/** How many voice bands the liquid responds to — what `readAudioLevels` must report. The first
 * half swells the long wave, the second half the short ripple. */
export const ORB_BAND_COUNT = 4;

/** Wave drift in rad/s: a slow sway at rest, faster with the voice. */
const WAVE_REST_SPEED = 1.1;
const WAVE_LEVEL_SPEED = 2.6;

/** Advance the waves' phase by one frame. The phase is accumulated rather than computed as
 * `time × speed`, because the speed follows the voice and multiplying a changing speed by a large
 * time would jump the waves sideways every time the level moved. */
export function advancePhase(phase: number, dtMs: number, level: number, liveliness: number): number {
  const speed = (WAVE_REST_SPEED + WAVE_LEVEL_SPEED * level) * liveliness;
  return (phase + (dtMs / 1000) * speed) % (2 * Math.PI * 1000);
}

/** 0 for a muted orb's flat, still liquid, 1 for every other state, and in between while the
 * colours cross-fade, so the liquid calms as it greys instead of snapping flat at the end. */
export function liveliness(look: OrbLook): number {
  return Math.min(1, Math.max(0, look.glowAlpha / ORB_LOOKS.idle.glowAlpha));
}

// ── Aura rings ────────────────────────────────────────────────────────────────────────────────

/** A ring is born when the level rises through this, at most once per `RING_GAP_S`, and lives for
 * `RING_LIFE_S` while it spreads from the glass outward. */
const RING_TRIGGER = 0.45;
const RING_GAP_S = 0.18;
const RING_LIFE_S = 1.6;
const RING_SPREAD = 0.42; // how far past the glass a ring travels, as a fraction of the radius
const MAX_RINGS = 8;

export interface AuraState {
  rings: { bornS: number; strength: number }[];
  prevLevel: number;
  lastBornS: number;
}

export function newAura(): AuraState {
  return { rings: [], prevLevel: 0, lastBornS: -Infinity };
}

/** Birth and expire rings for this frame. Mutates and returns `aura`. */
export function updateAura(aura: AuraState, level: number, timeS: number): AuraState {
  if (level > RING_TRIGGER && aura.prevLevel <= RING_TRIGGER && timeS - aura.lastBornS > RING_GAP_S) {
    aura.rings.push({ bornS: timeS, strength: level });
    aura.lastBornS = timeS;
    if (aura.rings.length > MAX_RINGS) aura.rings.shift();
  }
  aura.prevLevel = level;
  aura.rings = aura.rings.filter((r) => timeS - r.bornS < RING_LIFE_S);
  return aura;
}

/** How far past the rest radius the drawing ever reaches (the aura's outer edge), as a multiple of
 * it. AudioOrb sizes its canvas from this. */
export const ORB_MAX_EXTENT = 1.5;

// ── Liquid ──────────────────────────────────────────────────────────────────────────────────────

export interface OrbFrame {
  /** Seconds since the orb mounted: ages the aura rings. */
  timeS: number;
  /** The waves' accumulated phase (see `advancePhase`). */
  phase: number;
  /** Smoothed 0..1 loudness. */
  level: number;
  /** Smoothed 0..1 energy per band, low to high (missing bands count as silent). */
  bands: readonly number[];
  /** False under `prefers-reduced-motion`: a still sphere with a calm surface. */
  motion: boolean;
}

/** Where the liquid's surface sits and how rough it is, in px from the sphere's top-left. */
export function liquidSurface(restRadius: number, centre: number, f: OrbFrame, live: number) {
  const level = f.motion ? f.level : 0;
  // Rest just below the middle; a loud voice lifts it by up to a sixth of the radius.
  const base = centre + restRadius * (0.08 - 0.16 * level);
  const amp = lerp(FLAT_AMP_PX, restRadius * (0.035 + 0.12 * level), live);
  const half = ORB_BAND_COUNT / 2;
  let low = 0;
  let high = 0;
  for (let k = 0; k < ORB_BAND_COUNT; k++) {
    if (k < half) low += f.bands[k] ?? 0;
    else high += f.bands[k] ?? 0;
  }
  return {
    base,
    /** Height of the long wave, then of the short ripple riding on it. */
    long: amp * (0.8 + 0.4 * (low / half)),
    short: amp * (0.3 + 0.5 * (high / half)),
  };
}

/** The surface's y at horizontal position `u` (0 = left edge of the sphere, 1 = right). */
export function surfaceY(u: number, s: ReturnType<typeof liquidSurface>, phase: number, offset = 0) {
  return (
    s.base +
    s.long * Math.sin(u * 1.8 * Math.PI + phase + offset) +
    s.short * Math.sin(u * 3.1 * Math.PI - phase * 1.3 + offset * 2)
  );
}

/** A muted orb's surface is not quite a ruler line, so it still reads as liquid. */
const FLAT_AMP_PX = 0.6;

const rgba = (c: Rgb, a: number) =>
  `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${a.toFixed(3)})`;

const SURFACE_STEP_PX = 2;

function traceLiquid(
  ctx: CanvasRenderingContext2D,
  c: number,
  r: number,
  s: ReturnType<typeof liquidSurface>,
  phase: number,
  offset: number,
  closed: boolean,
) {
  ctx.beginPath();
  let first = true;
  for (let x = c - r - SURFACE_STEP_PX; x <= c + r + SURFACE_STEP_PX; x += SURFACE_STEP_PX) {
    const y = surfaceY((x - (c - r)) / (2 * r), s, phase, offset);
    if (first) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    first = false;
  }
  if (closed) {
    ctx.lineTo(c + r + SURFACE_STEP_PX, c + r + SURFACE_STEP_PX);
    ctx.lineTo(c - r - SURFACE_STEP_PX, c + r + SURFACE_STEP_PX);
    ctx.closePath();
  }
}

/** Draw one frame into a canvas of CSS size `size` (the context is already scaled for the DPR).
 * `aura` carries the rings between frames; pass the same object every frame. */
export function drawOrb(
  ctx: CanvasRenderingContext2D,
  size: number,
  restRadius: number,
  look: OrbLook,
  f: OrbFrame,
  aura: AuraState,
) {
  const c = size / 2;
  const level = f.motion ? f.level : 0;
  const live = liveliness(look);
  ctx.clearRect(0, 0, size, size);

  // Contact shadow on the stage, so the sphere sits on it rather than floating.
  const shadowY = c + restRadius + 10;
  ctx.save();
  ctx.translate(c, shadowY);
  ctx.scale(1, 0.18);
  const contact = ctx.createRadialGradient(0, 0, 2, 0, 0, restRadius * 0.95);
  contact.addColorStop(0, rgba(look.deep, 0.16 + 0.06 * level));
  contact.addColorStop(1, rgba(look.deep, 0));
  ctx.fillStyle = contact;
  ctx.beginPath();
  ctx.arc(0, 0, restRadius * 0.95, 0, 2 * Math.PI);
  ctx.fill();
  ctx.restore();

  // Aura: a glow that grows with the level, and the rings loud syllables send outward.
  if (look.glowAlpha > 0.001) {
    const outer = Math.min(c, restRadius * (1.35 + 0.15 * level));
    const halo = ctx.createRadialGradient(c, c, restRadius * 0.9, c, c, outer);
    halo.addColorStop(0, rgba(look.glow, look.glowAlpha * (0.7 + 1.4 * level)));
    halo.addColorStop(1, rgba(look.glow, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(c, c, outer, 0, 2 * Math.PI);
    ctx.fill();
    if (f.motion) {
      for (const ring of aura.rings) {
        const p = Math.min(1, (f.timeS - ring.bornS) / RING_LIFE_S);
        ctx.beginPath();
        ctx.arc(c, c, Math.min(c - 1, restRadius * (1.02 + RING_SPREAD * p)), 0, 2 * Math.PI);
        ctx.strokeStyle = rgba(look.glow, (1 - p) * 0.32 * ring.strength);
        ctx.lineWidth = 2.2 * (1 - p) + 0.6;
        ctx.stroke();
      }
    }
  }

  // The glass, a hair larger on a loud syllable, clipped so the liquid stays inside it.
  const scale = 1 + 0.025 * level;
  ctx.save();
  ctx.translate(c, c);
  ctx.scale(scale, scale);
  ctx.translate(-c, -c);
  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, restRadius, 0, 2 * Math.PI);
  ctx.clip();

  const r = restRadius;
  const glass = ctx.createLinearGradient(c - r, c - r, c + r * 0.6, c + r * 0.4);
  glass.addColorStop(0, rgba(mixRgb(look.top, WHITE, 0.55), 1));
  glass.addColorStop(1, rgba(look.top, 1));
  ctx.fillStyle = glass;
  ctx.fillRect(c - r, c - r, 2 * r, 2 * r);

  const s = liquidSurface(r, c, f, live);
  const phase = f.motion ? f.phase : 0;
  const liquid = (alpha: number) => {
    const g = ctx.createLinearGradient(0, s.base - 8, 0, c + r);
    g.addColorStop(0, rgba(look.surface, alpha));
    g.addColorStop(1, rgba(look.deep, alpha));
    return g;
  };
  // A paler wave behind, slightly higher and out of phase, gives the liquid depth.
  const back = { ...s, base: s.base - 4, long: s.long * 0.8, short: s.short * 0.8 };
  traceLiquid(ctx, c, r, back, phase * 0.8, 1.9, true);
  ctx.fillStyle = liquid(0.35);
  ctx.fill();
  traceLiquid(ctx, c, r, s, phase, 0, true);
  ctx.fillStyle = liquid(1);
  ctx.fill();
  // Light caught just under the surface.
  const band = ctx.createLinearGradient(0, s.base - s.long - s.short, 0, s.base + 26);
  band.addColorStop(0, "rgba(255, 255, 255, 0.28)");
  band.addColorStop(1, "rgba(255, 255, 255, 0)");
  traceLiquid(ctx, c, r, s, phase, 0, true);
  ctx.fillStyle = band;
  ctx.fill();
  // The crest line.
  traceLiquid(ctx, c, r, s, phase, 0, false);
  ctx.strokeStyle = `rgba(255, 255, 255, ${lerp(0.35, 0.75, live).toFixed(3)})`;
  ctx.lineWidth = 1.6;
  ctx.stroke();
  // Shading toward the edge, so it reads as a sphere rather than a flat disc.
  const edge = ctx.createRadialGradient(c - r * 0.25, c - r * 0.35, r * 0.55, c, c, r);
  edge.addColorStop(0, "rgba(255, 255, 255, 0)");
  edge.addColorStop(1, rgba(look.deep, 0.14));
  ctx.fillStyle = edge;
  ctx.fillRect(c - r, c - r, 2 * r, 2 * r);
  ctx.restore(); // the clip

  // Glass rim and a glint at the upper left.
  ctx.beginPath();
  ctx.arc(c, c, r - 0.5, 0, 2 * Math.PI);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.65)";
  ctx.lineWidth = 1;
  ctx.stroke();
  const gx = c - r * 0.42;
  const gy = c - r * 0.5;
  const glint = ctx.createRadialGradient(gx, gy, 0, gx, gy, r * 0.42);
  glint.addColorStop(0, "rgba(255, 255, 255, 0.55)");
  glint.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = glint;
  ctx.beginPath();
  ctx.arc(c, c, r, 0, 2 * Math.PI);
  ctx.fill();
  ctx.restore(); // the scale
}
