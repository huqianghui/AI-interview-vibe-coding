/**
 * Where the interviewer's cached still lives, and whose face is in it.
 *
 * Lifted out of AvatarView because a component file may not export helpers (react-refresh), and
 * because the storage rules are worth reading on their own — they are the difference between
 * "the person appears instantly" and "the wrong person appears instantly".
 */

/** Portrait cache, ONE SLOT PER CHARACTER.
 *
 * It used to be a single slot shared by every avatar, on the reasoning that this deployment runs one
 * default persona and "a persona change self-corrects on the next successful session". It does not
 * correct in the window that matters: the still is shown FIRST, while the stream connects, so after
 * switching the persona to a photo avatar every visit opened with the PREVIOUS character's face until
 * a session had completed — the owner saw lisa while talking to a photo avatar (2026-10-03). Showing
 * the wrong person is worse than showing no person, and keying the slot costs nothing.
 *
 * Switching characters therefore falls back to the orb until that character's own still exists, and
 * switching BACK finds the earlier one still cached. Bump the suffix if the stored format ever changes.
 *
 * v1 → v2 (2026-10-02): the MEANING changed, not the format. Portraits captured before the page
 * started sending `avatar_bg` for every avatar type carry whatever studio wall Azure happened to
 * use, so a stale slot shows the figure on a colour that no longer matches the page — and it is
 * shown FIRST on every visit, before the live stream arrives, which is exactly when a mismatched
 * rectangle is most visible. Bumping the key discards those instead of waiting for a successful
 * session to overwrite them. */
export const AVATAR_PORTRAIT_STORAGE_KEY = "avatar-portrait-v2";

/** Storage key for one character's still. ALWAYS suffixed — including `:none` for a persona with no
 * avatar — so the pre-keying slot can never be read by anything. That matters: the un-suffixed slot
 * holds whichever face was last captured before this change, and a voice-only persona reading it would
 * show a person who is not in the interview at all. `readCachedPortrait` deletes it on sight. */
export function portraitKeyFor(character?: string | null): string {
  const c = (character ?? "").trim().toLowerCase();
  return `${AVATAR_PORTRAIT_STORAGE_KEY}:${c || "none"}`;
}

export function readCachedPortrait(character?: string | null): string | null {
  try {
    // Self-cleaning migration: the un-suffixed slot predates per-character keying and can only hold a
    // face that may not be this persona's. Nothing reads it now, so free the quota instead of leaving
    // a stale 480px JPEG behind for ever.
    localStorage.removeItem(AVATAR_PORTRAIT_STORAGE_KEY);
    const v = localStorage.getItem(portraitKeyFor(character));
    return v && v.startsWith("data:image/") ? v : null;
  } catch {
    return null; // storage unavailable (privacy mode) → orb fallback, as before
  }
}
