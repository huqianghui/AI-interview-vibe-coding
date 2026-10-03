/**
 * The blank-picture policy. Pure, so the interesting cases are reachable without a canvas, a live
 * stream, or a 3-second wait — the same split `avatarHealth.ts` uses for the weak-network policy.
 */
import { describe, expect, it } from "vitest";
import {
  BLANK_LUMA_MAX,
  BLANK_STREAK_TO_FAIL,
  initialPictureState,
  isBlankFrame,
  meanLuma,
  nextPictureState,
  pictureIsShowable,
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

describe("nextPictureState", () => {
  const S = initialPictureState;

  it("starts unproven — frames existing is not yet evidence they contain anything", () => {
    expect(S.verdict).toBe("waiting");
    expect(pictureIsShowable(S)).toBe(false);
  });

  it("promotes on ONE frame with content", () => {
    const next = nextPictureState(S, "ok", 180);
    expect(next.verdict).toBe("content");
    expect(pictureIsShowable(next)).toBe(true);
  });

  it("KEEPS WAITING on a blank frame instead of showing it — this is the whole fix", () => {
    // Measured on real Azure 2026-10-03: the black frame arrives at session START. The old policy
    // showed it and retracted ~3 s later, which is exactly the window the candidate is looking at.
    let st = S;
    for (let i = 0; i < BLANK_STREAK_TO_FAIL + 3; i++) st = nextPictureState(st, "ok", 0);
    expect(st.verdict).toBe("waiting");
    expect(pictureIsShowable(st)).toBe(false);
  });

  it("demotes a PROVEN picture only after a run of blanks, so a hiccup is not a verdict", () => {
    let st = nextPictureState(S, "ok", 200);
    for (let i = 0; i < BLANK_STREAK_TO_FAIL - 1; i++) st = nextPictureState(st, "ok", 0);
    expect(st.verdict).toBe("content");
    st = nextPictureState(st, "ok", 0);
    expect(st.verdict).toBe("blank");
  });

  it("recovers from blank on a single good frame", () => {
    let st = nextPictureState(S, "ok", 200);
    for (let i = 0; i < BLANK_STREAK_TO_FAIL; i++) st = nextPictureState(st, "ok", 0);
    expect(st.verdict).toBe("blank");
    expect(nextPictureState(st, "ok", 150).verdict).toBe("content");
  });

  it("treats `not-ready` as no information at all", () => {
    // There was no frame to judge. Growing the blank streak here would eventually declare a perfectly
    // good stream empty just because the element kept re-attaching.
    let st = S;
    for (let i = 0; i < 10; i++) st = nextPictureState(st, "not-ready", 0);
    expect(st).toEqual(S);
    const proven = nextPictureState(S, "ok", 200);
    expect(nextPictureState(proven, "not-ready", 0)).toEqual(proven);
  });

  it("shows an unproven picture when the browser CANNOT be asked — immediately, not after a wait", () => {
    // "We cannot check this" must never become "never show the interviewer". And it must not cost a
    // delay either, or every browser without a readable canvas pays for a guard it cannot run.
    const next = nextPictureState(S, "unsupported", 0);
    expect(next.verdict).toBe("content");
    expect(pictureIsShowable(next)).toBe(true);
  });

  it("does not let `unsupported` resurrect a picture already proven blank", () => {
    let st = nextPictureState(S, "ok", 200);
    for (let i = 0; i < BLANK_STREAK_TO_FAIL; i++) st = nextPictureState(st, "ok", 0);
    expect(st.verdict).toBe("blank");
    expect(nextPictureState(st, "unsupported", 0).verdict).toBe("blank");
  });
});
