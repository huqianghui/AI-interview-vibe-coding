/** The photo avatar's stage colour, read from the decoded picture (owner, 2026-10-17). */
import { describe, expect, it } from "vitest";
import { backdropMoved, edgeBackdrop, photoBox } from "./avatarBackdrop";

/** An RGBA frame painted `wall`, with `paint(x, y)` overriding single pixels. */
function frame(
  size: number,
  wall: [number, number, number],
  paint: (x: number, y: number) => [number, number, number] | null = () => null,
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b] = paint(x, y) ?? wall;
      const i = (y * size + x) * 4;
      data.set([r, g, b, 255], i);
    }
  }
  return data;
}

describe("edgeBackdrop", () => {
  it("reads the wall at the left and right edges as #rrggbb", () => {
    expect(edgeBackdrop(frame(64, [0xbb, 0xad, 0x9c]), 64, 64)).toBe("#bbad9c");
  });

  it("ignores the face in the middle and the shoulders at the bottom", () => {
    const data = frame(64, [0xbb, 0xad, 0x9c], (x, y) => {
      if (x > 16 && x < 48) return [210, 160, 130]; // the face and hair, never at the edge
      if (y > 50) return [20, 25, 40]; // a dark jacket reaching both edges below 65 % height
      return null;
    });
    expect(edgeBackdrop(data, 64, 64)).toBe("#bbad9c");
  });

  it("takes the median, so encoder noise on a few pixels does not move it", () => {
    let n = 0;
    const data = frame(64, [0xbb, 0xad, 0x9c], () => (n++ % 37 === 0 ? [0xc4, 0xb6, 0xa5] : null));
    expect(edgeBackdrop(data, 64, 64)).toBe("#bbad9c");
  });

  it("gives up when the edge is not a plain wall, rather than paint a wrong colour", () => {
    // Hair across the whole left edge: half the edge pixels are dark.
    const data = frame(64, [0xbb, 0xad, 0x9c], (x, y) => (x < 2 && y % 2 === 0 ? [10, 10, 10] : null));
    expect(edgeBackdrop(data, 64, 64)).toBeNull();
    expect(edgeBackdrop(new Uint8ClampedArray(0), 0, 0)).toBeNull();
  });
});

describe("backdropMoved", () => {
  it("repaints on a real change only, not on encoder noise", () => {
    expect(backdropMoved(null, "#bbad9c")).toBe(true);
    expect(backdropMoved("#bbad9c", "#bcad9b")).toBe(false); // 1 unit
    expect(backdropMoved("#bbad9c", "#bead9c")).toBe(true); // 3 units in red
  });
});

describe("photoBox", () => {
  it("draws a photo avatar at its own size at most: never enlarged", () => {
    expect(photoBox(710, 820, { width: 512, height: 512 })).toEqual({ width: 512, height: 512 });
  });

  it("shrinks it only when the stage is smaller than the stream", () => {
    expect(photoBox(400, 820, { width: 512, height: 512 })).toEqual({ width: 400, height: 400 });
    expect(photoBox(710, 300, { width: 512, height: 512 })).toEqual({ width: 300, height: 300 });
    expect(photoBox(0, 300, { width: 512, height: 512 })).toBeNull();
  });
});
