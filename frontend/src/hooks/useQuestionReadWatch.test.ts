/**
 * Unit guard for `useQuestionReadWatch` — making sure a question that was handed to the voice session
 * actually got read, and not reading it twice.
 *
 * The page latches a question as spoken the moment `speakQuestion` returns true, so a missed
 * confirmation retries a question the candidate already heard. That shipped twice as the "read twice"
 * regression, and the `readWasDelivered` cases below are where it lived: a prefix-only check never
 * confirmed a paraphrase, so the watchdog re-read a question that had played.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { readWasDelivered, useQuestionReadWatch } from "./useQuestionReadWatch";

const TIMEOUT = 4_000;
const MAX = 3;

function watch() {
  return renderHook(() => useQuestionReadWatch(TIMEOUT, MAX)).result;
}

const QUESTION = "Tell me about a time you led a rollout across several markets";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("readWasDelivered — the rule the read-twice bug lived in", () => {
  it("confirms a verbatim read", () => {
    expect(readWasDelivered(QUESTION, QUESTION)).toBe(true);
  });

  it("confirms a read that starts the same but was cut short", () => {
    expect(readWasDelivered("Tell me about a time you led", QUESTION)).toBe(true);
  });

  it("confirms a PARAPHRASE — the case a prefix-only check missed", () => {
    // Live-observed: the agent rewrote the opening, the prefix probe never matched, and the watchdog
    // retried a question that had already played.
    expect(
      readWasDelivered("Could you tell me about a rollout you led across markets", QUESTION),
    ).toBe(true);
  });

  it("does NOT confirm an unrelated response", () => {
    // A server-VAD auto-response answering the candidate must not be mistaken for our read.
    expect(readWasDelivered("Thank you, that is helpful. Let us continue.", QUESTION)).toBe(false);
  });

  it("does NOT confirm on empty input in either direction", () => {
    expect(readWasDelivered("", QUESTION)).toBe(false);
    expect(readWasDelivered(QUESTION, "")).toBe(false);
  });

  it("ignores case and whitespace", () => {
    expect(readWasDelivered("  TELL ME   ABOUT A TIME  ", QUESTION)).toBe(true);
  });

  it("refuses to guess on a question with under three content words", () => {
    // Too short to measure overlap against, and exactly where a coincidence would false-confirm.
    // The inputs matter: a question whose words are all under three characters leaves an EMPTY word
    // list, and an empty list fails the ratio test anyway — so it cannot tell whether the guard is
    // there. This pair has exactly two content words and a 100% overlap, which passes the ratio and
    // is blocked only by the guard. Found by mutating the guard away and noticing nothing failed.
    expect(readWasDelivered("plan rollout", "rollout plan")).toBe(false);
    expect(readWasDelivered("ok go", "go on")).toBe(false);
  });

  it("two equivalent mutants, recorded rather than papered over", () => {
    // Removing the empty-input guard changes nothing: an empty string makes the prefix probe empty and
    // the word list empty, so the ratio test already returns false. Same for the `Boolean(responseId)`
    // check in `ownsResponse` — the stored id is typed `string | null` and never undefined, so the
    // comparison is already false. Both guards are belt-and-braces, and this test exists to say so
    // instead of leaving a future reader to wonder why mutating them fails nothing.
    expect(readWasDelivered("", "a real question here")).toBe(false);
    expect(readWasDelivered("a real question here", "")).toBe(false);
  });

  it("needs 60% of the content words, not just a couple", () => {
    expect(readWasDelivered("rollout markets", QUESTION)).toBe(false);
  });
});

describe("useQuestionReadWatch — arming and the retry budget", () => {
  it("counts attempts for the same text and stops after the budget", () => {
    const w = watch();
    expect(w.current.arm(QUESTION, vi.fn())).toBe(1);
    expect(w.current.arm(QUESTION, vi.fn())).toBe(2);
    expect(w.current.arm(QUESTION, vi.fn())).toBe(3);
    expect(w.current.arm(QUESTION, vi.fn()), "the budget is spent — the caller must stop").toBeNull();
  });

  it("a different question starts its own budget", () => {
    const w = watch();
    w.current.arm(QUESTION, vi.fn());
    w.current.arm(QUESTION, vi.fn());
    expect(w.current.arm("A completely different question", vi.fn())).toBe(1);
  });

  it("leaves nothing armed once the budget is spent", () => {
    const w = watch();
    for (let i = 0; i < MAX + 1; i++) w.current.arm(QUESTION, vi.fn());
    expect(w.current.watchedText()).toBeNull();
  });

  it("reports the text it is watching", () => {
    const w = watch();
    w.current.arm(QUESTION, vi.fn());
    expect(w.current.watchedText()).toBe(QUESTION);
  });

  it("re-arming replaces the pending timer instead of stacking one", () => {
    const w = watch();
    const first = vi.fn();
    const second = vi.fn();
    w.current.arm(QUESTION, first);
    vi.advanceTimersByTime(TIMEOUT - 500);
    w.current.arm(QUESTION, second);
    vi.advanceTimersByTime(TIMEOUT - 500);
    expect(first, "the replaced timer must not fire").not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("calls back with the text and the NEXT attempt number when unconfirmed", () => {
    const w = watch();
    const onUnconfirmed = vi.fn();
    w.current.arm(QUESTION, onUnconfirmed);
    vi.advanceTimersByTime(TIMEOUT);
    expect(onUnconfirmed).toHaveBeenCalledWith(QUESTION, 2);
  });

  it("leaves the watch in place when it fires, so the retry carries the count forward", () => {
    const w = watch();
    w.current.arm(QUESTION, vi.fn());
    vi.advanceTimersByTime(TIMEOUT);
    expect(w.current.arm(QUESTION, vi.fn()), "the retry must be attempt 2, not a fresh 1").toBe(2);
  });
});

describe("useQuestionReadWatch — confirming by response id", () => {
  it("claims the id of the response that follows arming", () => {
    const w = watch();
    w.current.arm(QUESTION, vi.fn());
    w.current.expectResponse();
    w.current.claimResponse("resp-1");
    expect(w.current.ownsResponse("resp-1")).toBe(true);
  });

  it("does not own a different response's id", () => {
    const w = watch();
    w.current.arm(QUESTION, vi.fn());
    w.current.expectResponse();
    w.current.claimResponse("resp-1");
    expect(w.current.ownsResponse("resp-2")).toBe(false);
  });

  it("owns nothing when no id was claimed", () => {
    const w = watch();
    w.current.arm(QUESTION, vi.fn());
    w.current.expectResponse();
    expect(w.current.ownsResponse("resp-1")).toBe(false);
  });

  it("arming alone does not expect a response — only sending the read does", () => {
    // The watchdog is armed before `speakQuestion` decides how to deliver; the expectation is set when
    // the request actually goes out. Collapsing the two would claim a response for a read never sent.
    const w = watch();
    w.current.arm(QUESTION, vi.fn());
    expect(w.current.isExpectingResponse()).toBe(false);
    w.current.expectResponse();
    expect(w.current.isExpectingResponse()).toBe(true);
    w.current.claimResponse("resp-1");
    expect(w.current.isExpectingResponse(), "a claim ends the expectation").toBe(false);
  });

  it("treats an undefined id as not ours, so a missing field cannot confirm", () => {
    const w = watch();
    w.current.arm(QUESTION, vi.fn());
    w.current.expectResponse();
    w.current.claimResponse(null);
    expect(w.current.ownsResponse(undefined)).toBe(false);
  });

  it("only the FIRST response after arming is claimed", () => {
    // A later auto-response must not steal the claim from the one our read created.
    const w = watch();
    w.current.arm(QUESTION, vi.fn());
    w.current.expectResponse();
    w.current.claimResponse("resp-ours");
    w.current.claimResponse("resp-theirs");
    expect(w.current.ownsResponse("resp-ours")).toBe(true);
    expect(w.current.ownsResponse("resp-theirs")).toBe(false);
  });

  it("claiming before arming is ignored", () => {
    const w = watch();
    w.current.claimResponse("resp-stray");
    expect(w.current.ownsResponse("resp-stray")).toBe(false);
  });

  it("releasing the claim lets the next response be claimed — the collision re-queue", () => {
    const w = watch();
    w.current.arm(QUESTION, vi.fn());
    w.current.expectResponse();
    w.current.claimResponse("resp-collided");
    w.current.releaseClaim();
    expect(w.current.ownsResponse("resp-collided")).toBe(false);
    expect(w.current.watchedText(), "releasing a claim must NOT disarm the watch").toBe(QUESTION);
  });
});

describe("useQuestionReadWatch — disarming on confirmation", () => {
  it("confirm disarms, so the retry never fires", () => {
    const w = watch();
    const onUnconfirmed = vi.fn();
    w.current.arm(QUESTION, onUnconfirmed);
    w.current.confirm();
    vi.advanceTimersByTime(TIMEOUT * 2);
    expect(onUnconfirmed).not.toHaveBeenCalled();
    expect(w.current.watchedText()).toBeNull();
  });

  it("confirm with nothing armed is harmless", () => {
    expect(() => watch().current.confirm()).not.toThrow();
  });

  it("confirmByText disarms on a paraphrase", () => {
    const w = watch();
    const onUnconfirmed = vi.fn();
    w.current.arm(QUESTION, onUnconfirmed);
    w.current.confirmByText("Could you tell me about a rollout you led across markets");
    vi.advanceTimersByTime(TIMEOUT * 2);
    expect(onUnconfirmed, "a delivered read must never be retried").not.toHaveBeenCalled();
  });

  it("confirmByText leaves the watch armed on an unrelated response", () => {
    const w = watch();
    const onUnconfirmed = vi.fn();
    w.current.arm(QUESTION, onUnconfirmed);
    w.current.confirmByText("Thank you, that is helpful.");
    vi.advanceTimersByTime(TIMEOUT);
    expect(onUnconfirmed, "an undelivered read must still be retried").toHaveBeenCalled();
  });

  it("confirmByText with nothing armed is harmless", () => {
    expect(() => watch().current.confirmByText("anything")).not.toThrow();
  });
});

describe("useQuestionReadWatch — teardown", () => {
  it("returns the unconfirmed text so the next session can re-speak it", () => {
    const w = watch();
    w.current.arm(QUESTION, vi.fn());
    expect(w.current.reset()).toBe(QUESTION);
  });

  it("returns null when the read was already confirmed", () => {
    const w = watch();
    w.current.arm(QUESTION, vi.fn());
    w.current.confirm();
    expect(w.current.reset()).toBeNull();
  });

  it("cancels the retry, so a dead session cannot read into the next one", () => {
    const w = watch();
    const onUnconfirmed = vi.fn();
    w.current.arm(QUESTION, onUnconfirmed);
    w.current.reset();
    vi.advanceTimersByTime(TIMEOUT * 2);
    expect(onUnconfirmed).not.toHaveBeenCalled();
  });

  it("clears the id claim, so a stale id cannot confirm the next session's read", () => {
    const w = watch();
    w.current.arm(QUESTION, vi.fn());
    w.current.expectResponse();
    w.current.claimResponse("resp-old");
    w.current.reset();
    expect(w.current.ownsResponse("resp-old")).toBe(false);
  });

  it("restores the retry budget for the next session", () => {
    const w = watch();
    for (let i = 0; i < MAX; i++) w.current.arm(QUESTION, vi.fn());
    w.current.reset();
    expect(w.current.arm(QUESTION, vi.fn()), "a new session gets a fresh budget").toBe(1);
  });

  it("leaves no timer behind", () => {
    const w = watch();
    const before = vi.getTimerCount();
    w.current.arm(QUESTION, vi.fn());
    expect(vi.getTimerCount()).toBe(before + 1);
    w.current.reset();
    expect(vi.getTimerCount()).toBe(before);
  });
});

describe("useQuestionReadWatch — handle stability", () => {
  it("returns the same object across renders", () => {
    const { result, rerender } = renderHook(() => useQuestionReadWatch(TIMEOUT, MAX));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
