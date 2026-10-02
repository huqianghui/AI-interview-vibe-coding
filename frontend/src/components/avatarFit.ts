/**
 * Object-fit choice for the digital human's live stream / cached still, by intrinsic aspect ratio.
 *
 * Azure Voice Live VIDEO avatars (lisa, …) stream 16:9 — a centred person on wide margins, so
 * `cover` fills the stage and only crops margin. PHOTO avatars (vasa-1: amira, adrian, …) stream a
 * 512×512 SQUARE (live-verified 2026-09-24); `cover` on a wider-than-square stage cut the shoulders
 * and chin off (issue1), so those keep the whole frame with `contain`. Unknown size → contain.
 */

/** Streams at least this wide-for-their-height are treated as the 16:9 video-avatar frame. Square
 * (1.0) and portrait photo avatars fall well below; 16:9 (1.78) well above. */
export const COVER_FIT_MIN_ASPECT = 1.4;

export type AvatarFit = "cover" | "contain";

/** Pick the object-fit for a stream of the given intrinsic width/height (unknown → contain). */
export function fitFor(width: number, height: number): AvatarFit {
  if (width <= 0 || height <= 0) return "contain";
  return width / height >= COVER_FIT_MIN_ASPECT ? "cover" : "contain";
}

/** Largest box of aspect `ratio` (w/h) that fits inside `parentW × parentH` — the "hug" size the
 * avatar box takes so the media fills it exactly (no letterbox band, no frame). Null on degenerate
 * input (the box then just fills its parent). */
export function fitBox(parentW: number, parentH: number, ratio: number) {
  if (parentW <= 0 || parentH <= 0 || !(ratio > 0)) return null;
  const width = Math.min(parentW, parentH * ratio);
  return { width: Math.round(width), height: Math.round(width / ratio) };
}

/**
 * The aspect the avatar box should HUG, or null to fill its column instead.
 *
 * Hugging means sizing the box to the media's exact shape, which is what removes the letterbox around
 * a square photo avatar. For a WIDE stream in a tall column it does the opposite of what is wanted:
 * measured on the live site, a 16:9 stream in an 826x829 column hugged to 826x465 and left the bottom
 * 364px empty, so the stage lined up with the question card at the top and nowhere near it at the
 * bottom. A cover-fit stream fills the column and crops its own margins instead — which is what
 * `fitFor` already says to do with it, since those margins are empty wall either side of a centred
 * person. So: hug only what we keep whole.
 */
export function hugRatioFor(fit: AvatarFit, ratio: number | null): number | null {
  return fit === "contain" ? ratio : null;
}
