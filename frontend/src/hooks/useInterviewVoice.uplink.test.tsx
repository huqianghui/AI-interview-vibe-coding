/**
 * What the microphone actually puts on the wire (perf review P0-1).
 *
 * This file exists because the whole suite stayed green through a change that altered the uplink
 * callback's TYPE — base64 string to raw ArrayBuffer. The shared harness stubs `startRecording`
 * with a bare `vi.fn()`, so no test had ever invoked the callback and nothing asserted what gets
 * sent. A silently dead microphone is the worst failure this app has: the candidate talks, sees
 * nothing, and the session scores them on an empty transcript.
 *
 * The negotiation matters as much as the framing. Frontend and backend are separate container apps
 * that roll out independently, so a new page genuinely can meet a backend one revision behind,
 * whose relay rejects a binary frame outright.
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

/** Captures the uplink callback the hook registers, so the test can drive one mic batch through it. */
const mic: { onFrame?: (pcm: ArrayBuffer) => void } = {};
vi.mock("./useVoiceAudio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useVoiceAudio")>()),
  useVoiceAudio: () => ({
    initMic: vi.fn(),
    startRecording: (cb: (pcm: ArrayBuffer) => void) => {
      mic.onFrame = cb;
    },
    stopRecording: vi.fn(),
    setMicEnabled: vi.fn(),
    cleanupMic: vi.fn(),
    playAudio: vi.fn(),
    stopAudio: vi.fn(),
    prepareAudioContext: vi.fn(),
  }),
}));

import { useInterviewVoice } from "./useInterviewVoice";
import { MIC_SAMPLE_RATE, encodePcmToBase64 } from "./useVoiceAudio";

class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  // The hook gates every send on `readyState === WebSocket.OPEN`, and `WebSocket` IS this class
  // once stubbed — so without these statics the comparison is `1 === undefined` and the test
  // observes a socket that silently sends nothing. That is also why the two negative tests below
  // assert a positive control: they would otherwise pass against a completely mute transport.
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
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
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

/** A 40 ms batch of recognisable Int16 PCM — the exact shape the worklet transfers. */
function batch(): ArrayBuffer {
  const pcm = new Int16Array(640);
  for (let i = 0; i < pcm.length; i++) pcm[i] = (i * 37) % 3000;
  return pcm.buffer;
}

/** Connect, deliver `proxy.connected` with the given capability fields, and return the socket. */
async function connect(extra: Record<string, unknown>) {
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  FakeWebSocket.last = null;
  mic.onFrame = undefined;
  let hook!: ReturnType<typeof useInterviewVoice>;
  function Harness() {
    hook = useInterviewVoice("iv-1", {
      locale: "en-US",
      tokenProvider: () => "tok",
    });
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
      ...extra,
    });
    FakeWebSocket.last!.receive({ type: "session.updated", session: {} });
  });
  // The uplink starts behind the mic-ready promise, so let that microtask chain drain.
  await act(async () => {
    for (let i = 0; i < 20 && !mic.onFrame; i++) await Promise.resolve();
  });
  return { ws: FakeWebSocket.last!, unmount, getHook: () => hook };
}

afterEach(() => vi.unstubAllGlobals());

