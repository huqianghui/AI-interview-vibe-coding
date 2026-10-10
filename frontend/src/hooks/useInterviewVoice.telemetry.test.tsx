/**
 * Voice timings reach App Insights: real Azure events through the hook produce `voice.turn` and
 * `voice.setup` (voiceTimeline.ts unit-tests the rules; this pins the WIRING, which is the part that
 * can silently not land). And no text ever rides along.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { voiceMetrics } from "../telemetry/voiceTimeline";

const tracked: { name: string; m: Record<string, number>; p: Record<string, unknown> }[] = [];
const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const wsEnds: [number, boolean][] = [];
const unloadFlushes = { n: 0 };
const unloadingEnds: boolean[] = [];
vi.mock("../telemetry/appInsights", () => ({
  trackEvent: (name: string, m: Record<string, number>, p: Record<string, unknown>) =>
    tracked.push({ name, m, p }),
  // Like the real one: each socket's trace ends once, however many paths try to end it.
  beginWebSocketTrace: () => {
    let ended = false;
    let live = false;
    return {
      traceparent: TRACEPARENT,
      markLive: () => {
        live = true;
      },
      // Records what the real one reports as `success`: a live session AND a clean close.
      end: (code: number, clean: boolean, _reason?: string, unloading = false) => {
        if (!ended) {
          wsEnds.push([code, live && clean]);
          unloadingEnds.push(unloading);
        }
        ended = true;
      },
    };
  },
  flushForUnload: () => {
    unloadFlushes.n += 1;
  },
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
  wsEnds.length = 0;
  unloadingEnds.length = 0;
  unloadFlushes.n = 0;
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

  it("opens the voice socket inside the page's trace and records it when it closes", async () => {
    const { ws, unmount } = await connected();
    // The backend parents its voice.session span on this, so the two join in App Insights.
    expect(new URL(ws.url).searchParams.get("traceparent")).toBe(TRACEPARENT);
    unmount(); // closes the socket
    expect(wsEnds).toEqual([[1005, true]]);
  });

  it("an abnormal close is a failed socket, and the reconnect opens a new traced one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { ws, unmount } = await connected();
    act(() => (ws.onclose as ((e: unknown) => void) | null)?.({ code: 1006, reason: "" }));
    expect(wsEnds).toEqual([[1006, false]]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500); // the first reconnect backoff
    });
    const reconnected = FakeWebSocket.last!;
    expect(reconnected).not.toBe(ws);
    expect(new URL(reconnected.url).searchParams.get("traceparent")).toBe(TRACEPARENT);
    act(() => {
      reconnected.receive({ type: "proxy.connected", avatar_enabled: false, input_audio_sampling_rate: MIC_SAMPLE_RATE });
      reconnected.receive({ type: "session.updated", session: {} });
    });
    unmount();
    expect(wsEnds).toEqual([
      [1006, false],
      [1005, true],
    ]);
    vi.useRealTimers();
  });

  it("sends the turn's playback-gap counters with the turn", async () => {
    const { ws, unmount } = await connected();
    act(() => {
      ws.receive({ type: "response.created", response: { id: "r1" } });
    });
    voiceMetrics.count("playback_gaps");
    voiceMetrics.count("playback_gap_ms_total", 180);
    act(() => ws.receive({ type: "response.done" }));
    unmount();
    const turn = tracked.find((e) => e.name === "voice.turn");
    expect(turn!.m).toMatchObject({ playback_gaps: 1, playback_gap_ms_total: 180 });
  });

  it("a tab closed mid-interview reports its socket on pagehide, through the unload flush", async () => {
    const { unmount } = await connected();
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(wsEnds).toEqual([[1001, true]]);
    expect(unloadingEnds).toEqual([true]); // queued only, not sent the ordinary way
    expect(unloadFlushes.n).toBeGreaterThan(0);
    unmount();
    expect(wsEnds).toHaveLength(1); // the later close does not report it twice
  });
});

