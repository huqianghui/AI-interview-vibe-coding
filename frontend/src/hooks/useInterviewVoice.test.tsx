/**
 * Regression guard for the avatar-never-rendered bug.
 *
 * The teardown effect used to depend on `[cleanup]`, whose identity changes every render (it closes
 * over the fresh `audio`/`avatarStream` objects). That made the effect re-run on EVERY render, and
 * each re-run fired the previous render's teardown — closing the RTCPeerConnection mid-handshake
 * (so `createOffer()` never resolved) and the WS before any frame was sent. Net effect: the digital
 * human never rendered and voice frames never went out.
 *
 * This test renders the hook, forces re-renders, and asserts teardown runs ONLY on unmount — never
 * on a re-render.
 */
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, act } from "@testing-library/react";

const disconnectSpy = vi.fn();
const cleanupMicSpy = vi.fn();

// Stub the two sub-hooks so the test doesn't need a real WebRTC/audio stack — we only care about
// whether the hook's teardown effect fires `avatarStream.disconnect()` on re-render vs unmount.
vi.mock("./useAvatarStream", () => ({
  useAvatarStream: () => ({
    connect: vi.fn(),
    disconnect: disconnectSpy,
    handleServerSdp: vi.fn(),
    isConnected: false,
  }),
}));
vi.mock("./useVoiceAudio", () => ({
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
});

function Harness({ tick }: { tick: number }) {
  // Consume the hook and force state churn on each render, like the real page does when
  // session.updated flips connectionState/audioState.
  const voice = useInterviewVoice("iv-1", { locale: "zh-CN" });
  useEffect(() => {
    // touch a value so re-renders are "real"
    void voice.connectionState;
  }, [tick, voice.connectionState]);
  return <div data-testid="tick">{tick}</div>;
}

describe("useInterviewVoice teardown", () => {
  it("does NOT tear down the session on re-render — only on unmount", () => {
    const { rerender, unmount, getByTestId } = render(<Harness tick={0} />);

    // Several re-renders (each would previously have fired the stale teardown).
    act(() => rerender(<Harness tick={1} />));
    act(() => rerender(<Harness tick={2} />));
    act(() => rerender(<Harness tick={3} />));
    expect(getByTestId("tick").textContent).toBe("3");

    // No teardown during the component's life.
    expect(disconnectSpy).not.toHaveBeenCalled();
    expect(cleanupMicSpy).not.toHaveBeenCalled();

    // Teardown fires exactly once, on unmount.
    act(() => unmount());
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(cleanupMicSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * Regression guard for the mid-session error-event bug (数字人有时候不出现).
 *
 * The interview page fires manual `response.create` events (speakQuestion / "I'm done"). With
 * server-VAD auto-response enabled (v0.26), those can collide with an in-flight auto response and
 * Azure rejects with an in-band `error` EVENT — the session itself stays alive (WS open, audio and
 * avatar still streaming). Treating that as fatal flipped conn to "error", which made the interview
 * page fall back to text and hide the live digital human. A mid-session error must be non-fatal;
 * only a PRE-connect error may reject the connect() flow.
 */
describe("useInterviewVoice in-band error events", () => {
  class FakeWebSocket {
    static last: FakeWebSocket | null = null;
    static OPEN = 1;
    readyState = 1;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    sent: string[] = [];
    constructor(public url: string) {
      FakeWebSocket.last = this;
    }
    send(data: string) {
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

  it("keeps the session alive on an error event AFTER session.updated (non-fatal)", async () => {
    FakeWebSocket.last = null;
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    const onError = vi.fn();
    let hook!: ReturnType<typeof useInterviewVoice>;
    function ErrHarness() {
      hook = useInterviewVoice("iv-1", {
        locale: "zh-CN",
        tokenProvider: () => "tok",
        onError,
      });
      return null;
    }
    const { unmount } = render(<ErrHarness />);

    // Drive a successful connect: open the WS and deliver session.updated. connect() awaits the
    // audio-context/mic setup before creating the WS, so flush microtasks until the WS exists.
    let connectP!: Promise<void>;
    act(() => {
      connectP = hook.connect("zh-CN");
    });
    await act(async () => {
      for (let i = 0; i < 20 && !FakeWebSocket.last; i++) await Promise.resolve();
      FakeWebSocket.last!.receive({ type: "session.updated", session: {} });
      await connectP;
    });
    expect(hook.connectionState).toBe("connected");

    // A mid-session error event (e.g. response.create collided with a VAD auto-response) must NOT
    // kill the session: state stays connected, no onError to the page.
    await act(async () => {
      FakeWebSocket.last!.receive({
        type: "error",
        error: { message: "Conversation already has an active response" },
      });
    });
    expect(hook.connectionState).toBe("connected");
    expect(onError).not.toHaveBeenCalled();

    unmount();
    vi.unstubAllGlobals();
  });

  it("still rejects connect() on an error event BEFORE session.updated (fatal)", async () => {
    FakeWebSocket.last = null;
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    const onError = vi.fn();
    let hook!: ReturnType<typeof useInterviewVoice>;
    function ErrHarness() {
      hook = useInterviewVoice("iv-1", {
        locale: "zh-CN",
        tokenProvider: () => "tok",
        onError,
      });
      return null;
    }
    const { unmount } = render(<ErrHarness />);

    let connectP!: Promise<void>;
    act(() => {
      connectP = hook.connect("zh-CN");
      connectP.catch(() => undefined);
    });
    await act(async () => {
      for (let i = 0; i < 20 && !FakeWebSocket.last; i++) await Promise.resolve();
      FakeWebSocket.last!.receive({ type: "error", error: { message: "agent not found" } });
      await expect(connectP).rejects.toThrow("agent not found");
    });
    expect(onError).toHaveBeenCalled();

    unmount();
    vi.unstubAllGlobals();
  });
});
