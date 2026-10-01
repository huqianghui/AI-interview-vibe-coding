import { useRef } from "react";

/**
 * The policy around opening a voice session: who may start one, how many times a drop is retried, and
 * when to stop retrying and tell the candidate the voice is gone.
 *
 * Three counters live here and the DIFFERENCE between them is the thing worth protecting, because each
 * was separately the subject of a shipped bug:
 *
 * 1. **The per-drop retry budget.** An unexpected close retries a bounded number of times with backoff.
 *    A deliberate media-mode rebuild resets it, because a policy switch is not a failure and must not
 *    spend the retries a real drop needs.
 * 2. **The attempts-since-live ceiling.** The inverse of that reset: on a link bad enough to force
 *    switch after switch, every switch handed the socket a fresh budget, so a connection failing for
 *    unrelated reasons might never reach the terminal state the candidate has to see. This counter is
 *    the one thing a switch does NOT reset — only a session that actually reaches `session.updated`
 *    clears it.
 * 3. **The in-flight guard.** Two affordances reach the connect path and are deliberately never
 *    disabled, so two clicks could open rival sessions sharing one set of refs. A second caller joins
 *    the attempt already running. The two internal paths that genuinely need a new session say so
 *    explicitly, because de-duplicating them would silently drop a media-mode switch.
 *
 * Extracted from `useInterviewVoice` as the last step of its split. The socket itself stays in the hook:
 * this owns the policy, not the resource. The handle is referentially stable.
 */
export interface ConnectionPolicyHandle {
  /**
   * An attempt already running that this caller should join, or null to go ahead. `replaceInFlight`
   * means the caller has already torn the old socket down and genuinely needs a new session.
   */
  inFlight: (replaceInFlight: boolean) => Promise<void> | null;
  /**
   * Record `attempt` as the in-flight one and clear the slot when it settles — but only if it still
   * owns the slot, since a `replaceInFlight` caller may have started a newer one meanwhile. Returns the
   * same promise so the two cannot be done separately and one of them forgotten.
   */
  track: (attempt: Promise<void>) => Promise<void>;

  /** Count a new attempt. False when the attempts-since-live ceiling is exceeded. */
  countAttempt: () => boolean;
  /** A session reached `session.updated`. It works, whatever it took to get here. */
  noteLive: () => void;
  /** A fresh, non-reconnect connect: restore the per-drop budget and clear the terminal latch. */
  resetDropBudget: () => void;

  /** The next reconnect delay, consuming one retry. Null when the per-drop budget is spent. */
  takeRetryDelay: () => number | null;
  /** Is a reconnect already under way? A pre-connect error during one is transient, not terminal. */
  isRetrying: () => boolean;

  /** Latch a terminal failure so a later close does not restart the retry loop. */
  latchFatal: () => void;
  isFatal: () => boolean;

  /** We are closing the socket ourselves: the close must not be treated as a drop worth retrying. */
  markIntentionalClose: () => void;
  clearIntentionalClose: () => void;
  wasIntentionalClose: () => boolean;

  /** Session teardown: no in-flight attempt, no budgets spent, no latches. */
  reset: () => void;
}

export function useConnectionPolicy(
  maxDropRetries: number,
  retryDelaysMs: readonly number[],
  maxAttemptsWithoutLive: number,
): ConnectionPolicyHandle {
  const inFlightRef = useRef<Promise<void> | null>(null);
  const dropRetriesRef = useRef(0);
  const attemptsSinceLiveRef = useRef(0);
  const intentionalCloseRef = useRef(false);
  const fatalRef = useRef(false);

  const handleRef = useRef<ConnectionPolicyHandle | null>(null);
  if (!handleRef.current) {
    handleRef.current = {
      inFlight: (replaceInFlight) =>
        inFlightRef.current && !replaceInFlight ? inFlightRef.current : null,
      track: async (attempt) => {
        inFlightRef.current = attempt;
        try {
          await attempt;
        } finally {
          if (inFlightRef.current === attempt) inFlightRef.current = null;
        }
      },

      countAttempt: () => {
        attemptsSinceLiveRef.current += 1;
        return attemptsSinceLiveRef.current <= maxAttemptsWithoutLive;
      },
      noteLive: () => {
        attemptsSinceLiveRef.current = 0;
      },
      resetDropBudget: () => {
        dropRetriesRef.current = 0;
        fatalRef.current = false;
      },

      takeRetryDelay: () => {
        if (dropRetriesRef.current >= maxDropRetries) return null;
        dropRetriesRef.current += 1;
        // Past the end of the table, hold the last interval rather than retrying faster.
        return retryDelaysMs[dropRetriesRef.current - 1] ?? retryDelaysMs[retryDelaysMs.length - 1] ?? 4000;
      },
      isRetrying: () => dropRetriesRef.current > 0,

      latchFatal: () => {
        fatalRef.current = true;
      },
      isFatal: () => fatalRef.current,

      markIntentionalClose: () => {
        intentionalCloseRef.current = true;
      },
      clearIntentionalClose: () => {
        intentionalCloseRef.current = false;
      },
      wasIntentionalClose: () => intentionalCloseRef.current,

      reset: () => {
        inFlightRef.current = null;
        dropRetriesRef.current = 0;
        attemptsSinceLiveRef.current = 0;
        intentionalCloseRef.current = false;
        fatalRef.current = false;
      },
    };
  }
  return handleRef.current;
}
