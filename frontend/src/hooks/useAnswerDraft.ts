import { useRef } from "react";

/**
 * The candidate's in-progress answer, and the bookkeeping that decides what "I'm done" submits.
 *
 * Extracted from `useInterviewVoice` because this is where a real bug lived, not because the file was
 * long. v0.40.0.0 shipped a deterministic draft loss: `restartForMediaMode` carefully preserved the
 * answer and `connect()` wiped it three lines later, and neither function could see the other — the
 * rule "keep what the candidate has already said" was spread across two places 700 lines apart. Giving
 * that rule one owner with its own tests is the point.
 *
 * WHAT THIS OWNS: the finalized segments that make up the draft, the streaming partials, the promise an
 * armed commit is waiting on, and the two silence timers that fire off the end of an utterance.
 *
 * WHAT THIS DOES NOT OWN, deliberately: the decision of whether to send `response.create` when a commit
 * runs. That depends on whether a response is already active and on whether the session uses linear
 * turns — WebSocket turn protocol, not draft state. `commitAnswer` keeps that and calls in here for the
 * state, which is why this module needs no `send` and no session refs injected.
 *
 * The returned handle is built ONCE and is referentially stable for the life of the hook. That is
 * load-bearing: consumers put it in `useCallback` dependency arrays, and a fresh object each render
 * would re-create every one of them. `useInterviewVoice` has already been bitten by exactly that — an
 * effect depending on a per-render object tore the connection down mid-handshake.
 */
export interface AnswerDraftHandle {
  /** The draft as "I'm done" would submit it right now. */
  peek: () => string;
  /** Record a finalized transcript that arrived with no commit armed (the server-VAD case). */
  pushSegment: (text: string) => void;
  /** Take the whole draft and clear it. Returns "" when there is nothing buffered. */
  drain: () => string;
  /** Accumulate one streaming fragment for an Azure item; returns the running text for that item. */
  notePartial: (itemId: string, delta: string) => string;
  hasPartial: (itemId: string) => boolean;
  dropPartial: (itemId: string) => void;
  /** Arm a commit that is waiting for the next finalized transcript. */
  armPending: (resolve: (text: string) => void, timeoutMs: number) => void;
  hasPending: () => boolean;
  /** Add a transcript to the armed commit. Returns false when nothing was armed. */
  landTranscript: (text: string) => boolean;
  /** Resolve an armed commit with whatever it has accumulated, usually "". */
  settlePending: () => void;
  /**
   * Turn boundary. Without `keepDraft` the draft is dropped, because carrying segments across a
   * disconnect would mis-attribute them to the next question. With it — an automatic mid-answer
   * reconnect, where the candidate is still on the same question — the draft survives, and any
   * utterance whose `.completed` will now never arrive is folded in from its last partial first, so
   * words the candidate watched stream are not missing from what gets submitted.
   */
  reset: (opts?: { keepDraft?: boolean }) => void;
  armSilenceAutoCommit: (fire: () => void, delayMs: number) => void;
  clearSilenceAutoCommit: () => void;
  armJudge: (fire: () => void, delayMs: number) => void;
  clearJudge: () => void;
}

export function useAnswerDraft(): AnswerDraftHandle {
  /** Finalized transcripts buffered between commits. Under server-VAD (our production config) Azure
   * emits `input_audio_transcription.completed` when the candidate stops talking — BEFORE they click
   * "I'm done" — so these usually hold the whole answer by the time a commit runs. Without the buffer
   * those transcripts reached only the panel, and `commitAnswer` timed out to "" and reported that we
   * had not heard the answer while it was visible on screen. */
  const segmentsRef = useRef<string[]>([]);
  /** Streaming partials, keyed by Azure conversation item id. Display-only: a commit never reads them,
   * because `.completed` finalizes the same id and is the single source of submitted text. The one
   * exception is a `keepDraft` reset, where a partial is all that will ever exist for that utterance. */
  const partialsRef = useRef<Map<string, string>>(new Map());
  const pendingRef = useRef<{
    resolve: (text: string) => void;
    parts: string[];
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const judgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleRef = useRef<AnswerDraftHandle | null>(null);
  if (!handleRef.current) {
    const clearSilenceAutoCommit = () => {
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
    };
    const clearJudge = () => {
      if (judgeTimerRef.current) {
        clearTimeout(judgeTimerRef.current);
        judgeTimerRef.current = null;
      }
    };
    const settlePending = () => {
      const pending = pendingRef.current;
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingRef.current = null;
      pending.resolve(pending.parts.join(" ").trim());
    };

    handleRef.current = {
      peek: () => segmentsRef.current.join(" ").trim(),
      pushSegment: (text) => {
        segmentsRef.current.push(text);
      },
      drain: () => {
        const text = segmentsRef.current.join(" ").trim();
        segmentsRef.current = [];
        return text;
      },
      notePartial: (itemId, delta) => {
        const running = (partialsRef.current.get(itemId) ?? "") + delta;
        partialsRef.current.set(itemId, running);
        return running;
      },
      hasPartial: (itemId) => partialsRef.current.has(itemId),
      dropPartial: (itemId) => {
        partialsRef.current.delete(itemId);
      },
      armPending: (resolve, timeoutMs) => {
        const timer = setTimeout(() => {
          const pending = pendingRef.current;
          if (!pending) return;
          pendingRef.current = null;
          // Fail closed to whatever arrived, usually "", so an awaiting caller can never hang.
          resolve(pending.parts.join(" ").trim());
        }, timeoutMs);
        pendingRef.current = { resolve, parts: [], timer };
      },
      hasPending: () => pendingRef.current !== null,
      landTranscript: (text) => {
        const pending = pendingRef.current;
        if (!pending) return false;
        if (text) pending.parts.push(text);
        return true;
      },
      settlePending,
      reset: (opts) => {
        if (!opts?.keepDraft) segmentsRef.current = [];
        clearSilenceAutoCommit();
        clearJudge();
        // Fold before clearing, and only under keepDraft: these item ids belong to a session that is
        // going away, so their `.completed` events will never arrive.
        if (opts?.keepDraft) {
          for (const partial of partialsRef.current.values()) {
            const text = partial.trim();
            if (text) segmentsRef.current.push(text);
          }
        }
        partialsRef.current.clear();
        // Settle last: a commit waiting on a transcript that can no longer arrive would otherwise keep
        // `await commitAnswer()` hanging past the WebSocket it was waiting on.
        settlePending();
      },
      armSilenceAutoCommit: (fire, delayMs) => {
        clearSilenceAutoCommit();
        silenceTimerRef.current = setTimeout(() => {
          silenceTimerRef.current = null;
          fire();
        }, delayMs);
      },
      clearSilenceAutoCommit,
      armJudge: (fire, delayMs) => {
        clearJudge();
        judgeTimerRef.current = setTimeout(() => {
          judgeTimerRef.current = null;
          fire();
        }, delayMs);
      },
      clearJudge,
    };
  }
  return handleRef.current;
}
