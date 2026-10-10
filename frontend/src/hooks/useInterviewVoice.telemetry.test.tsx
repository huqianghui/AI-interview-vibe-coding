/**
 * Voice timings reach App Insights: real Azure events through the hook produce `voice.turn` and
 * `voice.setup` (voiceTimeline.ts unit-tests the rules; this pins the WIRING, which is the part that
 * can silently not land). And no text ever rides along.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

const tracked: { name: string; m: Record<string, number>; p: Record<string, unknown> }[] = [];
vi.mock("../telemetry/appInsights", () => ({
  trackEvent: (name: string, m: Record<string, number>, p: Record<string, unknown>) =>
    tracked.push({ name, m, p }),
}));

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
  tracked.length = 0;
});

describe("voice timings → App Insights", () => {
  it("sends the turn's stages and the connection setup, carrying no text", async () => {
    const { ws, unmount } = await connected();
    act(() => {
      ws.receive({ type: "input_audio_buffer.speech_started" });
      ws.receive({ type: "input_audio_buffer.speech_stopped" });
      ws.receive({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "i1",
        transcript: "my secret answer",
      });
      ws.receive({ type: "response.created", response: { id: "r1" } });
      ws.receive({ type: "response.audio_transcript.delta", response_id: "r1", item_id: "a1", delta: "Next question" });
      ws.receive({ type: "response.audio.delta", delta: "QUJDRA==" });
      ws.receive({ type: "response.done" });
    });
    unmount(); // teardown sends whatever is still open

    const turn = tracked.find((e) => e.name === "voice.turn");
    expect(turn).toBeDefined();
    expect(Object.keys(turn!.m)).toEqual(
      expect.arrayContaining([
        "speaking_ms",
        "stt_ms",
        "created_to_first_text_ms",
        "created_to_first_audio_delta_ms",
        "response_ms",
      ]),
    );
    // Spoken but never submitted, so the response was an aside (a nudge), not the next question.
    expect(turn!.p).toMatchObject({ interview_id: "iv-1", audio_path: "ws", kind: "aside" });

    const setup = tracked.find((e) => e.name === "voice.setup");
    expect(setup).toBeDefined();
    expect(Object.keys(setup!.m)).toEqual(
      expect.arrayContaining(["proxy_connected_ms", "session_updated_ms"]),
    );

    const everything = JSON.stringify(tracked);
    expect(everything).not.toContain("secret");
    expect(everything).not.toContain("Next question");
  });

  it("labels an avatar session's events with the WebRTC audio path and linear turns", async () => {
    const { ws, unmount } = await connected();
    act(() => {
      ws.receive({ type: "proxy.connected", avatar_enabled: true, linear_turns: true, input_audio_sampling_rate: MIC_SAMPLE_RATE });
      ws.receive({ type: "response.created", response: { id: "r1" } });
      ws.receive({ type: "response.done" });
    });
    unmount();
    const turn = tracked.find((e) => e.name === "voice.turn");
    expect(turn!.p).toMatchObject({ avatar: true, linear_turns: true, audio_path: "webrtc", kind: "opening" });
  });
});
