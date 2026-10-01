import { useRef } from "react";

/**
 * Holds the FIRST question read of a session until the digital human can actually be heard.
 *
 * The problem it solves, measured: the interviewer's audio rides the avatar's WebRTC track, which only
 * carries sound once that track is flowing. Reading the opening question before then clipped its first
 * words — the candidate heard the question start mid-sentence. So the first read waits for the media
 * path, and a short bound guarantees it is never held in silence forever when the handshake stalls or
 * the avatar is off despite its flag.
 *
 * Readiness means `isMediaReady`, NOT "painting frames". On a weak link the session degrades to
 * audio-only and never paints a frame, so gating on frames made every audio-only question sit out the
 * full timeout in silence before being read.
 *
 * Only the first read of a session is gated, and only while the avatar is enabled but not yet ready.
 * Every later question reads immediately. Latest-wins: a newer question supersedes a held one.
 *
 * Extracted from `useInterviewVoice` as step two of its split. The gate's state was four separate refs
 * read from three places — `speakQuestion`, the readiness effect, and the turn reset — and the rule
 * about which of them wins was spread across all three. The handle is referentially stable, so it is
 * safe in dependency arrays.
 */
export interface FirstReadGateHandle {
  /** Should this read be held? True only for the first read, with the avatar enabled and not ready. */
  shouldHold: (avatarEnabled: boolean) => boolean;
  /**
   * Hold `text`, superseding anything already held. `speakNow` runs if the bound elapses first, and is
   * the caller's own read path — the gate never reads anything itself, it only decides when.
   */
  hold: (text: string, speakNow: (text: string) => void) => void;
  /** This read is proceeding: the first read is done, and any hold is cancelled. */
  markRead: () => void;
  /** Record avatar readiness. Returns held text to read NOW, or null when there is nothing to release. */
  noteAvatarReady: (ready: boolean) => string | null;
  /**
   * Session teardown. Clears everything and returns the text that was being held, so the caller can
   * stash it for the next session to re-speak — the page has already latched it as spoken, so dropping
   * it here would lose the question entirely.
   */
  reset: () => string | null;
}

export function useFirstReadGate(gateMs: number): FirstReadGateHandle {
  /** Flips true once an opening question has actually been handed to the read path. */
  const doneRef = useRef(false);
  const heldRef = useRef<{ text: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const avatarReadyRef = useRef(false);

  const handleRef = useRef<FirstReadGateHandle | null>(null);
  if (!handleRef.current) {
    const cancelHold = () => {
      if (heldRef.current) {
        clearTimeout(heldRef.current.timer);
        heldRef.current = null;
      }
    };

    handleRef.current = {
      shouldHold: (avatarEnabled) => !doneRef.current && avatarEnabled && !avatarReadyRef.current,
      hold: (text, speakNow) => {
        cancelHold();
        heldRef.current = {
          text,
          timer: setTimeout(() => {
            heldRef.current = null;
            console.warn("[voice] avatar-ready gate elapsed; reading first question anyway");
            // Marked done BEFORE reading, so the read that follows cannot be gated a second time.
            doneRef.current = true;
            speakNow(text);
          }, gateMs),
        };
      },
      markRead: () => {
        doneRef.current = true;
        cancelHold();
      },
      noteAvatarReady: (ready) => {
        avatarReadyRef.current = ready;
        if (!ready || !heldRef.current) return null;
        const { text } = heldRef.current;
        cancelHold();
        return text;
      },
      reset: () => {
        const held = heldRef.current?.text ?? null;
        cancelHold();
        // A new session re-gates its own opening read, so both flags go back to their initial state.
        doneRef.current = false;
        avatarReadyRef.current = false;
        return held;
      },
    };
  }
  return handleRef.current;
}
