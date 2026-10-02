/**
 * The blank-picture policy. Pure, so the interesting cases are reachable without a canvas, a live
 * stream, or a 3-second wait — the same split `avatarHealth.ts` uses for the weak-network policy.
 */
import { describe, expect, it } from "vitest";
import {
  BLANK_LUMA_MAX,
  BLANK_STREAK_TO_FAIL,
  isBlankFrame,
  isPictureDead,
  meanLuma,
  nextBlankStreak,
} from "./avatarFrameHealth";

/** RGBA pixel data of `n` pixels, all the same colour. */
function solid(n: number, r: number, g: number, b: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  }
  return out;
}

describe("meanLuma", () => {
  it("reads black as 0 and white as 255", () => {
    expect(meanLuma(solid(16, 0, 0, 0))).toBe(0);
    expect(Math.round(meanLuma(solid(16, 255, 255, 255)))).toBe(255);
  });

  it("weights green above blue — a flat average would misjudge saturated frames", () => {
    // The whole point of Rec. 601: an all-blue frame is DARK to the eye, an all-green one is bright.
    // With a flat (r+g+b)/3 both would read 85 and a blue frame would be called blank.
    const blue = meanLuma(solid(16, 0, 0, 255));
    const green = meanLuma(solid(16, 0, 255, 0));
    expect(blue).toBeLessThan(green);
    expect(blue).toBeCloseTo(29.07, 1);
    expect(green).toBeCloseTo(149.69, 1);
  });

  it("is 0 for input too short to hold a pixel, so a failed read never reads as bright", () => {
    expect(meanLuma(new Uint8ClampedArray(0))).toBe(0);
    expect(meanLuma([1, 2])).toBe(0);
  });

  it("averages rather than taking any single pixel — a small bright overlay cannot rescue a black frame", () => {
    // This is the frame we actually saw: solid black with a timestamp burned in. Model it as 1 bright
    // pixel in 64 and assert it still reads as blank.
    const px = solid(64, 0, 0, 0);
    px[0] = 255;
    px[1] = 255;
    px[2] = 255;
    expect(isBlankFrame(meanLuma(px))).toBe(true);
  });
});

describe("isBlankFrame", () => {
  it("treats the threshold itself as blank, and anything above it as content", () => {
    expect(isBlankFrame(BLANK_LUMA_MAX)).toBe(true);
    expect(isBlankFrame(BLANK_LUMA_MAX + 1)).toBe(false);
  });

  it("calls a real avatar frame on the white page backdrop content, by a wide margin", () => {
    // Since v0.40.9.1 the backdrop IS the page's white, so a genuine frame is nowhere near the cut.
    expect(isBlankFrame(meanLuma(solid(16, 255, 255, 255)))).toBe(false);
    expect(BLANK_LUMA_MAX).toBeLessThan(50);
  });
});

describe("nextBlankStreak", () => {
  it("grows on a readable blank frame", () => {
    expect(nextBlankStreak(0, true, 0)).toBe(1);
    expect(nextBlankStreak(1, true, 0)).toBe(2);
  });

  it("resets on a readable frame with content — one good frame proves the picture works", () => {
    expect(nextBlankStreak(5, true, 200)).toBe(0);
  });

  it("LEAVES the streak alone when the frame could not be read at all", () => {
    // The distinction that stops the fallback flashing every time the element re-attaches: "no frame
    // to read" is not evidence of blankness. If this returned streak+1, a detached element would
    // eventually be declared dead while the stream was fine.
    expect(nextBlankStreak(2, false, 0)).toBe(2);
    expect(nextBlankStreak(0, false, 0)).toBe(0);
  });
});

describe("isPictureDead", () => {
  it("needs more than one blank sample, so a single decoder hiccup is not a verdict", () => {
    expect(BLANK_STREAK_TO_FAIL).toBeGreaterThan(1);
    expect(isPictureDead(BLANK_STREAK_TO_FAIL - 1)).toBe(false);
    expect(isPictureDead(BLANK_STREAK_TO_FAIL)).toBe(true);
  });

  it("walks from a healthy stream to a verdict only through consecutive blanks", () => {
    let streak = 0;
    // Two blanks, then one good frame: not dead, and the count is back to zero.
    streak = nextBlankStreak(streak, true, 0);
    streak = nextBlankStreak(streak, true, 0);
    expect(isPictureDead(streak)).toBe(false);
    streak = nextBlankStreak(streak, true, 180);
    expect(streak).toBe(0);
    // Now an uninterrupted run reaches the verdict.
    for (let i = 0; i < BLANK_STREAK_TO_FAIL; i++) streak = nextBlankStreak(streak, true, 0);
    expect(isPictureDead(streak)).toBe(true);
  });
});
