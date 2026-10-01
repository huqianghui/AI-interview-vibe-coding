/**
 * Unit guard for `useFirstReadGate` — holding the opening question until it can be heard.
 *
 * The behaviour exists because the interviewer's audio rides the avatar's WebRTC track: reading before
 * that track flows clipped the question's first words, and the candidate heard it start mid-sentence.
 * Two earlier regressions shape these tests. Gating on painted frames instead of media readiness made
 * every audio-only session wait out the full timeout in silence. And a held read dropped at teardown
 * lost the question outright, because the page had already latched it as spoken.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { useFirstReadGate } from "./useFirstReadGate";

const GATE_MS = 6_000;

function gate() {
  return renderHook(() => useFirstReadGate(GATE_MS)).result;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useFirstReadGate — when to hold", () => {
  it("holds the first read while the avatar is enabled and not yet ready", () => {
    expect(gate().current.shouldHold(true)).toBe(true);
  });

  it("does not hold when the avatar is disabled — there is nothing to wait for", () => {
    expect(gate().current.shouldHold(false)).toBe(false);
  });

  it("does not hold once the avatar is ready", () => {
    const g = gate();
    g.current.noteAvatarReady(true);
    expect(g.current.shouldHold(true)).toBe(false);
  });

  it("never holds a LATER read, even if the avatar is somehow not ready again", () => {
    // Only the opening question is gated; every later one reads immediately, or a mid-interview
    // media drop would silence the next question for the whole timeout.
    const g = gate();
    g.current.markRead();
    expect(g.current.shouldHold(true)).toBe(false);
  });
});

describe("useFirstReadGate — releasing a held read", () => {
  it("returns the held text the moment the avatar becomes ready", () => {
    const g = gate();
    g.current.hold("Tell me about a time you led a rollout.", vi.fn());
    expect(g.current.noteAvatarReady(true)).toBe("Tell me about a time you led a rollout.");
  });

  it("returns nothing when readiness arrives with no read held", () => {
    expect(gate().current.noteAvatarReady(true)).toBeNull();
  });

  it("returns nothing while the avatar is still not ready", () => {
    const g = gate();
    g.current.hold("held question", vi.fn());
    expect(g.current.noteAvatarReady(false)).toBeNull();
  });

  it("releasing cancels the fallback, so the question is not read twice", () => {
    const g = gate();
    const onElapsed = vi.fn();
    g.current.hold("held question", onElapsed);
    expect(g.current.noteAvatarReady(true)).toBe("held question");
    vi.advanceTimersByTime(GATE_MS * 2);
    expect(onElapsed, "the bound must not fire after the read was already released").not.toHaveBeenCalled();
  });

  it("reads anyway when the bound elapses, so a stalled handshake is never silent forever", () => {
    const g = gate();
    const onElapsed = vi.fn();
    g.current.hold("held question", onElapsed);
    vi.advanceTimersByTime(GATE_MS - 1);
    expect(onElapsed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onElapsed).toHaveBeenCalledWith("held question");
  });

  it("the elapsed read is not gated a second time", () => {
    // The timeout marks the first read done BEFORE reading. Without that, the read it triggers would
    // find shouldHold still true and hold itself again — silence for another full bound.
    const g = gate();
    g.current.hold("held question", vi.fn());
    vi.advanceTimersByTime(GATE_MS);
    expect(g.current.shouldHold(true)).toBe(false);
  });

  it("latest wins: a newer question supersedes a held one, and only the newer is read", () => {
    const g = gate();
    const first = vi.fn();
    const second = vi.fn();
    g.current.hold("stale question", first);
    g.current.hold("current question", second);
    expect(g.current.noteAvatarReady(true)).toBe("current question");
    vi.advanceTimersByTime(GATE_MS * 2);
    expect(first, "the superseded hold's bound must be cancelled").not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });
});

describe("useFirstReadGate — markRead", () => {
  it("cancels a hold, so a read that proceeds does not also fire the bound", () => {
    const g = gate();
    const onElapsed = vi.fn();
    g.current.hold("held question", onElapsed);
    g.current.markRead();
    vi.advanceTimersByTime(GATE_MS * 2);
    expect(onElapsed).not.toHaveBeenCalled();
  });
});

describe("useFirstReadGate — reset at teardown", () => {
  it("returns the held text so the caller can stash it for the next session", () => {
    // Dropping it would lose the question: the page latched it as spoken and will not ask again.
    const g = gate();
    g.current.hold("question the candidate never heard", vi.fn());
    expect(g.current.reset()).toBe("question the candidate never heard");
  });

  it("returns null when nothing was held", () => {
    expect(gate().current.reset()).toBeNull();
  });

  it("cancels the bound, so a dead session cannot read into the next one", () => {
    const g = gate();
    const onElapsed = vi.fn();
    g.current.hold("held question", onElapsed);
    g.current.reset();
    vi.advanceTimersByTime(GATE_MS * 2);
    expect(onElapsed).not.toHaveBeenCalled();
  });

  it("re-arms the gate for the next session", () => {
    // A new session gates its own opening read, so both flags go back to their initial state.
    const g = gate();
    g.current.markRead();
    g.current.noteAvatarReady(true);
    g.current.reset();
    expect(g.current.shouldHold(true), "the next session's first read must be gated again").toBe(true);
  });

  it("leaves no timer behind", () => {
    const g = gate();
    const before = vi.getTimerCount();
    g.current.hold("held question", vi.fn());
    expect(vi.getTimerCount()).toBe(before + 1);
    g.current.reset();
    expect(vi.getTimerCount()).toBe(before);
  });
});

describe("useFirstReadGate — handle stability", () => {
  it("returns the same object across renders, so dependency arrays stay stable", () => {
    const { result, rerender } = renderHook(() => useFirstReadGate(GATE_MS));
    const first = result.current;
    rerender();
    rerender();
    expect(result.current).toBe(first);
  });
});
