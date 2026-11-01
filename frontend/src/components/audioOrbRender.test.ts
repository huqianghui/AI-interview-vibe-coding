/** The audio orb's drawing maths (SPEC F9): smoothing, colour cross-fade, the liquid and the aura. */
import { describe, expect, it, vi } from "vitest";
import {
  advancePhase,
  drawOrb,
  follow,
  hexToRgb,
  liquidSurface,
  liveliness,
  mixLook,
  newAura,
  ORB_FALL_MS,
  ORB_LOOKS,
  ORB_MAX_EXTENT,
  ORB_RISE_MS,
  surfaceY,
  updateAura,
  type OrbFrame,
} from "./audioOrbRender";

const R = 80;
const C = 120;
const still: OrbFrame = { timeS: 0, phase: 0, level: 0, bands: [], motion: true };

describe("follow", () => {
  it("rises faster than it falls, so a syllable lands at once and fades gently", () => {
    const up = follow(0, 1, 50, ORB_RISE_MS, ORB_FALL_MS);
    const down = 1 - follow(1, 0, 50, ORB_RISE_MS, ORB_FALL_MS);
    expect(up).toBeGreaterThan(down);
    expect(up).toBeLessThan(1);
  });

  it("does not depend on frame rate: two half steps equal one whole step", () => {
    const once = follow(0, 1, 32, ORB_RISE_MS, ORB_FALL_MS);
    const twice = follow(follow(0, 1, 16, ORB_RISE_MS, ORB_FALL_MS), 1, 16, ORB_RISE_MS, ORB_FALL_MS);
    expect(twice).toBeCloseTo(once, 10);
  });
});

describe("looks", () => {
  it("land exactly on either end of a cross-fade", () => {
    expect(mixLook(ORB_LOOKS.idle, ORB_LOOKS.speaking, 0)).toEqual(ORB_LOOKS.idle);
    expect(mixLook(ORB_LOOKS.idle, ORB_LOOKS.speaking, 1)).toEqual(ORB_LOOKS.speaking);
  });

  it("give muted no aura and a still liquid, and every other state both", () => {
    expect(ORB_LOOKS.muted.glowAlpha).toBe(0);
    expect(liveliness(ORB_LOOKS.muted)).toBe(0);
    for (const s of ["idle", "listening", "speaking"] as const) {
      expect(ORB_LOOKS[s].glowAlpha).toBeGreaterThan(0);
      expect(liveliness(ORB_LOOKS[s])).toBe(1);
    }
  });

  it("calm the liquid gradually while fading into muted, rather than snapping it flat", () => {
    const halfway = liveliness(mixLook(ORB_LOOKS.speaking, ORB_LOOKS.muted, 0.5));
    expect(halfway).toBeGreaterThan(0);
    expect(halfway).toBeLessThan(1);
  });

  it("keep the glass paler than the liquid's surface, and the surface paler than its depth", () => {
    const sum = (c: readonly number[]) => c[0] + c[1] + c[2];
    for (const look of Object.values(ORB_LOOKS)) {
      expect(sum(look.top)).toBeGreaterThan(sum(look.surface));
      expect(sum(look.surface)).toBeGreaterThan(sum(look.deep));
    }
  });
});

describe("hexToRgb", () => {
  it("parses with or without the hash", () => {
    expect(hexToRgb("#5C2E91")).toEqual([0x5c, 0x2e, 0x91]);
    expect(hexToRgb("1E7A5C")).toEqual([0x1e, 0x7a, 0x5c]);
  });
});

describe("the liquid", () => {
  it("rises and roughens with loudness", () => {
    const quiet = liquidSurface(R, C, still, 1);
    const loud = liquidSurface(R, C, { ...still, level: 1 }, 1);
    expect(loud.base).toBeLessThan(quiet.base); // higher on the canvas
    expect(loud.long).toBeGreaterThan(quiet.long * 3);
  });

  it("swells the long wave with low bands and the short ripple with high ones", () => {
    const flat = liquidSurface(R, C, { ...still, level: 0.5 }, 1);
    const bass = liquidSurface(R, C, { ...still, level: 0.5, bands: [1, 1, 0, 0] }, 1);
    const treble = liquidSurface(R, C, { ...still, level: 0.5, bands: [0, 0, 1, 1] }, 1);
    expect(bass.long).toBeGreaterThan(flat.long);
    expect(bass.short).toBe(flat.short);
    expect(treble.short).toBeGreaterThan(flat.short);
    expect(treble.long).toBe(flat.long);
  });

  it("lies almost flat when muted", () => {
    const s = liquidSurface(R, C, { ...still, level: 1 }, 0);
    expect(s.long + s.short).toBeLessThan(1.5);
  });

  it("stays inside the sphere however loud the voice", () => {
    const s = liquidSurface(R, C, { ...still, level: 1, bands: [1, 1, 1, 1] }, 1);
    for (let u = 0; u <= 1; u += 0.05) {
      for (let phase = 0; phase < 6.3; phase += 0.7) {
        const y = surfaceY(u, s, phase);
        expect(y).toBeGreaterThan(C - R);
        expect(y).toBeLessThan(C + R);
      }
    }
  });
});

