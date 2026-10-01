import { useRef } from "react";

/**
 * Decides which question text may be sent to be read, which one is queued behind an active response,
 * and which was last attempted.
 *
 * Three rules that each exist because of a shipped bug:
 *
 * 1. **Idempotency.** Several routes reach the read path — the idle read, the `response.done` flush, and
 *    the collision re-queue — and every `response.done` fires the flush. Without a per-text guard the
 *    same backend question was emitted on successive done events and Azure read it two or three times
 *    as separate responses, each its own transcript bubble.
 * 2. **One retry of a genuinely rejected attempt.** A collision rejection means the attempt was never
 *    read, so the guard is cleared for exactly that text and it is re-queued. Without this the guard
 *    would block the only retry that was legitimate.
 * 3. **Latest wins when queued.** The backend only ever advances, so a newer question supersedes an
 *    older queued one rather than both being read.
 *
 * Extracted from `useInterviewVoice` as step four of its split. The handle is referentially stable.
 */
export interface SpeakQueueHandle {
  /**
   * Claim the right to emit `text`. False when it is already the text handed to a live response — the
   * caller must then do nothing, which is what makes a redundant flush a no-op instead of a re-read.
   * Claiming also records the attempt, so the two can never drift apart.
   */
  claimEmit: (text: string) => boolean;
  /** Drop the idempotency guard entirely, so the very next emit is allowed whatever it says. */
  clearGuard: () => void;
  /** The text most recently handed to a live response — what the verbatim check compares against. */
  lastEmitted: () => string | null;
  /** A real `response.created` accepted the attempt, so there is nothing left to re-queue. */
  noteAccepted: () => void;
  /**
   * A collision rejected our attempt. Re-queues exactly that text and clears its guard, so the single
   * retry is allowed through. No-op when there is no attempt outstanding.
   */
  requeueRejectedAttempt: () => void;
  /**
   * The watchdog is retrying `text` because it was never confirmed. Clears the guard and any queue
   * entry for it: by now the guard can only be blocking a read that never played, since a real one
   * would have confirmed.
   */
  allowRetry: (text: string) => void;
  /** Queue `text` to be read once the conversation goes idle. Latest wins. */
  queue: (text: string) => void;
  /** Take the queued text and clear it, or null when nothing is queued. */
  takeQueued: () => string | null;
  /** Session teardown: no queue, no attempt, no guard. */
  reset: () => void;
}

export function useSpeakQueue(): SpeakQueueHandle {
  /** A question queued while a response was active, flushed when that response ends. */
  const queuedRef = useRef<string | null>(null);
  /** The most recent attempt, kept so a collision rejection can re-queue exactly that text. */
  const lastAttemptRef = useRef<string | null>(null);
  /** The text most recently handed to a real `response.create` — the idempotency guard. */
  const emittedRef = useRef<string | null>(null);

  const handleRef = useRef<SpeakQueueHandle | null>(null);
  if (!handleRef.current) {
    handleRef.current = {
      claimEmit: (text) => {
        if (emittedRef.current === text) return false;
        lastAttemptRef.current = text;
        emittedRef.current = text;
        return true;
      },
      clearGuard: () => {
        emittedRef.current = null;
      },
      lastEmitted: () => emittedRef.current,
      noteAccepted: () => {
        lastAttemptRef.current = null;
      },
      requeueRejectedAttempt: () => {
        const attempt = lastAttemptRef.current;
        if (!attempt) return;
        queuedRef.current = attempt;
        // Only for THIS text: a guard set by some later, unrelated emit must survive.
        if (emittedRef.current === attempt) emittedRef.current = null;
        lastAttemptRef.current = null;
      },
      allowRetry: (text) => {
        if (emittedRef.current === text) emittedRef.current = null;
        if (queuedRef.current === text) queuedRef.current = null;
      },
      queue: (text) => {
        queuedRef.current = text;
      },
      takeQueued: () => {
        const text = queuedRef.current;
        queuedRef.current = null;
        return text;
      },
      reset: () => {
        queuedRef.current = null;
        lastAttemptRef.current = null;
        emittedRef.current = null;
      },
    };
  }
  return handleRef.current;
}
