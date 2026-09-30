/**
 * Unit guard for `useAnswerDraft` — the candidate's in-progress answer.
 *
 * This module exists because v0.40.0.0 shipped a deterministic draft loss: the rule "keep what the
 * candidate has already said" lived in two functions 700 lines apart, and one wiped what the other
 * preserved. The tests below are the boundary that rule now has. The `keepDraft` cases are the ones
 * that matter most; the rest cover the contract so a future edit cannot quietly change it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { useAnswerDraft } from "./useAnswerDraft";

function draftHook() {
  return renderHook(() => useAnswerDraft()).result;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useAnswerDraft — the draft itself", () => {
  it("starts empty and joins finalized segments with single spaces", () => {
    const r = draftHook();
    expect(r.current.peek()).toBe("");
    r.current.pushSegment("I led the EMEA rollout");
    r.current.pushSegment("across four markets");
    expect(r.current.peek()).toBe("I led the EMEA rollout across four markets");
  });

  it("drain returns the draft and leaves it empty", () => {
    const r = draftHook();
    r.current.pushSegment("first");
    r.current.pushSegment("second");
    expect(r.current.drain()).toBe("first second");
    expect(r.current.peek()).toBe("");
    expect(r.current.drain()).toBe("");
  });

  it("trims, so a trailing-space segment cannot submit a padded answer", () => {
    const r = draftHook();
    r.current.pushSegment("  spoken words  ");
    expect(r.current.peek()).toBe("spoken words");
  });
});

describe("useAnswerDraft — streaming partials", () => {
  it("accumulates fragments per item and reports the running text", () => {
    const r = draftHook();
    expect(r.current.notePartial("item-1", "I led ")).toBe("I led ");
    expect(r.current.notePartial("item-1", "the rollout")).toBe("I led the rollout");
    expect(r.current.hasPartial("item-1")).toBe(true);
  });

  it("keeps items separate, so two utterances in flight cannot bleed together", () => {
    const r = draftHook();
    r.current.notePartial("a", "first utterance");
    r.current.notePartial("b", "second utterance");
    expect(r.current.notePartial("a", " continues")).toBe("first utterance continues");
    expect(r.current.hasPartial("b")).toBe(true);
  });

  it("a dropped partial is forgotten, which is how a finalized item stops being live", () => {
    const r = draftHook();
    r.current.notePartial("item-1", "text");
    r.current.dropPartial("item-1");
    expect(r.current.hasPartial("item-1")).toBe(false);
  });

  it("partials never reach the draft on their own — only .completed text does", () => {
    const r = draftHook();
    r.current.notePartial("item-1", "words the candidate is still saying");
    expect(r.current.peek(), "a partial is display-only until it is finalized").toBe("");
  });
});

describe("useAnswerDraft — reset, and the keepDraft rule that caused the bug", () => {
  it("drops the draft by default, so segments cannot ride into the next question", () => {
    const r = draftHook();
    r.current.pushSegment("answer to question one");
    r.current.reset();
    expect(r.current.peek()).toBe("");
  });

  it("keeps the draft under keepDraft — the candidate is still on the same question", () => {
    const r = draftHook();
    r.current.pushSegment("I led the EMEA rollout");
    r.current.reset({ keepDraft: true });
    expect(r.current.peek()).toBe("I led the EMEA rollout");
  });

  it("folds a partial into the draft under keepDraft, because its .completed will never arrive", () => {
    // The session is going away mid-utterance. Those words were on screen; dropping them would submit
    // a truncated answer while the candidate believes it was captured.
    const r = draftHook();
    r.current.pushSegment("I led the EMEA rollout");
    r.current.notePartial("item-9", "and doubled retention");
    r.current.reset({ keepDraft: true });
    expect(r.current.peek()).toBe("I led the EMEA rollout and doubled retention");
    expect(r.current.hasPartial("item-9"), "and the partial is consumed, not left to duplicate").toBe(false);
  });

  it("does NOT fold a partial when the draft is being dropped anyway", () => {
    const r = draftHook();
    r.current.notePartial("item-9", "half a sentence");
    r.current.reset();
    expect(r.current.peek()).toBe("");
    expect(r.current.hasPartial("item-9")).toBe(false);
  });

  it("ignores a whitespace-only partial rather than folding a blank segment in", () => {
    const r = draftHook();
    r.current.pushSegment("real words");
    r.current.notePartial("item-9", "   ");
    r.current.reset({ keepDraft: true });
    expect(r.current.peek()).toBe("real words");
  });

  it("settles an armed commit on reset, so an awaiting caller cannot hang past the session", () => {
    const r = draftHook();
    const resolve = vi.fn();
    r.current.armPending(resolve, 5_000);
    r.current.reset({ keepDraft: true });
    expect(resolve, "await commitAnswer() must not outlive the WebSocket it waited on").toHaveBeenCalledWith("");
    expect(r.current.hasPending()).toBe(false);
  });

  it("disarms both silence timers on reset, so neither fires into a dead session", () => {
    const r = draftHook();
    const auto = vi.fn();
    const judge = vi.fn();
    r.current.armSilenceAutoCommit(auto, 1_000);
    r.current.armJudge(judge, 1_000);
    r.current.reset();
    vi.advanceTimersByTime(5_000);
    expect(auto).not.toHaveBeenCalled();
    expect(judge).not.toHaveBeenCalled();
  });
});

describe("useAnswerDraft — an armed commit", () => {
  it("lands a transcript into the armed commit and settles with it", () => {
    const r = draftHook();
    const resolve = vi.fn();
    r.current.armPending(resolve, 5_000);
    expect(r.current.landTranscript("the spoken answer")).toBe(true);
    r.current.settlePending();
    expect(resolve).toHaveBeenCalledWith("the spoken answer");
  });

  it("joins several transcripts that land before it settles", () => {
    const r = draftHook();
    const resolve = vi.fn();
    r.current.armPending(resolve, 5_000);
    r.current.landTranscript("first part");
    r.current.landTranscript("second part");
    r.current.settlePending();
    expect(resolve).toHaveBeenCalledWith("first part second part");
  });

  it("reports when nothing is armed, which is how the caller knows to buffer instead", () => {
    const r = draftHook();
    expect(r.current.landTranscript("arrived early")).toBe(false);
    expect(r.current.hasPending()).toBe(false);
  });

  it("fails closed to an empty string on timeout rather than hanging", () => {
    const r = draftHook();
    const resolve = vi.fn();
    r.current.armPending(resolve, 4_000);
    vi.advanceTimersByTime(4_000);
    expect(resolve).toHaveBeenCalledWith("");
    expect(r.current.hasPending()).toBe(false);
  });

  it("a settled commit cannot be settled twice, so a resolve cannot double-fire", () => {
    const r = draftHook();
    const resolve = vi.fn();
    r.current.armPending(resolve, 5_000);
    r.current.settlePending();
    r.current.settlePending();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("settling leaves no timer behind", () => {
    // Not observable through resolve — a stray timer finds pendingRef already null and returns. But a
    // leaked timeout per commit, in an interview with dozens of turns, is a real leak, and asserting
    // the timer count is what makes removing the clearTimeout detectable at all. Found by mutating the
    // clearTimeout away and noticing nothing failed.
    const r = draftHook();
    const before = vi.getTimerCount();
    r.current.armPending(vi.fn(), 4_000);
    expect(vi.getTimerCount()).toBe(before + 1);
    r.current.settlePending();
    expect(vi.getTimerCount(), "the commit's timeout must be cancelled, not merely ignored").toBe(before);
  });

  it("reset also leaves no timer behind, for the same reason", () => {
    const r = draftHook();
    const before = vi.getTimerCount();
    r.current.armPending(vi.fn(), 4_000);
    r.current.armSilenceAutoCommit(vi.fn(), 2_000);
    r.current.armJudge(vi.fn(), 2_000);
    expect(vi.getTimerCount()).toBe(before + 3);
    r.current.reset();
    expect(vi.getTimerCount(), "a turn boundary must not leak three timers").toBe(before);
  });

  it("settling cancels the timeout, so it cannot resolve again later", () => {
    const r = draftHook();
    const resolve = vi.fn();
    r.current.armPending(resolve, 4_000);
    r.current.landTranscript("answered in time");
    r.current.settlePending();
    vi.advanceTimersByTime(10_000);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("answered in time");
  });
});

describe("useAnswerDraft — the two silence timers", () => {
  it("fires the auto-commit callback after its delay", () => {
    const r = draftHook();
    const fire = vi.fn();
    r.current.armSilenceAutoCommit(fire, 2_000);
    vi.advanceTimersByTime(1_999);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("re-arming replaces the pending timer instead of stacking a second one", () => {
    // Each buffered utterance re-arms this. Stacking would auto-submit early, mid-answer.
    const r = draftHook();
    const fire = vi.fn();
    r.current.armSilenceAutoCommit(fire, 2_000);
    vi.advanceTimersByTime(1_500);
    r.current.armSilenceAutoCommit(fire, 2_000);
    vi.advanceTimersByTime(1_500);
    expect(fire, "the replaced timer must not fire").not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("clearing stops the auto-commit from firing", () => {
    const r = draftHook();
    const fire = vi.fn();
    r.current.armSilenceAutoCommit(fire, 2_000);
    r.current.clearSilenceAutoCommit();
    vi.advanceTimersByTime(5_000);
    expect(fire).not.toHaveBeenCalled();
  });

  it("the judge timer is independent of the auto-commit timer", () => {
    // They arm off the same end-of-utterance but have their own delays; clearing one must not
    // silently disarm the other.
    const r = draftHook();
    const auto = vi.fn();
    const judge = vi.fn();
    r.current.armSilenceAutoCommit(auto, 3_000);
    r.current.armJudge(judge, 1_000);
    r.current.clearSilenceAutoCommit();
    vi.advanceTimersByTime(3_000);
    expect(auto).not.toHaveBeenCalled();
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it("re-arming the judge timer also replaces rather than stacks", () => {
    const r = draftHook();
    const fire = vi.fn();
    r.current.armJudge(fire, 2_000);
    vi.advanceTimersByTime(1_500);
    r.current.armJudge(fire, 2_000);
    vi.advanceTimersByTime(1_500);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(fire).toHaveBeenCalledTimes(1);
  });
});

describe("useAnswerDraft — handle stability", () => {
  it("returns the same object across renders, so consumers' dependency arrays stay stable", () => {
    // Load-bearing, not cosmetic: this handle goes into useCallback deps in useInterviewVoice, and a
    // fresh object per render would re-create every one of them. That exact shape once tore the
    // avatar connection down mid-handshake.
    const { result, rerender } = renderHook(() => useAnswerDraft());
    const first = result.current;
    rerender();
    rerender();
    expect(result.current).toBe(first);
  });

  it("keeps state across a re-render", () => {
    const { result, rerender } = renderHook(() => useAnswerDraft());
    result.current.pushSegment("said before the re-render");
    rerender();
    expect(result.current.peek()).toBe("said before the re-render");
  });
});
