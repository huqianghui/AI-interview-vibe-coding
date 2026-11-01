/** The audio orb's drawing maths (SPEC F9): smoothing, colour cross-fade, and the outline. */
import { describe, expect, it, vi } from "vitest";
import {
  drawOrb,
  follow,
  hexToRgb,
  mixLook,
  ORB_FALL_MS,
  ORB_LOOKS,
  ORB_MAX_SCALE,
  ORB_RISE_MS,
  orbRadii,
} from "./audioOrbRender";

const still = { timeS: 0, level: 0, bands: [], motion: false };

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

describe("mixLook", () => {
  it("lands exactly on either end", () => {
    expect(mixLook(ORB_LOOKS.idle, ORB_LOOKS.speaking, 0)).toEqual(ORB_LOOKS.idle);
    expect(mixLook(ORB_LOOKS.idle, ORB_LOOKS.speaking, 1)).toEqual(ORB_LOOKS.speaking);
  });

  it("gives muted no halo, the one state that should look switched off", () => {
    expect(ORB_LOOKS.muted.glowAlpha).toBe(0);
    for (const s of ["idle", "listening", "speaking"] as const) {
      expect(ORB_LOOKS[s].glowAlpha).toBeGreaterThan(0);
    }
  });
});

describe("hexToRgb", () => {
  it("parses with or without the hash", () => {
    expect(hexToRgb("#5C2E91")).toEqual([0x5c, 0x2e, 0x91]);
    expect(hexToRgb("1E7A5C")).toEqual([0x1e, 0x7a, 0x5c]);
  });
});

describe("orbRadii", () => {
  it("is a perfect circle at the rest radius when still and silent", () => {
    const radii = orbRadii(36, 80, still);
    expect(radii).toHaveLength(36);
    for (const r of radii) expect(r).toBe(80);
  });

  it("grows with loudness", () => {
    const quiet = orbRadii(36, 80, { ...still, level: 0 });
    const loud = orbRadii(36, 80, { ...still, level: 1 });
    expect(Math.min(...loud)).toBeGreaterThan(Math.max(...quiet));
  });

  it("deforms the outline only where there is band energy", () => {
    const flat = orbRadii(72, 80, { timeS: 1, level: 0.5, bands: [0, 0, 0, 0], motion: true });
    const voiced = orbRadii(72, 80, { timeS: 1, level: 0.5, bands: [1, 1, 1, 1], motion: true });
    const spread = (rs: number[]) => Math.max(...rs) - Math.min(...rs);
    expect(spread(voiced)).toBeGreaterThan(spread(flat) * 3);
  });

  it("never exceeds the largest size the canvas was sized for", () => {
    for (let t = 0; t < 4; t += 0.1) {
      const radii = orbRadii(72, 80, { timeS: t, level: 1, bands: [1, 1, 1, 1], motion: true });
      expect(Math.max(...radii)).toBeLessThanOrEqual(80 * ORB_MAX_SCALE + 1e-9);
    }
  });

  it("ignores levels and bands under reduced motion except overall loudness", () => {
    const radii = orbRadii(36, 80, { timeS: 2, level: 0, bands: [1, 1, 1, 1], motion: false });
    for (const r of radii) expect(r).toBe(80);
  });
});

describe("drawOrb", () => {
  function fakeCtx() {
    const gradient = { addColorStop: vi.fn() };
    return {
      clearRect: vi.fn(),
      createRadialGradient: vi.fn(() => gradient),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      closePath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      fillRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      clip: vi.fn(),
    };
  }

  it("paints a halo for a lit state but none for muted", () => {
    const lit = fakeCtx();
    drawOrb(lit as unknown as CanvasRenderingContext2D, 260, 80, ORB_LOOKS.speaking, still);
    const off = fakeCtx();
    drawOrb(off as unknown as CanvasRenderingContext2D, 260, 80, ORB_LOOKS.muted, still);
    // halo + body + sheen versus body + sheen.
    expect(lit.createRadialGradient).toHaveBeenCalledTimes(3);
    expect(off.createRadialGradient).toHaveBeenCalledTimes(2);
  });

  it("keeps the halo inside the canvas however loud it gets", () => {
    const ctx = fakeCtx();
    drawOrb(ctx as unknown as CanvasRenderingContext2D, 260, 80, ORB_LOOKS.speaking, {
      ...still,
      level: 1,
    });
    const [, , , , , haloR] = ctx.createRadialGradient.mock.calls[0] as unknown as number[];
    expect(haloR).toBeLessThanOrEqual(130);
  });
});