describe("mic uplink framing", () => {
  it("sends the raw buffer as a BINARY frame when the backend advertises binary_audio", async () => {
    const { ws, unmount } = await connect({ binary_audio: true });
    const pcm = batch();
    expect(mic.onFrame).toBeTypeOf("function");
    act(() => mic.onFrame!(pcm));

    const audioFrames = ws.sent.filter((f) => f instanceof ArrayBuffer);
    expect(audioFrames).toEqual([pcm]);
    // Nothing base64 went up — the point of the change is that this hop carries no base64 at all.
    expect(
      ws.sent.filter(
        (f) => typeof f === "string" && f.includes("input_audio_buffer.append"),
      ),
    ).toHaveLength(0);
    unmount();
  });

  it("falls back to base64 JSON when the backend does NOT advertise it", async () => {
    // The rollback / version-skew case. An old relay calls receive_text() and a binary frame kills
    // it.
    const { ws, unmount } = await connect({});
    const pcm = batch();
    act(() => mic.onFrame!(pcm));

    expect(ws.sent.filter((f) => f instanceof ArrayBuffer)).toHaveLength(0);
    const appends = ws.sent.filter(
      (f): f is string =>
        typeof f === "string" && f.includes("input_audio_buffer.append"),
    );
    expect(appends).toHaveLength(1);
    expect(JSON.parse(appends[0])).toEqual({
      type: "input_audio_buffer.append",
      audio: encodePcmToBase64(pcm),
    });
    unmount();
  });

  it("treats binary_audio: false as the fallback, not as truthy presence", async () => {
    const { ws, unmount } = await connect({ binary_audio: false });
    act(() => mic.onFrame!(batch()));
    expect(ws.sent.filter((f) => f instanceof ArrayBuffer)).toHaveLength(0);
    // Positive control: it took the OTHER path, rather than dropping the batch entirely.
    expect(
      ws.sent.filter(
        (f) => typeof f === "string" && f.includes("input_audio_buffer.append"),
      ),
    ).toHaveLength(1);
    unmount();
  });

  it("sends nothing at all while muted, then resumes when unmuted — on either path", async () => {
    for (const extra of [{ binary_audio: true }, {}]) {
      const { ws, unmount, getHook } = await connect(extra);
      act(() => getHook().setMuted(true));
      const before = ws.sent.length;
      act(() => mic.onFrame!(batch()));
      expect(ws.sent.length).toBe(before);
      // Positive control, so a transport that sends NOTHING cannot pass this as "correctly muted".
      act(() => getHook().setMuted(false));
      act(() => mic.onFrame!(batch()));
      expect(ws.sent.length).toBe(before + 1);
      unmount();
    }
  });
});

describe("base64 encoding of a mic batch", () => {
  it("round-trips a full 40 ms batch byte-for-byte", async () => {
    // The chunked `String.fromCharCode.apply` replaced a per-character concat. A chunk-boundary bug
    // there would corrupt audio in a way that only shows up as a bad transcript.
    const pcm = new Int16Array(640);
    for (let i = 0; i < pcm.length; i++) pcm[i] = i * 51 - 16000;
    const b64 = encodePcmToBase64(pcm.buffer);
    const back = new Int16Array(
      Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer,
    );
    expect([...back]).toEqual([...pcm]);
  });

  it("round-trips a buffer LONGER than one encode chunk", async () => {
    // 8 KB chunking means a 10 KB buffer exercises the seam.
    const pcm = new Int16Array(6000);
    for (let i = 0; i < pcm.length; i++) pcm[i] = ((i * 7919) % 65536) - 32768;
    const back = new Int16Array(
      Uint8Array.from(atob(encodePcmToBase64(pcm.buffer)), (c) =>
        c.charCodeAt(0),
      ).buffer,
    );
    expect([...back]).toEqual([...pcm]);
  });

  it("handles the extremes without wrapping", async () => {
    const pcm = Int16Array.from([0, 32767, -32768, -1, 1]);
    const back = new Int16Array(
      Uint8Array.from(atob(encodePcmToBase64(pcm.buffer)), (c) =>
        c.charCodeAt(0),
      ).buffer,
    );
    expect([...back]).toEqual([0, 32767, -32768, -1, 1]);
  });
});

describe("recording marker", () => {
  it("tells the backend which question starts, as a marker it keeps from Azure", async () => {
    const { ws, unmount, getHook } = await connect({ binary_audio: true });
    act(() => getHook().markQuestion(2));
    const markers = ws.sent
      .filter((f): f is string => typeof f === "string")
      .map((f) => JSON.parse(f))
      .filter((e) => e.type === "x.recording.question");
    expect(markers).toEqual([{ type: "x.recording.question", question_index: 2 }]);
    unmount();
  });
});
