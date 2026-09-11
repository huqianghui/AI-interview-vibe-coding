import { useEffect, useRef } from "react";

/**
 * External-brain mic auto-pause (issue2 regression guard).
 *
 * In external voice mode the mic must pause while the turn is NOT open — the backend is producing
 * the next question, or a stalled turn awaits 恢复 — and unpause when it reopens, so the candidate
 * can't "answer" into a turn that isn't accepting input. Bank mode never uses this (the candidate
 * drives their own end-of-answer there); the caller gates that via `active`.
 *
 * The catch (issue2): this must act ONLY on TRANSITIONS of `shouldPause`. The caller's voice object
 * is a fresh identity every render, so an effect wired to it re-runs on every render — and the old
 * code re-asserted `setMuted(shouldPause)` each time. During an open turn `shouldPause` is false, so
 * every unrelated re-render fired `setMuted(false)` and clobbered the candidate's own Mute button
 * (it flipped straight back to unmuted). Tracking the last applied value in a ref makes an unrelated
 * re-render a no-op: we drive the mic only when the backend-open state actually flips, leaving a
 * manual mute untouched during an open turn.
 */
export function useExternalMicAutoPause(
  setMuted: (muted: boolean) => void,
  { active, shouldPause }: { active: boolean; shouldPause: boolean },
): void {
  // Last auto-pause value we applied. Not React state: it must never itself trigger a render, and
  // reads/writes are synchronous within the effect.
  const autoPausedRef = useRef(false);
  useEffect(() => {
    if (!active) {
      // Not our turn to drive the mic (bank mode, text channel, or disconnected). Forget any pause
      // we applied so re-activation recomputes a clean transition.
      autoPausedRef.current = false;
      return;
    }
    if (shouldPause === autoPausedRef.current) return; // no transition → leave the mic (and any manual mute) alone
    autoPausedRef.current = shouldPause;
    setMuted(shouldPause);
  }, [active, shouldPause, setMuted]);
}
