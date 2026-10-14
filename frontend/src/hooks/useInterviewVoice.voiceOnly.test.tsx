/**
 * The voice hook's half of voice-only (no avatar session — the interviewer's voice over the WebSocket)
 * and of Azure's avatar rate-limit refusal.
 *
 *   - A session the media hook wants voice-only opens with `avatar=off`, which the backend turns into a
 *     session with no avatar block (the fallback for a network that cannot carry the avatar's WebRTC).
 *   - A mode change while no session is open is remembered, not acted on: it must not open a session.
 *   - Azure refusing to CREATE a session over the avatar allowance (`rate_limit_exceeded`, "Retry after
 *     Ns") used to be fatal — the page fell back to text. Now a short wait is waited out and retried
 *     with the digital human; a long one, or a second refusal, opens the session voice-only.
 *
 * `useAvatarStream` is mocked with a bridge the test drives, the same way
 * `useInterviewVoice.restartForMediaMode.test.tsx` does.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, act } from "@testing-library/react";

const avatarBridge: {
  onModeSwitchRequest: ((next: "video" | "audio-only" | "voice-only") => void) | null;
  wantsAvatar: boolean;
  fallBackToVoiceOnly: ReturnType<typeof vi.fn>;
  retryAvatarAfterFallback: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
} = {
  onModeSwitchRequest: null,
  wantsAvatar: true,
  fallBackToVoiceOnly: vi.fn(),
  retryAvatarAfterFallback: vi.fn(),
  connect: vi.fn(),
};

vi.mock("./useAvatarStream", () => ({
  useAvatarStream: (
    _ref: unknown,
    options?: { onModeSwitchRequest?: (next: "video" | "audio-only" | "voice-only") => void },
  ) => {
    avatarBridge.onModeSwitchRequest = options?.onModeSwitchRequest ?? null;
    return {
      connect: avatarBridge.connect,
      wantsAvatar: () => avatarBridge.wantsAvatar,
      fallBackToVoiceOnly: () => {
        avatarBridge.fallBackToVoiceOnly();
        avatarBridge.wantsAvatar = false;
      },
      retryAvatarAfterFallback: avatarBridge.retryAvatarAfterFallback,
      disconnect: vi.fn(),
      handleServerSdp: vi.fn(),
      isConnected: false,
      isMediaReady: false,
      mediaMode: "video" as const,
      videoPreference: "auto" as const,
      setVideoPreference: vi.fn(),
      canEnableVideo: true,
    };
  },
}));

vi.mock("./useVoiceAudio", () => ({
  MIC_SAMPLE_RATE: 16_000,
  AZURE_DEFAULT_INPUT_SAMPLE_RATE: 24_000,
  useVoiceAudio: () => ({
    initMic: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    setMicEnabled: vi.fn(),
    cleanupMic: vi.fn(),
    playAudio: vi.fn(),
    stopAudio: vi.fn(),
    prepareAudioContext: vi.fn(),
  }),
}));

import { avatarRateLimitRetryMs, useInterviewVoice } from "./useInterviewVoice";

afterEach(() => {
  avatarBridge.onModeSwitchRequest = null;
  avatarBridge.wantsAvatar = true;
  avatarBridge.fallBackToVoiceOnly.mockClear();
  avatarBridge.retryAvatarAfterFallback.mockClear();
  avatarBridge.connect.mockClear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = 1;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
    setTimeout(() => this.onclose?.(), 0);
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  get avatarOff() {
    return new URL(this.url, "http://localhost").searchParams.get("avatar") === "off";
  }
}

const RATE_LIMITED = (seconds: number) => ({
  type: "error",
  error: {
    code: "rate_limit_exceeded",
    type: "invalid_request_error",
    message: `Avatar request was rate-limited. Retry after ${seconds}.0s.`,
  },
});

function harness() {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  let hook!: ReturnType<typeof useInterviewVoice>;
  function Harness() {
    hook = useInterviewVoice("iv-1", { locale: "en-US", tokenProvider: () => "tok" });
    return null;
  }
  const { unmount } = render(<Harness />);
  return { getHook: () => hook, unmount };
}

/** Let the connect reach the point where its socket exists. */
async function socket(n: number) {
  await act(async () => {
    for (let i = 0; i < 40 && FakeWebSocket.instances.length < n; i++) await Promise.resolve();
  });
  return FakeWebSocket.instances[n - 1];
}

describe("avatarRateLimitRetryMs", () => {
  it("reads Azure's Retry after, and only for the avatar rate limit", () => {
    expect(avatarRateLimitRetryMs(RATE_LIMITED(32).error)).toBe(32_000);
    expect(
      avatarRateLimitRetryMs({ code: "rate_limit_exceeded", message: "Avatar request was rate-limited." }),
      "no figure: assume a whole window",
    ).toBe(60_000);
    expect(avatarRateLimitRetryMs({ code: "rate_limit_exceeded", message: "Too many tokens." })).toBeNull();
    expect(avatarRateLimitRetryMs({ code: "invalid_model", message: "Avatar request failed" })).toBeNull();
    expect(avatarRateLimitRetryMs(undefined)).toBeNull();
  });
});

