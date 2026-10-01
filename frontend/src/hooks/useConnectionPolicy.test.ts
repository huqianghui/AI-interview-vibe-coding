/**
 * Unit guard for `useConnectionPolicy` — who may open a voice session, how often a drop is retried, and
 * when to stop and tell the candidate the voice is gone.
 *
 * The three counters here are easy to confuse with each other, and the DIFFERENCE between them is what
 * these tests protect. Each was separately a shipped bug: a media-mode rebuild spending the retries a
 * real drop needs, that same reset hiding a terminal failure for ever, and two clicks on a deliberately
 * always-clickable button opening rival sessions.
 */
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { useConnectionPolicy } from "./useConnectionPolicy";

const MAX_RETRIES = 3;
const DELAYS = [1_000, 2_000, 4_000] as const;
const MAX_WITHOUT_LIVE = 6;

function policy() {
  return renderHook(() => useConnectionPolicy(MAX_RETRIES, DELAYS, MAX_WITHOUT_LIVE)).result;
}

describe("useConnectionPolicy — the in-flight guard", () => {
  it("lets the first caller through", () => {
    expect(policy().current.inFlight(false)).toBeNull();
  });

  it("hands a second caller the attempt already running", async () => {
    const p = policy();
    const attempt = Promise.resolve();
    const tracked = p.current.track(attempt);
    expect(p.current.inFlight(false), "a double-click must join, not open a rival session").not.toBeNull();
    await tracked;
  });

  it("lets a replaceInFlight caller through anyway", async () => {
    // A media-mode rebuild has already closed the old socket and needs a NEW session; de-duplicating it
    // would silently drop the switch.
    const p = policy();
    const tracked = p.current.track(Promise.resolve());
    expect(p.current.inFlight(true)).toBeNull();
    await tracked;
  });

  it("frees the slot once the attempt settles", async () => {
    const p = policy();
    await p.current.track(Promise.resolve());
    expect(p.current.inFlight(false)).toBeNull();
  });

  it("frees the slot even when the attempt rejects", async () => {
    const p = policy();
    await p.current.track(Promise.reject(new Error("failed"))).catch(() => undefined);
    expect(p.current.inFlight(false), "a failed connect must not wedge the guard shut").toBeNull();
  });

  it("a settling attempt does not clear a NEWER one's slot", async () => {
    // The ordering that matters: a replaceInFlight caller starts a second attempt while the first is
    // still settling. Clearing on the first's settle would let a click open a rival session.
    const p = policy();
    let releaseFirst!: () => void;
    const first = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const firstTracked = p.current.track(first);
    const secondTracked = p.current.track(Promise.resolve());
    await secondTracked;
    releaseFirst();
    await firstTracked;
    // The second has settled too by now, so the slot is free — what matters is that the FIRST settling
    // did not clear the second's claim while it was live, asserted below by replaying the sequence.
    expect(p.current.inFlight(false)).toBeNull();
  });

  it("while a newer attempt is live, an older one settling leaves the claim in place", async () => {
    const p = policy();
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const second = new Promise<void>((r) => {
      releaseSecond = r;
    });
    const t1 = p.current.track(first);
    const t2 = p.current.track(second);
    releaseFirst();
    await t1;
    expect(p.current.inFlight(false), "the newer attempt still owns the slot").not.toBeNull();
    releaseSecond();
    await t2;
  });

  it("returns the same promise, so the caller awaits the real attempt", async () => {
    const p = policy();
    const spy = vi.fn();
    await p.current.track(Promise.resolve().then(spy));
    expect(spy).toHaveBeenCalled();
  });
});

describe("useConnectionPolicy — the per-drop retry budget", () => {
  it("walks the backoff table and then stops", () => {
    const p = policy();
    expect(p.current.takeRetryDelay()).toBe(1_000);
    expect(p.current.takeRetryDelay()).toBe(2_000);
    expect(p.current.takeRetryDelay()).toBe(4_000);
    expect(p.current.takeRetryDelay(), "the budget is spent").toBeNull();
  });

  it("reports whether a retry is under way", () => {
    const p = policy();
    expect(p.current.isRetrying()).toBe(false);
    p.current.takeRetryDelay();
    expect(p.current.isRetrying(), "a pre-connect error during a retry is transient").toBe(true);
  });

  it("a fresh connect restores the budget — a policy switch is not a failure", () => {
    const p = policy();
    p.current.takeRetryDelay();
    p.current.takeRetryDelay();
    p.current.resetDropBudget();
    expect(p.current.takeRetryDelay()).toBe(1_000);
    expect(p.current.isRetrying()).toBe(true);
  });

  it("holds the LAST interval rather than restarting the table past its end", () => {
    // The table must have more than one entry or this proves nothing: with a single entry, "first" and
    // "last" are the same element and the test cannot tell them apart. Found by mutating last→first and
    // noticing nothing failed.
    const short = renderHook(() => useConnectionPolicy(4, [1_000, 5_000], 6)).result;
    expect(short.current.takeRetryDelay()).toBe(1_000);
    expect(short.current.takeRetryDelay()).toBe(5_000);
    expect(short.current.takeRetryDelay(), "past the table, hold the last interval").toBe(5_000);
    expect(short.current.takeRetryDelay()).toBe(5_000);
  });
});

