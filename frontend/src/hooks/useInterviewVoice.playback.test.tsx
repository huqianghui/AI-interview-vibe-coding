/**
 * The wiring between Azure's audio events and the playback jitter buffer (perf review P0-2).
 *
 * One of these two assertions is the whole reason the underrun counter means anything. The worklet
 * cannot tell a finished sentence from a stalled network — both empty its queue — so if
 * `response.audio.done` ever stops reaching it, the metric silently goes back to firing once per
 * utterance and the buffer looks broken when it is fine.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

vi.mock("./useAvatarStream", () => ({
  useAvatarStream: () => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    handleServerSdp: vi.fn(),
    isConnected: false,
    isMediaReady: false,
    mediaMode: "video" as const,
    videoPreference: "auto" as const,
    setVideoPreference: vi.fn(),
    canEnableVideo: true,
    videoEnableAtMs: null,
  }),
}));

const audio = {
  playAudio: vi.fn(),
  endPlaybackStream: vi.fn(),
  stopAudio: vi.fn(),
  flushPlayback: vi.fn(),
};
vi.mock("./useVoiceAudio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useVoiceAudio")>()),
  useVoiceAudio: () => ({
    initMic: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    setMicEnabled: vi.fn(),
    cleanupMic: vi.fn(),
    getPlaybackStats: () => ({ underruns: 0, bufferedMs: 0, state: "filling" as const }),
    prepareAudioContext: vi.fn(),
    ...audio,
  }),
}));

import { useInterviewVoice } from "./useInterviewVoice";
import { MIC_SAMPLE_RATE } from "./useVoiceAudio";

class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = 1;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.last = this;
    setTimeout(() => this.onopen?.(), 0);
  }
  send(d: unknown) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

async function connected() {
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  FakeWebSocket.last = null;
  let hook!: ReturnType<typeof useInterviewVoice>;
  function Harness() {
    hook = useInterviewVoice("iv-1", { locale: "en-US", tokenProvider: () => "tok" });
    return null;
  }
  const { unmount } = render(<Harness />);
  act(() => {
    hook.connect("en-US").catch(() => undefined);
  });
  await act(async () => {
    for (let i = 0; i < 20 && !FakeWebSocket.last; i++) await Promise.resolve();
    FakeWebSocket.last!.receive({
      type: "proxy.connected",
      avatar_enabled: false,
      input_audio_sampling_rate: MIC_SAMPLE_RATE,
    });
    FakeWebSocket.last!.receive({ type: "session.updated", session: {} });
  });
  return { ws: FakeWebSocket.last!, unmount };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const fn of Object.values(audio)) fn.mockClear();
});

describe("interviewer audio → jitter buffer", () => {
  it("hands every audio delta to the buffer, verbatim", async () => {
    const { ws, unmount } = await connected();
    act(() => ws.receive({ type: "response.audio.delta", delta: "QUJDRA==" }));
    expect(audio.playAudio).toHaveBeenCalledWith("QUJDRA==");
    unmount();
  });

  it("marks the end of the stream on response.audio.done", async () => {
    const { ws, unmount } = await connected();
    act(() => ws.receive({ type: "response.audio.done" }));
    expect(audio.endPlaybackStream).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("marks it once per response, not once per delta", async () => {
    const { ws, unmount } = await connected();
    act(() => {
      ws.receive({ type: "response.audio.delta", delta: "AAA=" });
      ws.receive({ type: "response.audio.delta", delta: "AAB=" });
      ws.receive({ type: "response.audio.done" });
    });
    expect(audio.playAudio).toHaveBeenCalledTimes(2);
    expect(audio.endPlaybackStream).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("ignores an empty delta rather than queueing nothing", async () => {
    const { ws, unmount } = await connected();
    act(() => ws.receive({ type: "response.audio.delta", delta: "" }));
    expect(audio.playAudio).not.toHaveBeenCalled();
    unmount();
  });
});
