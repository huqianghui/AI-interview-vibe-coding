/**
 * Unit guard for `useSpeakQueue` — which question text may be sent, which is queued, which was last
 * attempted.
 *
 * Every rule here exists because of a shipped bug: the same question read two or three times (several
 * routes into the read path, and every `response.done` firing the flush), a legitimate retry blocked by
 * the guard that was meant to stop duplicates, and two questions both read because a queued one was not
 * superseded.
 */
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";

import { useSpeakQueue } from "./useSpeakQueue";

const Q1 = "Tell me about a rollout you led";
const Q2 = "What would you change about it";

function queue() {
  return renderHook(() => useSpeakQueue()).result;
}

describe("useSpeakQueue — the idempotency guard", () => {
  it("allows the first emit of a text", () => {
    expect(queue().current.claimEmit(Q1)).toBe(true);
  });

  it("refuses a second emit of the SAME text — the read-three-times fix", () => {
    const q = queue();
    q.current.claimEmit(Q1);
    expect(q.current.claimEmit(Q1), "a redundant flush must be a no-op, not a re-read").toBe(false);
  });

  it("allows a different text straight after", () => {
    const q = queue();
    q.current.claimEmit(Q1);
    expect(q.current.claimEmit(Q2)).toBe(true);
  });

  it("reports the last emitted text, which the verbatim check compares against", () => {
    const q = queue();
    q.current.claimEmit(Q1);
    expect(q.current.lastEmitted()).toBe(Q1);
  });

  it("reports nothing before anything was emitted", () => {
    expect(queue().current.lastEmitted()).toBeNull();
  });

  it("clearGuard lets the same text through once more — the aside path", () => {
    const q = queue();
    q.current.claimEmit(Q1);
    q.current.clearGuard();
    expect(q.current.claimEmit(Q1)).toBe(true);
  });

  it("a refused claim does not disturb the recorded text", () => {
    const q = queue();
    q.current.claimEmit(Q1);
    q.current.claimEmit(Q1);
    expect(q.current.lastEmitted()).toBe(Q1);
  });
});

describe("useSpeakQueue — a rejected attempt gets exactly one retry", () => {
  it("re-queues the rejected text and clears its guard", () => {
    const q = queue();
    q.current.claimEmit(Q1);
    q.current.requeueRejectedAttempt();
    expect(q.current.takeQueued()).toBe(Q1);
    expect(q.current.claimEmit(Q1), "the single retry must be allowed through").toBe(true);
  });

  it("does nothing once the attempt was accepted", () => {
    // `response.created` means it is genuinely in flight; re-queueing then would read it twice.
    const q = queue();
    q.current.claimEmit(Q1);
    q.current.noteAccepted();
    q.current.requeueRejectedAttempt();
    expect(q.current.takeQueued()).toBeNull();
  });

  it("does nothing when no attempt is outstanding", () => {
    const q = queue();
    q.current.requeueRejectedAttempt();
    expect(q.current.takeQueued()).toBeNull();
  });

  it("always concerns the LATEST attempt, which is the only one it knows about", () => {
    // Written the other way round first, asserting that a rejection "belonging to Q1" could not unlock
    // Q2. That premise was wrong: nothing tracks per-text rejections, here or in the original code —
    // there is one outstanding attempt and the rejection is about that. Recorded as the real contract
    // rather than quietly deleted, because the wrong version looked reasonable.
    const q = queue();
    q.current.claimEmit(Q1);
    q.current.noteAccepted();
    q.current.claimEmit(Q2);
    q.current.requeueRejectedAttempt();
    expect(q.current.takeQueued(), "Q2 is the outstanding attempt, so Q2 is what gets retried").toBe(Q2);
    expect(q.current.claimEmit(Q2), "and its guard is cleared so the retry can go out").toBe(true);
  });

  it("clears the guard only when it matches the attempt — provably an equivalent mutant", () => {
    // Making that conditional unconditional changes nothing observable, and this is provable rather
    // than merely untested: `claimEmit` is the only thing that sets the guard, and it sets it equal to
    // the attempt. Everything else only ever sets the guard to null. So whenever an attempt is
    // outstanding the guard is either equal to it (cleared) or already null (clearing is a no-op) — a
    // different non-null value cannot arise. The original code carried the same conditional with the
    // same property. Recorded here so a future reader who mutates it and sees nothing fail knows why,
    // instead of concluding the suite is weak.
    const q = queue();
    q.current.claimEmit(Q1);
    q.current.clearGuard();
    q.current.requeueRejectedAttempt();
    expect(q.current.takeQueued()).toBe(Q1);
    expect(q.current.lastEmitted(), "nothing to clear, and nothing was wrongly set").toBeNull();
  });

  it("cannot re-queue the same rejection twice", () => {
    const q = queue();
    q.current.claimEmit(Q1);
    q.current.requeueRejectedAttempt();
    q.current.takeQueued();
    q.current.requeueRejectedAttempt();
    expect(q.current.takeQueued()).toBeNull();
  });
});

describe("useSpeakQueue — the watchdog retry path", () => {
  it("clears the guard so an unconfirmed read can be retried", () => {
    const q = queue();
    q.current.claimEmit(Q1);
    q.current.allowRetry(Q1);
    expect(q.current.claimEmit(Q1)).toBe(true);
  });

  it("clears a queue entry for the same text, so it is not also flushed later", () => {
    const q = queue();
    q.current.queue(Q1);
    q.current.allowRetry(Q1);
    expect(q.current.takeQueued()).toBeNull();
  });

  it("leaves a queue entry for a DIFFERENT text alone", () => {
    const q = queue();
    q.current.queue(Q2);
    q.current.allowRetry(Q1);
    expect(q.current.takeQueued()).toBe(Q2);
  });

  it("leaves the guard for a different text alone", () => {
    const q = queue();
    q.current.claimEmit(Q2);
    q.current.allowRetry(Q1);
    expect(q.current.claimEmit(Q2)).toBe(false);
  });
});

describe("useSpeakQueue — queueing behind an active response", () => {
  it("hands back what was queued, once", () => {
    const q = queue();
    q.current.queue(Q1);
    expect(q.current.takeQueued()).toBe(Q1);
    expect(q.current.takeQueued()).toBeNull();
  });

  it("latest wins: a newer question supersedes an older queued one", () => {
    // The backend only ever advances, so reading both would read a question the candidate has left.
    const q = queue();
    q.current.queue(Q1);
    q.current.queue(Q2);
    expect(q.current.takeQueued()).toBe(Q2);
    expect(q.current.takeQueued()).toBeNull();
  });

  it("returns null when nothing is queued", () => {
    expect(queue().current.takeQueued()).toBeNull();
  });
});

describe("useSpeakQueue — teardown", () => {
  it("clears the queue, the attempt and the guard", () => {
    const q = queue();
    q.current.claimEmit(Q1);
    q.current.queue(Q2);
    q.current.reset();
    expect(q.current.takeQueued()).toBeNull();
    expect(q.current.lastEmitted()).toBeNull();
    expect(q.current.claimEmit(Q1), "the next session may read the same question again").toBe(true);
  });

  it("leaves no attempt that a later rejection could re-queue", () => {
    const q = queue();
    q.current.claimEmit(Q1);
    q.current.reset();
    q.current.requeueRejectedAttempt();
    expect(q.current.takeQueued()).toBeNull();
  });
});

describe("useSpeakQueue — handle stability", () => {
  it("returns the same object across renders", () => {
    const { result, rerender } = renderHook(() => useSpeakQueue());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