describe("useInterviewVoice voice-only", () => {
  it("opens the session with avatar=off when the media hook wants voice-only", async () => {
    avatarBridge.wantsAvatar = false;
    const { getHook, unmount } = harness();
    act(() => {
      void getHook().connect("en-US").catch(() => undefined);
    });
    const ws = await socket(1);
    expect(ws.avatarOff).toBe(true);
    unmount();
  });

  it("opens it with the digital human otherwise", async () => {
    const { getHook, unmount } = harness();
    act(() => {
      void getHook().connect("en-US").catch(() => undefined);
    });
    expect((await socket(1)).avatarOff).toBe(false);
    unmount();
  });

  it("does not start an avatar handshake in a voice-only session, even if the backend sent one", async () => {
    // A backend that ignored avatar=off would hand us ice_servers; a handshake there could only fail.
    avatarBridge.wantsAvatar = false;
    const { getHook, unmount } = harness();
    act(() => {
      void getHook().connect("en-US").catch(() => undefined);
    });
    const ws = await socket(1);
    await act(async () => {
      ws.receive({
        type: "session.updated",
        session: { avatar: { ice_servers: [{ urls: ["turn:relay.example.com"] }] } },
      });
    });
    expect(avatarBridge.connect).not.toHaveBeenCalled();
    unmount();
  });

  it("gives the digital human another chance on a page-initiated connect, not on internal ones", async () => {
    const { getHook, unmount } = harness();
    act(() => {
      void getHook().connect("en-US").catch(() => undefined);
    });
    await socket(1);
    expect(avatarBridge.retryAvatarAfterFallback).toHaveBeenCalledTimes(1);
    avatarBridge.retryAvatarAfterFallback.mockClear();
    act(() => {
      avatarBridge.onModeSwitchRequest!("voice-only"); // an internal rebuild
    });
    await socket(2);
    expect(avatarBridge.retryAvatarAfterFallback).not.toHaveBeenCalled();
    unmount();
  });

  it("remembers a mode change made while no session is open, instead of opening one", async () => {
    const { unmount } = harness();
    act(() => {
      avatarBridge.onModeSwitchRequest!("voice-only");
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(FakeWebSocket.instances).toHaveLength(0);
    unmount();
  });
});

describe("useInterviewVoice fallback_reason context", () => {
  it("clears a previous fallback when a session with the digital human comes up", async () => {
    const { voiceMetrics } = await import("../telemetry/voiceTimeline");
    const clear = vi.spyOn(voiceMetrics, "clearFallback");
    const { getHook, unmount } = harness();
    clear.mockClear(); // the mount clears once for the new interview
    act(() => {
      void getHook().connect("en-US").catch(() => undefined);
    });
    const ws = await socket(1);
    await act(async () => {
      ws.receive({ type: "proxy.connected", avatar_enabled: true, mode: "model" });
    });
    expect(clear).toHaveBeenCalledTimes(1);
    clear.mockRestore();
    unmount();
  });
});

describe("useInterviewVoice avatar rate-limit refusal", () => {
  it("waits out a short Retry after and retries WITH the digital human, without failing the page", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    let hook!: ReturnType<typeof useInterviewVoice>;
    function Harness() {
      hook = useInterviewVoice("iv-1", { locale: "en-US", tokenProvider: () => "tok", onError });
      return null;
    }
    const { unmount } = render(<Harness />);
    let connected = false;
    act(() => {
      void hook.connect("en-US").then(() => (connected = true), () => undefined);
    });
    const first = await socket(1);
    await act(async () => {
      first.receive(RATE_LIMITED(5));
    });
    expect(hook.connectionState, "still connecting, not an error").toBe("connecting");
    expect(onError).not.toHaveBeenCalled();

    // Its close must not start the reconnect loop on top of the wait.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000); // past Retry after + margin
    });
    const second = await socket(2);
    expect(second.avatarOff, "retried with the digital human").toBe(false);
    await act(async () => {
      second.receive({ type: "session.updated", session: {} });
    });
    expect(connected).toBe(true);
    expect(avatarBridge.fallBackToVoiceOnly).not.toHaveBeenCalled();
    unmount();
  });

  it("lets a candidate who leaves and comes back during the wait get a session (no stale join)", async () => {
    vi.useFakeTimers();
    const { getHook, unmount } = harness();
    act(() => {
      void getHook().connect("en-US").catch(() => undefined);
    });
    await act(async () => {
      (await socket(1)).receive(RATE_LIMITED(10));
    });
    // Leave mid-wait, then come back well inside the 10 s.
    await act(async () => {
      await getHook().disconnect();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    act(() => {
      void getHook().connect("en-US").catch(() => undefined);
    });
    const fresh = await socket(2);
    expect(fresh, "a new session for the returning candidate, not a join of the dead wait").toBeDefined();
    await act(async () => {
      fresh.receive({ type: "session.updated", session: {} });
    });
    expect(getHook().connectionState).toBe("connected");
    // The cancelled wait must not open a session of its own later.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    unmount();
  });

  it("goes voice-only at once when Azure asks for a long wait", async () => {
    const { getHook, unmount } = harness();
    act(() => {
      void getHook().connect("en-US").catch(() => undefined);
    });
    const first = await socket(1);
    await act(async () => {
      first.receive(RATE_LIMITED(40));
    });
    const second = await socket(2);
    expect(avatarBridge.fallBackToVoiceOnly).toHaveBeenCalledTimes(1);
    expect(second.avatarOff, "40 s of silence at the start of an interview is worse").toBe(true);
    unmount();
  });

  it("goes voice-only when the retry is refused again", async () => {
    vi.useFakeTimers();
    const { getHook, unmount } = harness();
    act(() => {
      void getHook().connect("en-US").catch(() => undefined);
    });
    await act(async () => {
      (await socket(1)).receive(RATE_LIMITED(5));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    await act(async () => {
      (await socket(2)).receive(RATE_LIMITED(5));
    });
    const third = await socket(3);
    expect(avatarBridge.fallBackToVoiceOnly).toHaveBeenCalledTimes(1);
    expect(third.avatarOff).toBe(true);
    unmount();
  });
});
