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
    prepareAudioContext: vi.fn(),
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

});
