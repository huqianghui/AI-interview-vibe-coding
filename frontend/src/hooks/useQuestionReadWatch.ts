import { useRef } from "react";

/**
 * Makes sure a question that was handed to the voice session actually got read, and retries when it
 * did not.
 *
 * The page latches a question as "spoken" the moment `speakQuestion` returns true, so from that point
 * this owns making the read happen. Two things can go wrong and both have happened live: the read is
 * never delivered (a collision rejection, a stalled response), or it IS delivered and we fail to
 * notice — which retries a question the candidate already heard. The second one is worse, and it
 * shipped twice as the "read twice" regression.
 *
 * Delivery is confirmed two ways, strongest first:
 *   1. BY RESPONSE ID. `emitSpeak` arms the wait, the next `response.created` claims its id, and any
 *      transcript under that id proves our attempt produced a playing response. Immune to the agent
 *      paraphrasing or ignoring the injected text.
 *   2. BY TEXT, for id-less paths — `readWasDelivered` below.
 */

/**
 * Did `spoken` deliver `wanted`?
 *
 * A prefix probe alone is not enough: the agent paraphrases ("Could you tell me about your relevant
 * experience…" for a question that started differently, live-observed), so a prefix-only check never
 * confirmed and the watchdog retried a read that had played. Hence the word-overlap fallback: a
 * paraphrase shares most of the question's content words, while an unrelated server-VAD auto-response
 * does not, so 60% of the question's words appearing in the spoken text confirms delivery without
 * false-confirming on someone else's turn.
 *
 * Exported and pure so the rule can be tested directly — it is where the "read twice" bug lived.
 */
export function readWasDelivered(spoken: string, wanted: string): boolean {
  if (!spoken || !wanted) return false;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const spokenNorm = norm(spoken);
  const wantedNorm = norm(wanted);
  const probe = spokenNorm.slice(0, Math.min(24, wantedNorm.length));
  if (probe && wantedNorm.startsWith(probe)) return true;

  const words = (s: string) =>
    s
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3);
  const wantedWords = [...new Set(words(wantedNorm))];
  // Under three content words there is nothing to measure overlap against, and a short question is
  // exactly where a coincidental overlap would false-confirm.
  if (wantedWords.length < 3) return false;
  const spokenWords = new Set(words(spokenNorm));
  const hit = wantedWords.filter((w) => spokenWords.has(w)).length;
  return hit / wantedWords.length >= 0.6;
}

export interface QuestionReadWatchHandle {
  /**
   * Arm (or re-arm) the watch for `text`. Returns the attempt number, or null when the retry budget is
   * spent — the caller then stops and lets the question card stand as the fallback.
   *
   * `onUnconfirmed` runs if the window closes with no confirmation. The watch is deliberately LEFT in
   * place when it fires, so the retry that follows reads the attempt count forward.
   */
  arm: (text: string, onUnconfirmed: (text: string, nextAttempt: number) => void) => number | null;
  /**
   * The read request has just gone out, so the NEXT `response.created` belongs to it. Separate from
   * `arm` on purpose: the watchdog is armed by `speakQuestion` before it decides how to deliver, and
   * the expectation is set by `emitSpeak` at the moment the request is actually sent. Collapsing them
   * would claim a response for a read that was never sent.
   */
  expectResponse: () => void;
  /** Is a read of ours in flight with no response claimed yet? A rejection in this window means
   * nothing of ours is playing, so the caller can release its optimistic in-flight marks. */
  isExpectingResponse: () => boolean;
  /** A `response.created` arrived. Claims its id for the read that is waiting for one. */
  claimResponse: (responseId: string | null) => void;
  /** Does this response id belong to our read attempt? */
  ownsResponse: (responseId: string | undefined) => boolean;
  /** Delivery proven — disarm. Safe to call when nothing is armed. */
  confirm: () => void;
  /** Confirm by text similarity, for paths that carry no response id. No-op when nothing is armed. */
  confirmByText: (assistantText: string) => void;
  /** The text currently being watched, or null. */
  watchedText: () => string | null;
  /** Clear the id claim without disarming the watch — a collision rejection re-queues the read. */
  releaseClaim: () => void;
  /**
   * Teardown. Returns the text that was still unconfirmed, so the caller can stash it for the next
   * session to re-speak: the page latched it as spoken and will never ask again.
   */
  reset: () => string | null;
}

export function useQuestionReadWatch(
  timeoutMs: number,
  maxAttempts: number,
): QuestionReadWatchHandle {
  const watchRef = useRef<{ text: string; attempts: number; timer: ReturnType<typeof setTimeout> } | null>(
    null,
  );
  /** True between arming a read and the `response.created` that claims it. */
  const awaitingRef = useRef(false);
  const responseIdRef = useRef<string | null>(null);

  const handleRef = useRef<QuestionReadWatchHandle | null>(null);
  if (!handleRef.current) {
    const disarm = () => {
      if (watchRef.current) {
        clearTimeout(watchRef.current.timer);
        watchRef.current = null;
      }
    };

    handleRef.current = {
      arm: (text, onUnconfirmed) => {
        const prior = watchRef.current;
        if (prior) clearTimeout(prior.timer);
        // Attempts carry forward only for the SAME text; a different question starts its own budget.
        const attempts = prior?.text === text ? prior.attempts + 1 : 1;
        if (attempts > maxAttempts) {
          watchRef.current = null;
          awaitingRef.current = false;
          responseIdRef.current = null;
          return null;
        }
        watchRef.current = {
          text,
          attempts,
          timer: setTimeout(() => {
            // Left in place on purpose: the retry re-enters and reads this as `prior` to carry the
            // attempt count forward. Its timer has already fired, so re-clearing it is a no-op.
            onUnconfirmed(text, attempts + 1);
          }, timeoutMs),
        };
        return attempts;
      },
      expectResponse: () => {
        awaitingRef.current = true;
        responseIdRef.current = null;
      },
      isExpectingResponse: () => awaitingRef.current,
      claimResponse: (responseId) => {
        if (!awaitingRef.current) return;
        awaitingRef.current = false;
        responseIdRef.current = responseId;
      },
      ownsResponse: (responseId) =>
        Boolean(responseId) && responseId === responseIdRef.current,
      confirm: disarm,
      confirmByText: (assistantText) => {
        const watch = watchRef.current;
        if (!watch) return;
        if (readWasDelivered(assistantText, watch.text)) disarm();
      },
      watchedText: () => watchRef.current?.text ?? null,
      releaseClaim: () => {
        awaitingRef.current = false;
        responseIdRef.current = null;
      },
      reset: () => {
        const unconfirmed = watchRef.current?.text ?? null;
        disarm();
        awaitingRef.current = false;
        responseIdRef.current = null;
        return unconfirmed;
      },
    };
  }
  return handleRef.current;
}
