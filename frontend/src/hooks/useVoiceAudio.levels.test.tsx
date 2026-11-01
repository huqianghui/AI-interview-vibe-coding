/**
 * The audio orb's level taps (SPEC F9): what `readAnalyser` makes of a signal, which graph each
 * source reads, and that a tap which cannot be made never costs the candidate their audio.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { ORB_BAND_COUNT } from "../components/audioOrbRender";
import { readAnalyser, useVoiceAudio } from "./useVoiceAudio";

/** An analyser whose time-domain signal is a constant `amplitude` and whose spectrum is flat at
 * `bin` (0..255). */
function fakeAnalyser(amplitude: number, bin: number, sampleRate = 24_000) {
  return {
    fftSize: 1024,
    frequencyBinCount: 512,
    context: { sampleRate },
    getFloatTimeDomainData: (out: Float32Array) => out.fill(amplitude),
    getByteFrequencyData: (out: Uint8Array) => out.fill(bin),
    connect: vi.fn(),
  };
}

describe("readAnalyser", () => {
  it("reads silence as zero", () => {
    const { level, bands } = readAnalyser(fakeAnalyser(0, 0) as unknown as AnalyserNode, 24_000);
    expect(level).toBe(0);
    expect(bands).toEqual([0, 0, 0, 0]);
  });

  it("maps speech-level RMS into the middle of the range and clips loud signals at one", () => {
    // -30 dBFS sits halfway between the -50 floor and the -10 ceiling.
    const mid = readAnalyser(fakeAnalyser(10 ** (-30 / 20), 0) as unknown as AnalyserNode, 24_000);
    expect(mid.level).toBeCloseTo(0.5, 5);
    const loud = readAnalyser(fakeAnalyser(1, 0) as unknown as AnalyserNode, 24_000);
    expect(loud.level).toBe(1);
  });

  it("reports exactly as many bands as the orb draws, each normalised to 0..1", () => {
    const { bands } = readAnalyser(fakeAnalyser(0.1, 255) as unknown as AnalyserNode, 16_000);
    expect(bands).toHaveLength(ORB_BAND_COUNT);
    for (const b of bands) expect(b).toBeCloseTo(1, 5);
  });

  it.each([16_000, 24_000])("puts a ~1 kHz tone in the 600-1400 Hz band only, at %i Hz", (rate) => {
    const analyser = {
      ...fakeAnalyser(0.1, 0, rate),
      getByteFrequencyData: (out: Uint8Array) => {
        out.fill(0);
        out[Math.round(1000 / (rate / 1024))] = 255;
      },
    };
    const { bands } = readAnalyser(analyser as unknown as AnalyserNode, rate);
    expect(bands[2]).toBeGreaterThan(0);
    expect([bands[0], bands[1], bands[3]]).toEqual([0, 0, 0]);
  });

  it("reads a non-finite sample as silence instead of passing NaN on", () => {
    const { level, bands } = readAnalyser(fakeAnalyser(NaN, 0) as unknown as AnalyserNode, 24_000);
    expect(level).toBe(0);
    for (const b of bands) expect(Number.isFinite(b)).toBe(true);
  });

  it("reuses its read buffers across frames rather than allocating new ones", () => {
    const seen: Float32Array[] = [];
    const analyser = {
      ...fakeAnalyser(0.1, 0),
      getFloatTimeDomainData: (out: Float32Array) => {
        seen.push(out);
        out.fill(0.1);
      },
    };
    readAnalyser(analyser as unknown as AnalyserNode, 24_000);
    readAnalyser(analyser as unknown as AnalyserNode, 24_000);
    expect(seen[0]).toBe(seen[1]);
  });
});

class FakeNode {
  static instances: FakeNode[] = [];
  port = { postMessage: vi.fn(), onmessage: null as ((e: { data: unknown }) => void) | null };
  connect = vi.fn();
  constructor() {
    FakeNode.instances.push(this);
  }
}

let analyserOk = true;
class FakeContext {
  sampleRate = 16_000;
  state = "running";
  destination = {};
  audioWorklet = { addModule: () => Promise.resolve() };
  createMediaStreamSource() {
    return { connect: vi.fn() };
  }
  createAnalyser() {
    if (!analyserOk) throw new Error("no analyser");
    return { ...fakeAnalyser(0.1, 128, this.sampleRate), context: this };
  }
  close() {
    return Promise.resolve();
  }
}

describe("useVoiceAudio.readAudioLevels", () => {
  beforeEach(() => {
    analyserOk = true;
    FakeNode.instances = [];
    vi.stubGlobal("AudioContext", FakeContext);
    vi.stubGlobal("AudioWorkletNode", FakeNode);
    const stream = { getTracks: () => [{ stop: vi.fn() }] };
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is null for a path that does not exist yet, and reads the mic once it does", async () => {
    const { result } = renderHook(() => useVoiceAudio());
    expect(result.current.readAudioLevels("mic")).toBeNull();
    expect(result.current.readAudioLevels("playback")).toBeNull();
    await act(async () => {
      await result.current.initMic();
    });
    expect(result.current.readAudioLevels("mic")?.level).toBeGreaterThan(0);
    expect(result.current.readAudioLevels("playback")).toBeNull();
    act(() => result.current.cleanupMic());
    expect(result.current.readAudioLevels("mic")).toBeNull();
  });

  it("reads the playback path once the jitter buffer exists", async () => {
    const { result } = renderHook(() => useVoiceAudio());
    await act(async () => {
      await result.current.prepareAudioContext();
    });
    expect(result.current.readAudioLevels("playback")?.level).toBeGreaterThan(0);
  });

  it("still captures the mic when the analyser cannot be made", async () => {
    analyserOk = false;
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const { result } = renderHook(() => useVoiceAudio());
    await act(async () => {
      await result.current.initMic();
    });
    const onFrame = vi.fn();
    act(() => result.current.startRecording(onFrame));
    const pcm = new ArrayBuffer(8);
    FakeNode.instances[0].port.onmessage?.({ data: { eventType: "audio", pcm } });
    expect(onFrame).toHaveBeenCalledWith(pcm);
    expect(result.current.readAudioLevels("mic")).toBeNull();
  });

  it("still plays the interviewer when the analyser cannot be made", async () => {
    analyserOk = false;
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { result } = renderHook(() => useVoiceAudio());
    await act(async () => {
      await result.current.prepareAudioContext();
    });
    act(() => result.current.playAudio(btoa("\x01\x02")));
    expect(FakeNode.instances[0].port.postMessage).toHaveBeenCalledWith(
      { pcm: expect.any(ArrayBuffer) },
      expect.any(Array),
    );
    expect(error, "a missing tap must not read as a failed playback worklet").not.toHaveBeenCalled();
    expect(result.current.readAudioLevels("playback")).toBeNull();
  });
});