describe("useConnectionPolicy — the attempts-since-live ceiling", () => {
  it("allows attempts up to the ceiling and refuses the one past it", () => {
    const p = policy();
    for (let i = 1; i <= MAX_WITHOUT_LIVE; i++) {
      expect(p.current.countAttempt(), `attempt ${i} must be allowed`).toBe(true);
    }
    expect(p.current.countAttempt(), "the ceiling is the backstop against retrying for ever").toBe(false);
  });

  it("a live session clears it, whatever it took to get there", () => {
    const p = policy();
    for (let i = 0; i < MAX_WITHOUT_LIVE; i++) p.current.countAttempt();
    p.current.noteLive();
    expect(p.current.countAttempt()).toBe(true);
  });

  it("is NOT cleared by restoring the per-drop budget — the whole point of having two", () => {
    // A media-mode rebuild resets the drop budget on purpose. If it also reset this, a link forcing
    // switch after switch could retry for ever and never surface a terminal error.
    const p = policy();
    for (let i = 0; i < MAX_WITHOUT_LIVE; i++) p.current.countAttempt();
    p.current.resetDropBudget();
    expect(p.current.countAttempt(), "the ceiling must survive a switch").toBe(false);
  });

  it("sits above a full drop exhaustion plus a couple of honest switches", () => {
    // Sizing check: one drop can legitimately consume 1 + maxDropRetries attempts, and a real switch
    // adds one. An honest flow must not trip the ceiling.
    const p = policy();
    const honest = 1 + MAX_RETRIES + 1;
    for (let i = 0; i < honest; i++) {
      expect(p.current.countAttempt(), `an honest flow's attempt ${i + 1} must be allowed`).toBe(true);
    }
  });
});

describe("useConnectionPolicy — the terminal latch", () => {
  it("latches and reports", () => {
    const p = policy();
    expect(p.current.isFatal()).toBe(false);
    p.current.latchFatal();
    expect(p.current.isFatal()).toBe(true);
  });

  it("a fresh connect clears it, so a new session is not born terminal", () => {
    const p = policy();
    p.current.latchFatal();
    p.current.resetDropBudget();
    expect(p.current.isFatal()).toBe(false);
  });

  it("the ceiling's refusal does not clear it", () => {
    const p = policy();
    p.current.latchFatal();
    p.current.countAttempt();
    expect(p.current.isFatal()).toBe(true);
  });
});

describe("useConnectionPolicy — intentional close", () => {
  it("marks and reports, so our own close is not retried", () => {
    const p = policy();
    expect(p.current.wasIntentionalClose()).toBe(false);
    p.current.markIntentionalClose();
    expect(p.current.wasIntentionalClose()).toBe(true);
  });

  it("clearing it arms the drop detection again", () => {
    const p = policy();
    p.current.markIntentionalClose();
    p.current.clearIntentionalClose();
    expect(p.current.wasIntentionalClose()).toBe(false);
  });

  it("is independent of the terminal latch", () => {
    const p = policy();
    p.current.markIntentionalClose();
    expect(p.current.isFatal(), "closing deliberately is not a failure").toBe(false);
  });
});

describe("useConnectionPolicy — teardown", () => {
  it("clears every counter, latch and claim", async () => {
    const p = policy();
    // The ceiling must be EXHAUSTED before the reset, or this cannot tell whether reset cleared it: one
    // counted attempt still leaves the next one under the ceiling either way. Found by mutating the
    // reset's clear away and noticing nothing failed.
    for (let i = 0; i < MAX_WITHOUT_LIVE; i++) p.current.countAttempt();
    p.current.takeRetryDelay();
    p.current.latchFatal();
    p.current.markIntentionalClose();
    const tracked = p.current.track(new Promise<void>(() => undefined));
    void tracked;
    p.current.reset();
    expect(p.current.inFlight(false)).toBeNull();
    expect(p.current.isRetrying()).toBe(false);
    expect(p.current.isFatal()).toBe(false);
    expect(p.current.wasIntentionalClose()).toBe(false);
    expect(p.current.countAttempt()).toBe(true);
  });
});

describe("useConnectionPolicy — handle stability", () => {
  it("returns the same object across renders", () => {
    const { result, rerender } = renderHook(() =>
      useConnectionPolicy(MAX_RETRIES, DELAYS, MAX_WITHOUT_LIVE),
    );
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
