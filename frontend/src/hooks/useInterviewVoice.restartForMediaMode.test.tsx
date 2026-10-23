/**
 * Coverage for `restartForMediaMode` (weak-network media adaptation, 2026-09-30).
 *
 * `useAvatarStream` is fully mocked module-wide in `useInterviewVoice.test.tsx`, and that mock
 * factory ignores its `options` argument entirely — so `onModeSwitchRequest` is never captured
 * there and the real `restartForMediaMode` implementation (the intentional-restart flag, the
 * WS handler-detach fix, the draft-preservation contract) is never exercised by that file.
 *
 * This is a SEPARATE test file (not an edit to the existing one) purely so it can install its own
 * `vi.mock("./useAvatarStream", ...)` that captures `onModeSwitchRequest` and lets a test invoke it
 * directly, the same way `useAvatarStream`'s real `switchMediaMode` would via
 * `onModeSwitchRequestRef.current?.(next)`.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, act } from "@testing-library/react";

const disconnectSpy = vi.fn();
const cleanupMicSpy = vi.fn();
const prepareAudioContextSpy = vi.fn();

/** Captures the `onModeSwitchRequest` callback the real hook wires into `useAvatarStream`, so a
 * test can call it directly — exactly like a weak-network downgrade or the manual toggle would. */
const avatarBridge: {
  onModeSwitchRequest: ((next: "video" | "audio-only") => void) | null;
} = { onModeSwitchRequest: null };

