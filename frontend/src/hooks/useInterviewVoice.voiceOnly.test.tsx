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
  onModeSwitchRequest:
    | ((next: "video" | "audio-only" | "voice-only", info?: { mediaNeverFlowed: boolean }) => void)
    | null;
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
    options?: {
      onModeSwitchRequest?: (next: "video" | "audio-only" | "voice-only", info?: { mediaNeverFlowed: boolean }) => void;
    },
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
  sent: string[] = [];
  send(data: string) {
    if (typeof data === "string") this.sent.push(data);
  }
  /** The texts of the question reads sent on this socket. */
  get reads() {
    return this.sent
      .map((raw) => {
        try {
          return JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((m) => m?.type === "response.create")
      .map((m) => JSON.stringify(m));
  }
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
  // The transcript panel the page keeps: one bubble per id, a later segment replacing an earlier one.
  const bubbles = new Map<string, { role: string; content: string }>();
  function Harness() {
    hook = useInterviewVoice("iv-1", {
      locale: "en-US",
      tokenProvider: () => "tok",
      onTranscript: (seg) => bubbles.set(seg.id, { role: seg.role, content: seg.content }),
    });
    return null;
  }
  const { unmount } = render(<Harness />);
  return { getHook: () => hook, unmount, bubbles };
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

describe("useInterviewVoice re-reads the question after falling back to voice-only", () => {
  /** A live session with the read directive (mouth mode), the way a real interview runs. */
  async function live(n: number) {
    const ws = await socket(n);
    await act(async () => {
      ws.receive({
        type: "proxy.connected",
        avatar_enabled: false,
        mode: "model",
        read_directive: "Read verbatim.",
        input_audio_sampling_rate: 16_000,
      });
      ws.receive({ type: "session.updated", session: {} });
    });
    return ws;
  }

  it("says the last question again on the voice-only session — the dead avatar session never played it", async () => {
    // Measured behind a secure-access client: the read gate elapsed and the question went into the
    // avatar session ~2 s before its ICE gave up, so the candidate saw the card and heard nothing.
    const { getHook, unmount, bubbles } = harness();
    act(() => {
      void getHook().connect("en-US").catch(() => undefined);
    });
    const first = await live(1);
    act(() => {
      getHook().speakQuestion("Describe your deployment safety habit.");
    });
    expect(first.reads.some((r) => r.includes("deployment safety habit"))).toBe(true);
    await act(async () => {
      // Confirmed the way the real dead session confirmed it: the transcript still arrives on the
      // WebSocket while the audio goes down the WebRTC connection that never carried anything.
      first.receive({ type: "response.created", response: { id: "r1" } });
      first.receive({
        type: "response.audio_transcript.done",
        response_id: "r1",
        item_id: "a1",
        transcript: "Describe your deployment safety habit.",
      });
      first.receive({ type: "response.done", response: { id: "r1" } });
    });

    act(() => {
      avatarBridge.onModeSwitchRequest!("voice-only", { mediaNeverFlowed: true });
    });
    const second = await live(2);
    expect(second.reads.some((r) => r.includes("deployment safety habit")), "re-read on the new session").toBe(true);

    // The re-read's own transcript arrives under a NEW response id; it must land in the same bubble.
    await act(async () => {
      second.receive({ type: "response.created", response: { id: "r2" } });
      second.receive({ type: "response.audio_transcript.delta", response_id: "r2", item_id: "a2", delta: "Describe your" });
      second.receive({
        type: "response.audio_transcript.done",
        response_id: "r2",
        item_id: "a2",
        transcript: "Describe your deployment safety habit.",
      });
      second.receive({ type: "response.done", response: { id: "r2" } });
    });
    const shown = [...bubbles.values()].filter((b) => b.role === "assistant" && b.content.includes("deployment safety habit"));
    expect(shown, "heard once, shown once (owner, live behind a secure-access client)").toHaveLength(1);

    // The NEXT question gets a bubble of its own — the reuse ended with the re-read.
    act(() => {
      getHook().speakQuestion("How do you roll back a bad release?");
    });
    await act(async () => {
      second.receive({ type: "response.created", response: { id: "r3" } });
      second.receive({
        type: "response.audio_transcript.done",
        response_id: "r3",
        item_id: "a3",
        transcript: "How do you roll back a bad release?",
      });
      second.receive({ type: "response.done", response: { id: "r3" } });
    });
    const texts = [...bubbles.values()].filter((b) => b.role === "assistant").map((b) => b.content);
    expect(texts, "question 1 is still on screen, and question 2 beside it").toEqual([
      "Describe your deployment safety habit.",
      "How do you roll back a bad release?",
    ]);
    unmount();
  });

  /** Read question 1 on a live session and have the dead avatar session "deliver" it. */
  async function readQ1(getHook: () => ReturnType<typeof useInterviewVoice>) {
    act(() => {
      void getHook().connect("en-US").catch(() => undefined);
    });
    const first = await live(1);
    act(() => {
      getHook().speakQuestion("Describe your deployment safety habit.");
    });
    await act(async () => {
      first.receive({ type: "response.created", response: { id: "r1" } });
      first.receive({
        type: "response.audio_transcript.done",
        response_id: "r1",
        item_id: "a1",
        transcript: "Describe your deployment safety habit.",
      });
      first.receive({ type: "response.done", response: { id: "r1" } });
    });
    return first;
  }

  it("never lets a later read overwrite the old bubble, even when the re-read did not finish", async () => {
    // Review P2: the reuse used to outlive a re-read that never reached transcript.done.
    const { getHook, unmount, bubbles } = harness();
    await readQ1(getHook);
    act(() => {
      avatarBridge.onModeSwitchRequest!("voice-only", { mediaNeverFlowed: true });
    });
    const second = await live(2);
    await act(async () => {
      second.receive({ type: "response.created", response: { id: "r2" } });
      second.receive({ type: "response.audio_transcript.delta", response_id: "r2", item_id: "a2", delta: "Describe" });
    });
    act(() => {
      void getHook().commitAnswer().catch(() => undefined);
    });
    act(() => {
      getHook().speakQuestion("How do you roll back a bad release?");
    });
    await act(async () => {
      second.receive({ type: "response.created", response: { id: "r3" } });
      second.receive({
        type: "response.audio_transcript.done",
        response_id: "r3",
        item_id: "a3",
        transcript: "How do you roll back a bad release?",
      });
    });
    const texts = [...bubbles.values()].filter((b) => b.role === "assistant").map((b) => b.content);
    expect(texts.some((t) => t.includes("deployment safety habit") || t === "Describe"), "question 1's bubble survives").toBe(true);
    expect(texts).toContain("How do you roll back a bad release?");
    unmount();
  });

  it("does not repeat it when the avatar's media HAD flowed — the candidate may have heard it", async () => {
    const { getHook, unmount } = harness();
    await readQ1(getHook);
    act(() => {
      avatarBridge.onModeSwitchRequest!("voice-only", { mediaNeverFlowed: false });
    });
    const second = await live(2);
    expect(second.reads.some((r) => r.includes("deployment safety habit"))).toBe(false);
    unmount();
  });

  it("does not repeat it once the candidate started speaking, even before any transcript", async () => {
    const { getHook, unmount } = harness();
    const first = await readQ1(getHook);
    await act(async () => {
      first.receive({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    });
    act(() => {
      avatarBridge.onModeSwitchRequest!("voice-only", { mediaNeverFlowed: true });
    });
    const second = await live(2);
    expect(second.reads.some((r) => r.includes("deployment safety habit"))).toBe(false);
    unmount();
  });

  it("does not repeat a question already answered", async () => {
    const { getHook, unmount } = harness();
    await readQ1(getHook);
    act(() => {
      void getHook().commitAnswer().catch(() => undefined);
    });
    act(() => {
      avatarBridge.onModeSwitchRequest!("voice-only", { mediaNeverFlowed: true });
    });
    const second = await live(2);
    expect(second.reads.some((r) => r.includes("deployment safety habit"))).toBe(false);
    unmount();
  });

  it("does not repeat the question once the candidate has started answering it", async () => {
    const { getHook, unmount } = harness();
    act(() => {
      void getHook().connect("en-US").catch(() => undefined);
    });
    const first = await live(1);
    act(() => {
      getHook().speakQuestion("Describe your deployment safety habit.");
    });
    await act(async () => {
      // Confirmed the way the real dead session confirmed it: the transcript still arrives on the
      // WebSocket while the audio goes down the WebRTC connection that never carried anything.
      first.receive({ type: "response.created", response: { id: "r1" } });
      first.receive({
        type: "response.audio_transcript.done",
        response_id: "r1",
        item_id: "a1",
        transcript: "Describe your deployment safety habit.",
      });
      first.receive({ type: "response.done", response: { id: "r1" } });
      first.receive({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "u1",
        transcript: "I always run a canary first.",
      });
    });

    act(() => {
      avatarBridge.onModeSwitchRequest!("voice-only", { mediaNeverFlowed: true });
    });
    const second = await live(2);
    expect(second.reads.some((r) => r.includes("deployment safety habit"))).toBe(false);
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
