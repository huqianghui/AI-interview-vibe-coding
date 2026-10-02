/**
 * Fit / hug geometry for the avatar stage.
 *
 * This file exists because the gap it now covers let a visible layout defect ship: `useHugBox` cannot
 * be exercised in jsdom (a zero-size parent makes `fitBox` return null), so nothing asserted what the
 * box does with a WIDE stream. On the live site a 16:9 stream in an 826x829 column hugged to 826x465
 * and left the bottom 364px empty — top aligned with the question card, bottom nowhere near it, and no
 * test said a word about it. The decision is pure now, so it can be.
 */
import { describe, expect, it } from "vitest";
import { COVER_FIT_MIN_ASPECT, fitBox, fitFor, hugRatioFor } from "./avatarFit";

describe("fitFor", () => {
  it("covers wide video avatars and contains square photo avatars", () => {
    expect(fitFor(1920, 1080)).toBe("cover"); // 1.78
    expect(fitFor(512, 512)).toBe("contain"); // 1.0
  });

  it("contains anything taller than wide, and unknown sizes", () => {
    expect(fitFor(900, 1600)).toBe("contain");
    expect(fitFor(0, 0)).toBe("contain");
    expect(fitFor(-1, 10)).toBe("contain");
  });

  it("splits exactly at the documented threshold", () => {
    expect(fitFor(COVER_FIT_MIN_ASPECT * 100, 100)).toBe("cover");
    expect(fitFor(COVER_FIT_MIN_ASPECT * 100 - 1, 100)).toBe("contain");
  });
});

describe("hugRatioFor", () => {
  it("hugs a contained stream — that is what removes the letterbox around a photo avatar", () => {
    expect(hugRatioFor("contain", 1)).toBe(1);
    expect(hugRatioFor("contain", 0.75)).toBe(0.75);
  });

  it("does NOT hug a covered stream — it fills the column and crops its own margins instead", () => {
    // The regression this locks: hugging a 16:9 stream is what emptied the bottom of the column.
    expect(hugRatioFor("cover", 16 / 9)).toBeNull();
  });

  it("passes a null ratio through, so an unknown stream just fills", () => {
    expect(hugRatioFor("contain", null)).toBeNull();
    expect(hugRatioFor("cover", null)).toBeNull();
  });
});

describe("fitBox", () => {
  it("is width-bound when the parent is taller than the aspect needs — the case that left the gap", () => {
    // The live measurement: 826x829 column, 16:9 stream.
    expect(fitBox(826, 829, 16 / 9)).toEqual({ width: 826, height: 465 });
    // 465 against an 829-tall column is the 364px of empty bottom. Hugging is therefore correct only
    // when the leftover is the lesser evil — i.e. when cropping would cut the figure.
    expect(829 - 465).toBe(364);
  });

  it("is height-bound when the parent is wider than the aspect needs", () => {
    expect(fitBox(1000, 400, 1)).toEqual({ width: 400, height: 400 });
  });

  it("returns null on degenerate input so the box just fills its parent", () => {
    expect(fitBox(0, 100, 1)).toBeNull();
    expect(fitBox(100, 0, 1)).toBeNull();
    expect(fitBox(100, 100, 0)).toBeNull();
    expect(fitBox(100, 100, Number.NaN)).toBeNull();
  });
});