vi.mock("./useAvatarStream", () => ({
  useAvatarStream: (
    _ref: unknown,
    options?: { onModeSwitchRequest?: (next: "video" | "audio-only") => void },
  ) => {
    avatarBridge.onModeSwitchRequest = options?.onModeSwitchRequest ?? null;
    return {
      connect: vi.fn(),
      wantsAvatar: () => true,
      fallBackToVoiceOnly: vi.fn(),
      retryAvatarAfterFallback: vi.fn(),
      disconnect: disconnectSpy,
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
  useVoiceAudio: () => ({
    initMic: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    setMicEnabled: vi.fn(),
    cleanupMic: cleanupMicSpy,
    playAudio: vi.fn(),
    stopAudio: vi.fn(),
    prepareAudioContext: prepareAudioContextSpy,
  }),
}));

import { useInterviewVoice } from "./useInterviewVoice";

afterEach(() => {
  disconnectSpy.mockClear();
  cleanupMicSpy.mockClear();
  avatarBridge.onModeSwitchRequest = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A WS stand-in whose `close()` fires `onclose` on a LATER tick (`setTimeout(0)`), like a real
 * browser WebSocket — not inline like most of this suite's fakes. The handler-detach fix in
 * `restartForMediaMode` only matters if `onclose` can fire after `connect()` has already reset
 * `intentionalCloseRef`; an inline/synchronous fake can't observe that race at all. */
class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = 1;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeWebSocket.last = this;
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    setTimeout(() => this.onclose?.(), 0);
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

async function connectFor(opts: Record<string, unknown> = {}) {
  FakeWebSocket.last = null;
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  let hook!: ReturnType<typeof useInterviewVoice>;
  function Harness() {
    hook = useInterviewVoice("iv-1", {
      locale: "en-US",
      tokenProvider: () => "tok",
      ...opts,
    });
    return null;
  }
  const { unmount } = render(<Harness />);
  let connectP!: Promise<void>;
  act(() => {
    connectP = hook.connect("en-US");
  });
  await act(async () => {
    for (let i = 0; i < 20 && !FakeWebSocket.last; i++) await Promise.resolve();
    FakeWebSocket.last!.receive({ type: "session.updated", session: {} });
    await connectP;
  });
  return { getHook: () => hook, ws: () => FakeWebSocket.last!, unmount };
}

describe("useInterviewVoice restartForMediaMode", () => {
  it("wires onModeSwitchRequest through to useAvatarStream", async () => {
    const { unmount } = await connectFor();
    expect(avatarBridge.onModeSwitchRequest).toBeInstanceOf(Function);
    unmount();
  });

  it("rebuilds the session for a same-mode request — the avatar self-heal recovering a media drop", async () => {
    // Azure refuses a second `session.avatar.connect` on a live session (webrtc_connection_invalid), so
    // the self-heal asks for the mode it is ALREADY in. That must still open a new session, not be
    // mistaken for a no-op mode switch.
    vi.useFakeTimers();
    const { getHook, unmount } = await connectFor();
    const oldWs = FakeWebSocket.last!;

    act(() => {
      avatarBridge.onModeSwitchRequest!("video");
    });
    await act(async () => {
      for (let i = 0; i < 20 && FakeWebSocket.last === oldWs; i++) await Promise.resolve();
    });
    const freshWs = FakeWebSocket.last!;
    expect(freshWs).not.toBe(oldWs);
    expect(oldWs.readyState).toBe(3); // the old session is closed, not re-offered on
    await act(async () => {
      freshWs.receive({ type: "session.updated", session: {} });
    });
    expect(getHook().connectionState).toBe("connected");
    unmount();
  });

  it("detaches the old socket's handlers before closing it, and rebuilds exactly once", async () => {
    vi.useFakeTimers();
    const { getHook, unmount } = await connectFor();
    const oldWs = FakeWebSocket.last!;

    act(() => {
      avatarBridge.onModeSwitchRequest!("audio-only");
    });

    // Detached synchronously, before close() — the exact ordering the source comment calls out.
    expect(oldWs.onclose).toBeNull();
    expect(oldWs.onmessage).toBeNull();
    expect(oldWs.onerror).toBeNull();
    // Note: `restartForMediaMode` calls `setConn("reconnecting")` right here, but the very next
    // line (`connect(...)`) runs synchronously up to its own `setConn("connecting")` before this
    // test can observe anything in between — so "reconnecting" is never actually visible to the
    // UI for this path (InterviewPage.tsx renders different copy for the two states). Asserting
    // the state that is actually reachable rather than the one the source "intends" to show.
    expect(getHook().connectionState).toBe("connecting");

    // A fresh WS is opened for the rebuilt session.
    await act(async () => {
      for (let i = 0; i < 20 && FakeWebSocket.last === oldWs; i++) await Promise.resolve();
    });
    const freshWs = FakeWebSocket.last!;
    expect(freshWs).not.toBe(oldWs);
    await act(async () => {
      freshWs.receive({ type: "session.updated", session: {} });
    });
    expect(getHook().connectionState).toBe("connected");

    // The old socket's deferred close event (real-browser timing) must be a no-op: with the
    // handler nulled, it fires into nothing. If a regression removed the nulling, this old
    // handler would see `intentionalCloseRef` already reset by the new connect() and schedule a
    // SECOND reconnect — which would show up here as a third WebSocket instance.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500); // flushes the deferred close + any reconnect backoff
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(getHook().connectionState).toBe("connected");

    unmount();
  });

  // Correction to an earlier draft of this audit: `connect()` takes a THIRD parameter,
  // `keepDraft` (useInterviewVoice.ts, `connect(locale?, isReconnect = false, keepDraft = false)`),
  // and `restartForMediaMode` calls `connect(lastLocaleRef.current, false, true)` — so the
  // `if (!isReconnect) resetTurnState(keepDraft ? { keepDraft: true } : undefined)` branch DOES
  // receive `keepDraft: true` and does not wipe the draft a second time. There is no draft-loss
  // bug here; verified directly against this file's own mock harness (a transcript segment
  // survived a mode-switch rebuild with `peekDraft()` unchanged) before writing this note. The
  // feature author's own `useInterviewVoice.test.tsx` ("keeps the candidate's in-progress answer
  // across the rebuild", in the "media-mode session rebuild" describe block) already covers this
  // exact contract, so no duplicate test is added here.

  it("stops handing out fresh retries forever: enough switches without a live session ends in an error", async () => {
    // A mode rebuild resets the per-drop reconnect budget on purpose. The inverse, raised by the
    // v0.40.0.0 review: on a link bad enough to force switch after switch, that reset means the page
    // could retry indefinitely and never tell the candidate the voice is gone. The cross-switch
    // counter is the backstop. Here NO rebuilt session ever reaches `session.updated`.
    vi.useFakeTimers();
    const onError = vi.fn();
    const { getHook, unmount } = await connectFor({ onError });
    expect(getHook().connectionState).toBe("connected"); // one live session → counter cleared

    let switchesBeforeError = 0;
    for (let i = 0; i < 12 && onError.mock.calls.length === 0; i++) {
      await act(async () => {
        avatarBridge.onModeSwitchRequest!(i % 2 === 0 ? "audio-only" : "video");
        // Let the rebuilt connect() open its socket; deliberately never answer with session.updated.
        for (let k = 0; k < 20; k++) await Promise.resolve();
      });
      if (onError.mock.calls.length === 0) switchesBeforeError += 1;
    }

    expect(onError, "repeated switches on a dead link must eventually surface a terminal error").toHaveBeenCalled();
    expect((onError.mock.calls[0][0] as Error).message).toMatch(/without a live session/);
    expect(getHook().connectionState).toBe("error");
    // And it must not fire so early that an honest flow trips it: a single drop can legitimately
    // consume 1 + MAX_RECONNECT attempts, and a real switch adds one on top.
    expect(switchesBeforeError).toBeGreaterThanOrEqual(4);

    unmount();
  });


  it("a double-click opens ONE session, and a deliberate rebuild still opens a new one", async () => {
    // Both affordances that reach connect() are deliberately never disabled — the mic-permission
    // dialog's Retry and the top-bar voice pill, whose own comment says it must stay retryable. So two
    // clicks is not an adversarial scenario, it is a candidate being impatient. Before the guard, each
    // attempt overwrote wsRef and micReadyRef and orphaned the earlier socket with its handlers still
    // armed: the orphan could schedule its own reconnect and, if it still saw session.updated, run the
    // connected-state and avatar-handshake side effects through the same refs while send() pointed at
    // the other socket.
    //
    // The guard must NOT be a blanket "one connect at a time", which is why the second half of this
    // test matters: a media-mode rebuild legitimately needs a NEW session, and de-duplicating it would
    // silently drop the switch.
    FakeWebSocket.last = null;
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    let hook!: ReturnType<typeof useInterviewVoice>;
    function Harness() {
      hook = useInterviewVoice("iv-dbl", { locale: "en-US", tokenProvider: () => "tok" });
      return null;
    }
    const { unmount } = render(<Harness />);

    // Two clicks, back to back, before anything can answer.
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = hook.connect("en-US");
      second = hook.connect("en-US");
    });
    await act(async () => {
      for (let i = 0; i < 20 && !FakeWebSocket.last; i++) await Promise.resolve();
    });

    expect(
      FakeWebSocket.instances.length,
      "a second click must join the first attempt, not open a rival socket",
    ).toBe(1);

    // And both callers see the same outcome, because the second was handed the first's promise.
    await act(async () => {
      FakeWebSocket.last!.receive({ type: "session.updated", session: {} });
      await first;
      await second;
    });
    expect(hook.connectionState).toBe("connected");

    // Now the part the guard must not break: a deliberate rebuild opens a genuinely new session.
    act(() => {
      avatarBridge.onModeSwitchRequest!("audio-only");
    });
    await act(async () => {
      for (let i = 0; i < 20 && FakeWebSocket.instances.length < 2; i++) await Promise.resolve();
    });
    expect(
      FakeWebSocket.instances.length,
      "a media-mode rebuild is a supersession, not a duplicate — it must get its own socket",
    ).toBe(2);

    unmount();
  });

  // The watchdog (REBUILD_STALL_MS = 15 s): once, live, a rebuild never created its socket, so neither
  // the connect timeout nor the reconnect loop ran and the interview sat silent.
  it("retries a rebuild that is not live after 15 s, and gives up with an error after a second stall", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getHook, unmount } = await connectFor({ onError });
    const oldWs = FakeWebSocket.last!;

    act(() => {
      avatarBridge.onModeSwitchRequest!("video");
    });
    await act(async () => {
      for (let i = 0; i < 20 && FakeWebSocket.last === oldWs; i++) await Promise.resolve();
    });
    const stalled = FakeWebSocket.last!;
    expect(stalled).not.toBe(oldWs);

    // No session.updated on the rebuilt socket: at 15 s the watchdog replaces it once.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("retrying once"))).toBe(true);
    expect(stalled.onclose).toBeNull(); // detached, so its close cannot start the reconnect loop
    const retry = FakeWebSocket.last!;
    expect(retry).not.toBe(stalled);

    // The retry stalls too: an error the page can show, not a silent interview.
    cleanupMicSpy.mockClear();
    disconnectSpy.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("giving up"))).toBe(true);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "The voice connection could not be rebuilt" }),
    );
    expect(getHook().connectionState).toBe("error");
    // Giving up releases the mic and the avatar, as the reconnect loop's terminal path does.
    expect(cleanupMicSpy).toHaveBeenCalled();
    expect(disconnectSpy).toHaveBeenCalled();
    // The stalled attempt's own 30 s connect timeout fired at the same moment: superseded, it must
    // neither tear down the retry nor report a second, different error.
    expect(onError).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    unmount();
  });

  it("recovers a rebuild that never even created its socket (the live 2026-10-22 shape)", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getHook, unmount } = await connectFor();
    const oldWs = FakeWebSocket.last!;

    // The rebuild hangs before `new WebSocket` and never gets past it.
    prepareAudioContextSpy.mockReturnValueOnce(new Promise(() => {}));
    act(() => {
      avatarBridge.onModeSwitchRequest!("video");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_000);
    });
    expect(FakeWebSocket.last).toBe(oldWs); // no socket: the connect timeout never even started

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("retrying once"))).toBe(true);
    await act(async () => {
      for (let i = 0; i < 20 && FakeWebSocket.last === oldWs; i++) await Promise.resolve();
    });
    const retry = FakeWebSocket.last!;
    expect(retry).not.toBe(oldWs);
    await act(async () => {
      retry.receive({ type: "session.updated", session: {} });
    });
    expect(getHook().connectionState).toBe("connected");
    warn.mockRestore();
    unmount();
  });

  it("leaves a rebuild Azure refused for good alone, keeping Azure's own message", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { unmount } = await connectFor({ onError });
    const oldWs = FakeWebSocket.last!;

    act(() => {
      avatarBridge.onModeSwitchRequest!("video");
    });
    await act(async () => {
      for (let i = 0; i < 20 && FakeWebSocket.last === oldWs; i++) await Promise.resolve();
      FakeWebSocket.last!.receive({
        type: "error",
        error: { code: "invalid_model", message: "The model is not supported in this region." },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("not live after"))).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "The model is not supported in this region." }),
    );
    warn.mockRestore();
    unmount();
  });

  /** A rebuild Azure refuses over the avatar allowance, asking for a wait just past the watchdog's 15 s
   * (14.8 s + the hook's 0.5 s margin = 15.3 s), so the watchdog fires DURING the deliberate wait. */
  async function rebuildRefusedByRateLimit() {
    const { getHook, unmount } = await connectFor();
    const oldWs = FakeWebSocket.last!;
    act(() => {
      avatarBridge.onModeSwitchRequest!("video");
    });
    await act(async () => {
      for (let i = 0; i < 20 && FakeWebSocket.last === oldWs; i++) await Promise.resolve();
      FakeWebSocket.last!.receive({
        type: "error",
        error: {
          code: "rate_limit_exceeded",
          message: "Avatar request was rate-limited. Retry after 14.8s.",
        },
      });
    });
    const refused = FakeWebSocket.last!;
    return { getHook, unmount, refused };
  }

  it("does not count a wait out of the avatar allowance as a stall", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getHook, unmount, refused } = await rebuildRefusedByRateLimit();
    const before = FakeWebSocket.instances.length;

    // 15 s: still inside the 15.3 s wait. Not a stall, and no retry of its own.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("not live after"))).toBe(false);
    expect(FakeWebSocket.instances.length).toBe(before);

    // The wait ends: exactly ONE new session (the allowance attempt), not two.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      for (let i = 0; i < 20 && FakeWebSocket.last === refused; i++) await Promise.resolve();
    });
    expect(FakeWebSocket.instances.length).toBe(before + 1);
    await act(async () => {
      FakeWebSocket.last!.receive({ type: "session.updated", session: {} });
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("not live after"))).toBe(false);
    expect(FakeWebSocket.instances.length).toBe(before + 1);
    expect(getHook().connectionState).toBe("connected");
    warn.mockRestore();
    unmount();
  });

  it("still catches a stall in the attempt that follows the allowance wait", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { unmount, refused } = await rebuildRefusedByRateLimit();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_500);
      for (let i = 0; i < 20 && FakeWebSocket.last === refused; i++) await Promise.resolve();
    });
    const afterWait = FakeWebSocket.last!;
    expect(afterWait).not.toBe(refused);

    // That attempt never goes live: the re-armed check (15 s after it looked again) retries it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("retrying once"))).toBe(true);
    expect(FakeWebSocket.last).not.toBe(afterWait);
    warn.mockRestore();
    unmount();
  });

  it("leaves a drop after the rebuild went live to the reconnect loop alone", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { unmount } = await connectFor();
    const oldWs = FakeWebSocket.last!;
    act(() => {
      avatarBridge.onModeSwitchRequest!("video");
    });
    await act(async () => {
      for (let i = 0; i < 20 && FakeWebSocket.last === oldWs; i++) await Promise.resolve();
      FakeWebSocket.last!.receive({ type: "session.updated", session: {} });
    });
    const rebuilt = FakeWebSocket.last!;

    // The rebuilt session drops: the onclose loop reconnects (1 s backoff) and owns the recovery.
    await act(async () => {
      rebuilt.close();
      await vi.advanceTimersByTimeAsync(1_000);
      for (let i = 0; i < 20 && FakeWebSocket.last === rebuilt; i++) await Promise.resolve();
    });
    const reconnecting = FakeWebSocket.last!;
    expect(reconnecting).not.toBe(rebuilt);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("not live after"))).toBe(false);
    expect(FakeWebSocket.last).toBe(reconnecting); // no second session from the watchdog
    warn.mockRestore();
    unmount();
  });

  it("does nothing once the rebuilt session is live", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getHook, unmount } = await connectFor();
    const oldWs = FakeWebSocket.last!;

    act(() => {
      avatarBridge.onModeSwitchRequest!("audio-only");
    });
    await act(async () => {
      for (let i = 0; i < 20 && FakeWebSocket.last === oldWs; i++) await Promise.resolve();
      FakeWebSocket.last!.receive({ type: "session.updated", session: {} });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("not live after"))).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(getHook().connectionState).toBe("connected");
    warn.mockRestore();
    unmount();
  });

  it("stops the watchdog when the candidate leaves during a rebuild", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getHook, unmount } = await connectFor();
    const oldWs = FakeWebSocket.last!;

    act(() => {
      avatarBridge.onModeSwitchRequest!("video");
    });
    await act(async () => {
      for (let i = 0; i < 20 && FakeWebSocket.last === oldWs; i++) await Promise.resolve();
    });
    act(() => {
      getHook().disconnect();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("not live after"))).toBe(false);
    warn.mockRestore();
    unmount();
  });
});
