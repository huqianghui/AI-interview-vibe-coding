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

/** The interview stage's flat background. MUST equal the RGB of the backend's
 * `INTERVIEW_STAGE_BACKGROUND_RGBA` (voice_live_metadata.py), which Azure paints behind the avatar
 * so the video edge is invisible on the stage. */
export const AVATAR_STAGE_COLOR = "#1c1d3a";
