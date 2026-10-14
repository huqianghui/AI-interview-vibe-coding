/**
 * A second `initMic()` (a connect retried after Azure refused the session over the avatar rate limit)
 * used to overwrite the capture refs and orphan the first MediaStream and AudioContext: the hardware
 * stayed captured, mic indicator on, until the tab closed (adversarial review, 2026-10-14).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useVoiceAudio } from "./useVoiceAudio";

class FakeContext {
  static instances: FakeContext[] = [];
  closed = false;
  audioWorklet = { addModule: () => Promise.resolve() };
  constructor() {
    FakeContext.instances.push(this);
  }
  createMediaStreamSource() {
    return { connect() {} };
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}
class FakeNode {
  port = { postMessage: vi.fn(), onmessage: null };
}

function fakeStream() {
  const track = { stop: vi.fn() };
  return { track, stream: { getTracks: () => [track] } as unknown as MediaStream };
}

beforeEach(() => {
  FakeContext.instances = [];
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("AudioWorkletNode", FakeNode);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useVoiceAudio initMic", () => {
  it("releases the previous capture before taking a new one", async () => {
    const first = fakeStream();
    const second = fakeStream();
    const getUserMedia = vi.fn().mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const { result } = renderHook(() => useVoiceAudio());

    await act(async () => {
      await result.current.initMic();
    });
    expect(first.track.stop).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.initMic();
    });
    expect(first.track.stop, "the first stream must not stay captured").toHaveBeenCalled();
    expect(FakeContext.instances[0].closed).toBe(true);
    expect(second.track.stop).not.toHaveBeenCalled();
  });
});
