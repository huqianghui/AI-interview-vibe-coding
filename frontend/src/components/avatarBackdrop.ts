/**
 * The colour a photo avatar's stage is painted, read from the DECODED picture itself.
 *
 * A photo avatar streams a 512×512 square. Owner, 2026-10-17: keep it at that size, and fill the
 * whole stage around it with the picture's own background so there is no colour step and nothing
 * that reads as a frame. Azure paints the wall the colour the page asks for (`avatar_bg`), but the
 * video then goes through H.264 and 4:2:0 chroma, so the colour that reaches the screen is a few
 * units off what was asked: a CSS fill of the REQUESTED colour shows as a faint box. Reading the
 * fill from the frame's own edge pixels matches whatever the browser actually draws.
 *
 * The sampled region is the one PHOTO_BACKDROPS was measured from: the left and right edge columns
 * (outer 3 %) over the top 65 % of the height, where only wall meets the edge (below that a
 * shoulder may touch it). Per-channel median, so a stray pixel cannot move it.
 */

/** Size the frame is drawn at to be sampled: plenty for a median, cheap to read every second. */
export const BACKDROP_SAMPLE_SIZE = 64;
const EDGE_FRACTION = 0.03;
const TOP_FRACTION = 0.65;
/** Above this spread (max - min of a channel, after trimming the outer 10 %) the edge is not plain
 * wall (something else reaches it): keep the previous colour rather than paint a wrong one. */
const MAX_SPREAD = 24;
/** Ignore changes smaller than this per channel, so encoder noise does not repaint the stage. */
export const BACKDROP_STEP = 3;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function trimmedSpread(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const cut = Math.floor(s.length * 0.1);
  const kept = s.slice(cut, s.length - cut || undefined);
  return kept.length ? kept[kept.length - 1] - kept[0] : 0;
}

/** The wall colour at the left and right edges of an RGBA frame `width × height`, as `#rrggbb`, or
 * null when the edge is not a plain wall. */
export function edgeBackdrop(data: Uint8ClampedArray, width: number, height: number): string | null {
  if (width <= 0 || height <= 0 || data.length < width * height * 4) return null;
  const cols = Math.max(1, Math.round(width * EDGE_FRACTION));
  const rows = Math.max(1, Math.round(height * TOP_FRACTION));
  const ch: [number[], number[], number[]] = [[], [], []];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < width; x++) {
      if (x >= cols && x < width - cols) continue;
      const i = (y * width + x) * 4;
      ch[0].push(data[i]);
      ch[1].push(data[i + 1]);
      ch[2].push(data[i + 2]);
    }
  }
  if (ch.some((c) => trimmedSpread(c) > MAX_SPREAD)) return null;
  return `#${ch.map((c) => median(c).toString(16).padStart(2, "0")).join("")}`;
}

/** True when `next` differs from `prev` by at least BACKDROP_STEP in some channel. */
export function backdropMoved(prev: string | null, next: string): boolean {
  if (!prev) return true;
  for (let i = 1; i < 7; i += 2) {
    const a = parseInt(prev.slice(i, i + 2), 16);
    const b = parseInt(next.slice(i, i + 2), 16);
    if (Math.abs(a - b) >= BACKDROP_STEP) return true;
  }
  return false;
}

/** The box a photo avatar is drawn in: its own size at most (no enlarging, owner 2026-10-17), and
 * smaller only when the stage is smaller. `native` is the stream's intrinsic size. */
export function photoBox(
  parentW: number,
  parentH: number,
  native: { width: number; height: number },
): { width: number; height: number } | null {
  if (parentW <= 0 || parentH <= 0 || native.width <= 0 || native.height <= 0) return null;
  const scale = Math.min(1, parentW / native.width, parentH / native.height);
  return { width: Math.round(native.width * scale), height: Math.round(native.height * scale) };
}
