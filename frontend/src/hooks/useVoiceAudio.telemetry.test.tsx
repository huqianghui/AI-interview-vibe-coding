/**
 * On the voice-only path the candidate hears the interviewer the moment the playback worklet starts
 * rendering a response. The worklet posts `started` at that instant (audioPlaybackWorklet.test.ts);
 * this pins the hook's side of it: `started` becomes the turn's `first_audible`, and stats frames
 * keep working.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useVoiceAudio } from "./useVoiceAudio";
import { voiceMetrics } from "../telemetry/voiceTimeline";

class FakeNode {
  static last: FakeNode | null = null;
  port = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    postMessage: vi.fn(),
  };
  constructor() {
    FakeNode.last = this;
  }
  connect() {}
  disconnect() {}
}

class FakeContext {
  state = "running";
  destination = {};
  audioWorklet = { addModule: () => Promise.resolve() };
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

beforeEach(() => {
  FakeNode.last = null;
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("AudioWorkletNode", FakeNode);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("playback started → first_audible", () => {
  it("marks the turn's first audible sample on `started`, and still reads stats", async () => {
    const turn = vi.spyOn(voiceMetrics, "turn");
    const { result } = renderHook(() => useVoiceAudio());
    await act(async () => {
      result.current.playAudio("QUJDRA==");
      await Promise.resolve();
      await Promise.resolve();
    });
    const port = FakeNode.last!.port;

    act(() => port.onmessage?.({ data: { eventType: "started" } }));
    expect(turn).toHaveBeenCalledWith("first_audible");

    act(() =>
      port.onmessage?.({
        data: { eventType: "stats", underruns: 0, bufferedMs: 120, lastGapMs: 0, state: "playing" },
      }),
    );
    expect(result.current.getPlaybackStats()).toMatchObject({ bufferedMs: 120, state: "playing" });
    expect(turn).toHaveBeenCalledTimes(1);
  });
});
