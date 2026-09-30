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
});
