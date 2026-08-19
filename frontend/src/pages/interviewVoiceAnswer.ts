/**
 * Pure helper for finalizing a voice answer turn (Phase 4), split out of InterviewPage so the
 * page file only exports a component (react-refresh) and this logic is unit-testable without the
 * live voice path (which can't run in jsdom).
 *
 * NOTE: the live page no longer calls this. `onVoiceDone` now awaits `useInterviewVoice`'s
 * `commitAnswer()`, which resolves THIS turn's finalized transcript directly from the STT
 * round-trip (fixing the stale-`segments` race that submitted the previous turn's text). This
 * pure helper + its unit tests are retained as a cheap, side-effect-free utility and can be
 * removed in a later cleanup.
 */
import type { TranscriptSegment } from "../types/voice";

/**
 * The finalized voice answer for a turn: every not-yet-submitted final user segment, in order,
 * joined. A candidate who pauses mid-answer produces several final segments; taking only the last
 * one silently dropped the rest. `submittedIds` are the segment ids already POSTed on prior turns.
 */
export function collectVoiceAnswer(
  segments: TranscriptSegment[],
  submittedIds: Set<string>,
): { text: string; ids: string[] } {
  const fresh = segments.filter(
    (s) => s.role === "user" && s.isFinal && !submittedIds.has(s.id),
  );
  return {
    text: fresh
      .map((s) => s.content)
      .join(" ")
      .trim(),
    ids: fresh.map((s) => s.id),
  };
}
