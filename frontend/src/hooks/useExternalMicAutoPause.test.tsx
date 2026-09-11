/**
 * Regression guard for issue2 — the mute button reverting to "unmute" in external voice mode.
 *
 * The candidate's own Mute click was being clobbered: the external mic auto-pause effect depended
 * on the voice object (a fresh identity every render), so it re-ran on every render and re-asserted
 * `setMuted(shouldPause)`. During an open turn `shouldPause` is false, so each unrelated re-render
 * fired `setMuted(false)` and flipped the manual mute straight back off.
 *
 * These tests drive the extracted hook and assert:
 *   1. An unrelated re-render (inputs unchanged) does NOT call setMuted again — the manual mute sticks.
 *   2. It still pauses on the turn-close transition and unpauses when the turn reopens.
 *   3. It stays fully inert while inactive (bank mode / text channel / disconnected).
 */
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { useExternalMicAutoPause } from "./useExternalMicAutoPause";

describe("useExternalMicAutoPause", () => {
  it("does not re-assert mute on an unrelated re-render (issue2: manual Mute must stick)", () => {
    const setMuted = vi.fn();
    // Open external voice turn: active, nothing forcing a pause.
    const { rerender } = renderHook(
      ({ active, shouldPause }) =>
        useExternalMicAutoPause(setMuted, { active, shouldPause }),
      { initialProps: { active: true, shouldPause: false } },
    );
    // Initial render: shouldPause matches the ref's initial false → the hook must not drive the mic.
    expect(setMuted).not.toHaveBeenCalled();

    // The candidate clicks Mute themselves; page state elsewhere flips and re-renders the tree, but
    // the auto-pause inputs are unchanged. The old code re-fired setMuted(false) here, unmuting them.
    rerender({ active: true, shouldPause: false });
    rerender({ active: true, shouldPause: false });
    expect(setMuted).not.toHaveBeenCalled();
  });

  it("pauses on the turn-close transition and unpauses when it reopens", () => {
    const setMuted = vi.fn();
    const { rerender } = renderHook(
      ({ active, shouldPause }) =>
        useExternalMicAutoPause(setMuted, { active, shouldPause }),
      { initialProps: { active: true, shouldPause: false } },
    );
    expect(setMuted).not.toHaveBeenCalled();

    // Turn closes (backend producing the next question / awaiting) → pause once.
    rerender({ active: true, shouldPause: true });
    expect(setMuted).toHaveBeenCalledTimes(1);
    expect(setMuted).toHaveBeenLastCalledWith(true);

    // Still paused: an extra re-render must not re-fire (idempotent, no reconnect storm).
    rerender({ active: true, shouldPause: true });
    expect(setMuted).toHaveBeenCalledTimes(1);

    // Turn reopens → unpause once.
    rerender({ active: true, shouldPause: false });
    expect(setMuted).toHaveBeenCalledTimes(2);
    expect(setMuted).toHaveBeenLastCalledWith(false);
  });

  it("stays inert while inactive (bank mode / text channel / disconnected)", () => {
    const setMuted = vi.fn();
    const { rerender } = renderHook(
      ({ active, shouldPause }) =>
        useExternalMicAutoPause(setMuted, { active, shouldPause }),
      { initialProps: { active: false, shouldPause: true } },
    );
    rerender({ active: false, shouldPause: false });
    rerender({ active: false, shouldPause: true });
    expect(setMuted).not.toHaveBeenCalled();
  });

  it("re-pauses cleanly after going inactive then active again", () => {
    const setMuted = vi.fn();
    const { rerender } = renderHook(
      ({ active, shouldPause }) =>
        useExternalMicAutoPause(setMuted, { active, shouldPause }),
      { initialProps: { active: true, shouldPause: true } },
    );
    // Active + should-pause on mount → pause once.
    expect(setMuted).toHaveBeenCalledTimes(1);
    expect(setMuted).toHaveBeenLastCalledWith(true);

    // Connection drops (inactive) — the ref is cleared so a later re-activation is a fresh transition.
    rerender({ active: false, shouldPause: true });
    // Reconnects while still needing a pause → drives the mic again.
    rerender({ active: true, shouldPause: true });
    expect(setMuted).toHaveBeenCalledTimes(2);
    expect(setMuted).toHaveBeenLastCalledWith(true);
  });
});
