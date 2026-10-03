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

/** What a sampling attempt produced. The three are NOT interchangeable, and conflating two of them was
 * a real defect: `not-ready` (no frame to read yet — the element just attached) must keep the stage
 * waiting, while `unsupported` (this browser cannot give us pixels at all: no 2-D context, a privacy
 * mode, a tainted surface) must NOT, or requiring proof would mean never showing the interviewer there.
 * Both used to be a single `readable: false`. */
export type SampleStatus = "ok" | "not-ready" | "unsupported";

/** What we currently believe about the picture. `waiting` is the state the stage STARTS in once frames
 * arrive: frames existing is not yet evidence that they contain anything. */
export type PictureVerdict = "waiting" | "content" | "blank";

export interface PictureState {
  verdict: PictureVerdict;
  blankStreak: number;
}

export const initialPictureState: PictureState = { verdict: "waiting", blankStreak: 0 };

/**
 * Advance the picture verdict. Deliberately ASYMMETRIC, and that is the whole fix.
 *
 * The first version demoted after three blank samples, which means it SHOWED the picture first and
 * retracted ~3 s later. Measured on real Azure 2026-10-03: the black frame arrives at session START, so
 * those three seconds are exactly the ones the candidate spends looking at it. Withholding an unproven
 * picture costs nothing — the cached still or the orb is a perfectly good thing to show — while
 * retracting one is a visible flip. So:
 *
 * - promotion needs ONE frame with content; a blank frame while `waiting` just keeps waiting;
 * - demotion from `content` needs a RUN of blanks, so a decoder hiccup is not a verdict;
 * - `not-ready` changes nothing: there was no frame to judge;
 * - `unsupported` promotes immediately, because "we cannot check" must not become "never show".
 */
export function nextPictureState(
  state: PictureState,
  status: SampleStatus,
  luma: number,
): PictureState {
  if (status === "not-ready") return state;
  if (status === "unsupported") {
    return state.verdict === "waiting" ? { verdict: "content", blankStreak: 0 } : state;
  }
  // One good frame is proof, from any state — including back from `blank` when the avatar recovers.
  if (!isBlankFrame(luma)) return { verdict: "content", blankStreak: 0 };
  const blankStreak = state.blankStreak + 1;
  const verdict: PictureVerdict =
    state.verdict === "content" && blankStreak >= BLANK_STREAK_TO_FAIL ? "blank" : state.verdict;
  return { verdict, blankStreak };
}

/** Whether the picture may be shown. Only a proven one may. */
export function pictureIsShowable(state: PictureState): boolean {
  return state.verdict === "content";
}
