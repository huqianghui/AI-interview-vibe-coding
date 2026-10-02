/**
 * Is the avatar's picture actually SHOWING anything?
 *
 * The stage's contract (owner, 2026-10-02) is that it always shows exactly one of three things: the
 * cached still, the digital human, or the audio orb. A black rectangle is not one of them, and one was
 * seen on the live site — a 1920x1080 frame, solid black, with a timestamp burned into it, while the UI
 * said "Speaking". Nothing in this codebase draws a timestamp or paints the stage black (verified by
 * grep), so those pixels arrived in the media track.
 *
 * The hole that let it through: `isAvatarConnected` means "real frames are arriving" (`videoWidth > 0`,
 * `framesDecoded` growing). A stream that is alive but blank satisfies every one of those — frames
 * decode, bytes flow, ICE stays connected — so the media self-heal never fires and the fallback never
 * shows. "Frames exist" is not "the picture works", and this module is the difference: it looks at what
 * is IN the frame.
 *
 * Deliberately NOT a brightness threshold on real content. The question is only "is this frame
 * EMPTY" — a solid fill. Avatars are lit figures and, since v0.40.9.1, stand on the page's own white
 * backdrop, so a genuine frame's mean luminance is an order of magnitude above the cut. The policy
 * lives here as pure functions so it is unit-testable without a canvas or a live stream; `AvatarView`
 * owns the sampling and the DOM.
 */

/** Mean luminance (0-255) at or below which a frame is treated as empty. A real avatar frame on the
 * white page backdrop measures well over 100; a black frame measures ~0. The gap is wide enough that
 * the exact value is not load-bearing — which is the point, after the weak-network work found that any
 * threshold tuned to content varies per avatar (`docs/avatar-weaknet-probe.md` §5.4.2). */
export const BLANK_LUMA_MAX = 8;

/** Consecutive blank samples before the picture is declared dead. More than one, because a single
 * blank reading is also what a decoder hiccup or a just-attached element looks like; few enough that
 * the candidate is not left staring at black. At the 1 s sampling interval this is ~3 s. */
export const BLANK_STREAK_TO_FAIL = 3;

/** How often to sample. Cheap (a 32x18 draw plus 576 pixel reads) but not free, and it shares the main
 * thread with the video decode, so once a second rather than per frame. */
export const BLANK_SAMPLE_INTERVAL_MS = 1000;

/** Downscale the frame to this size before reading pixels. Small enough to be negligible, large enough
 * that a mostly-empty frame with a small overlay (the timestamp we saw) still reads as near-black
 * rather than being skewed by a handful of bright pixels. */
export const BLANK_SAMPLE_WIDTH = 32;
export const BLANK_SAMPLE_HEIGHT = 18;

/**
 * Mean Rec. 601 luminance of RGBA pixel data, 0-255. Returns 0 for empty input so a failed read is
 * never mistaken for a bright frame — but callers must not treat "could not read" as "blank"; see
 * `nextBlankStreak`'s `readable` argument.
 */
export function meanLuma(rgba: Uint8ClampedArray | number[]): number {
  if (rgba.length < 4) return 0;
  let total = 0;
  let count = 0;
  for (let i = 0; i + 2 < rgba.length; i += 4) {
    // Rec. 601 weights: the eye is far more sensitive to green than to blue, so a flat average would
    // call a saturated blue frame "dark" and a green one "bright".
    total += 0.299 * (rgba[i] ?? 0) + 0.587 * (rgba[i + 1] ?? 0) + 0.114 * (rgba[i + 2] ?? 0);
    count += 1;
  }
  return count === 0 ? 0 : total / count;
}

/** Whether a sampled frame counts as empty. */
export function isBlankFrame(luma: number): boolean {
  return luma <= BLANK_LUMA_MAX;
}

/**
 * Advance the blank-sample streak.
 *
 * `readable` is false when the frame could not be sampled at all (element not ready, canvas refused,
 * zero dimensions). That is NOT evidence of blankness — treating it as such would flash the fallback
 * every time the element re-attaches — so it leaves the streak untouched rather than growing it.
 * A readable, non-blank frame resets to 0: one good frame is proof the picture works.
 */
export function nextBlankStreak(streak: number, readable: boolean, luma: number): number {
  if (!readable) return streak;
  return isBlankFrame(luma) ? streak + 1 : 0;
}

/** Has the picture been empty long enough to stop claiming it works? */
export function isPictureDead(streak: number): boolean {
  return streak >= BLANK_STREAK_TO_FAIL;
}