describe("advancePhase", () => {
  it("drifts faster when the voice is loud, and not at all when the liquid is still", () => {
    const calm = advancePhase(0, 100, 0, 1);
    const loud = advancePhase(0, 100, 1, 1);
    expect(loud).toBeGreaterThan(calm * 2);
    expect(advancePhase(1.5, 100, 1, 0)).toBe(1.5);
  });

  it("moves smoothly when the level changes: one frame's step never depends on elapsed time", () => {
    const early = advancePhase(0.1, 16, 0.2, 1) - 0.1;
    const late = advancePhase(500.1, 16, 0.2, 1) - 500.1;
    expect(late).toBeCloseTo(early, 9);
  });
});

describe("aura rings", () => {
  it("are born when the level rises through the trigger, not while it stays above it", () => {
    const aura = newAura();
    updateAura(aura, 0.2, 0);
    updateAura(aura, 0.8, 0.05);
    updateAura(aura, 0.9, 0.1);
    updateAura(aura, 0.85, 0.15);
    expect(aura.rings).toHaveLength(1);
    expect(aura.rings[0].strength).toBe(0.8);
  });

  it("are spaced out on a fast flutter and expire as they fade", () => {
    const aura = newAura();
    updateAura(aura, 0.8, 0);
    updateAura(aura, 0.1, 0.05);
    updateAura(aura, 0.8, 0.1); // too soon after the last one
    expect(aura.rings).toHaveLength(1);
    updateAura(aura, 0.1, 0.5);
    updateAura(aura, 0.8, 0.6);
    expect(aura.rings).toHaveLength(2);
    updateAura(aura, 0, 5);
    expect(aura.rings).toHaveLength(0);
  });
});

describe("drawOrb", () => {
  function fakeCtx() {
    const gradient = { addColorStop: vi.fn() };
    return {
      clearRect: vi.fn(),
      createRadialGradient: vi.fn(() => gradient),
      createLinearGradient: vi.fn(() => gradient),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      fillRect: vi.fn(),
      stroke: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      clip: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
    };
  }
  const draw = (ctx: ReturnType<typeof fakeCtx>, look = ORB_LOOKS.speaking, f = still, aura = newAura()) =>
    drawOrb(ctx as unknown as CanvasRenderingContext2D, 2 * C, R, look, f, aura);

  it("balances every save with a restore, so frames never leak a clip or a transform", () => {
    const ctx = fakeCtx();
    draw(ctx, ORB_LOOKS.listening, { ...still, level: 0.9 });
    expect(ctx.save.mock.calls.length).toBe(ctx.restore.mock.calls.length);
  });

  it("paints an aura for a lit state and none for muted", () => {
    const lit = fakeCtx();
    draw(lit);
    const off = fakeCtx();
    draw(off, ORB_LOOKS.muted);
    // the aura is the one radial gradient whose inner circle starts at 0.9 of the radius
    const aura = (ctx: ReturnType<typeof fakeCtx>) =>
      ctx.createRadialGradient.mock.calls.filter((a) => (a as unknown as number[])[2] === R * 0.9);
    expect(aura(lit)).toHaveLength(1);
    expect(aura(off)).toHaveLength(0);
  });

  it("keeps the aura and its rings inside the canvas the component sizes from ORB_MAX_EXTENT", () => {
    const ctx = fakeCtx();
    const aura = newAura();
    updateAura(aura, 1, 0);
    draw(ctx, ORB_LOOKS.speaking, { ...still, level: 1, timeS: 1.5 }, aura);
    const half = Math.ceil(R * ORB_MAX_EXTENT);
    for (const call of ctx.arc.mock.calls) {
      const [x, , radius] = call as unknown as number[];
      if (x === C) expect(radius).toBeLessThanOrEqual(half);
    }
  });

  it("draws no rings under reduced motion", () => {
    const ctx = fakeCtx();
    const aura = newAura();
    updateAura(aura, 1, 0);
    draw(ctx, ORB_LOOKS.speaking, { ...still, motion: false, timeS: 0.5 }, aura);
    expect(ctx.stroke.mock.calls.length).toBe(2); // the crest line and the glass rim only
  });
});
