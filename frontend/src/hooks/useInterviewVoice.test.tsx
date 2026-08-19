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

  it("does NOT surface a transient error to the page during a background reconnect", async () => {
    // A WS drop triggers the silent reconnect loop. If an attempt's pre-connect error fired
    // onError, the interview page showed "语音不可用" even when the NEXT attempt succeeded —
    // the "live face + voice-unavailable notice" contradiction. Mid-reconnect errors must stay
    // internal; only exhausting all attempts reports to the page.
    FakeWebSocket.last = null;
    vi.useFakeTimers();
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

    // Connect successfully first.
    let connectP!: Promise<void>;
    act(() => {
      connectP = hook.connect("zh-CN");
    });
    await act(async () => {
      for (let i = 0; i < 20 && !FakeWebSocket.last; i++) await Promise.resolve();
      FakeWebSocket.last!.receive({ type: "session.updated", session: {} });
      await connectP;
    });
    const firstWs = FakeWebSocket.last!;

    // Unexpected close → the hook schedules reconnect attempt #1 (1s backoff).
    await act(async () => {
      firstWs.close();
    });
    expect(hook.connectionState).toBe("reconnecting");

    // Fire the backoff timer; a NEW WS opens for the reconnect attempt.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    const secondWs = FakeWebSocket.last!;
    expect(secondWs).not.toBe(firstWs);

    // The reconnect attempt hits a PRE-connect error event — transient, must NOT reach the page.
    await act(async () => {
      secondWs.receive({ type: "error", error: { message: "temporarily unavailable" } });
    });
    expect(onError).not.toHaveBeenCalled();

    unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});

/**
 * Regression guard for the report-misalignment + empty-first-answer race (真机面试报告"未作答" + 顺序错位).
 *
 * STT transcription is ASYNC: the user's transcript only arrives via
 * `conversation.item.input_audio_transcription.completed`, on a server round-trip AFTER "I'm done"
 * is clicked. The page must submit THIS turn's resolved transcript, not a synchronous read of stale
 * state. `commitAnswer()` returns a Promise that resolves with the finalized transcript (or "" on
 * timeout / teardown, fail-closed, never hanging).
 */
describe("useInterviewVoice commitAnswer", () => {
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

  // Connect the hook over a FakeWebSocket and return the live handle + the socket. Mirrors the
  // connect dance used by the in-band-error tests above.
  async function connectHook() {
    FakeWebSocket.last = null;
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    let hook!: ReturnType<typeof useInterviewVoice>;
    function CommitHarness() {
      hook = useInterviewVoice("iv-1", { locale: "zh-CN", tokenProvider: () => "tok" });
      return null;
    }
    const { unmount } = render(<CommitHarness />);
    let connectP!: Promise<void>;
    act(() => {
      connectP = hook.connect("zh-CN");
    });
    await act(async () => {
      for (let i = 0; i < 20 && !FakeWebSocket.last; i++) await Promise.resolve();
      FakeWebSocket.last!.receive({ type: "session.updated", session: {} });
      await connectP;
    });
    return { getHook: () => hook, ws: () => FakeWebSocket.last!, unmount };
  }

  it("resolves with THIS turn's transcript once the completed event lands", async () => {
    const { getHook, ws, unmount } = await connectHook();

    let committed!: Promise<string>;
    act(() => {
      committed = getHook().commitAnswer();
    });
    // A manual commit fires a bare response.create requesting the turn's transcription.
    expect(ws().sent.some((s) => s.includes('"response.create"'))).toBe(true);

    await act(async () => {
      ws().receive({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "My spoken answer.",
      });
    });
    await expect(committed).resolves.toBe("My spoken answer.");

    unmount();
    vi.unstubAllGlobals();
  });

  it("resolves \"\" when no transcript arrives before the timeout (fail-closed, never hangs)", async () => {
    vi.useFakeTimers();
    const { getHook, unmount } = await connectHook();

    let committed!: Promise<string>;
    act(() => {
      committed = getHook().commitAnswer();
    });
    // Advance past COMMIT_TRANSCRIPT_TIMEOUT_MS (8s) with no completed event.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_500);
    });
    await expect(committed).resolves.toBe("");

    unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("settles a pending commit on disconnect so the awaiter never hangs", async () => {
    const { getHook, unmount } = await connectHook();

    let committed!: Promise<string>;
    act(() => {
      committed = getHook().commitAnswer();
    });
    // Teardown before any transcript arrives — cleanup() must resolve the pending commit.
    await act(async () => {
      await getHook().disconnect();
    });
    await expect(committed).resolves.toBe("");

    unmount();
    vi.unstubAllGlobals();
  });

  it("resolves with a transcript that arrived BEFORE the click (server-VAD ordering)", async () => {
    // Production config is server-VAD (azure_semantic_vad + end-of-utterance detection): Azure
    // auto-segments and emits the completed event when the user STOPS speaking — before they click
    // "I'm done". This is the exact ordering that produced the false "我们没有听到你的回答" bug: the
    // panel showed the answer but commitAnswer resolved "". The buffer must capture it.
    const { getHook, ws, unmount } = await connectHook();

    // Transcript lands first (user stopped talking; VAD fired), with NO commit armed yet.
    await act(async () => {
      ws().receive({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "The answer I spoke before clicking.",
      });
    });

    // THEN the user clicks "I'm done": commitAnswer must resolve with the already-arrived text,
    // not wait/time out.
    let committed!: Promise<string>;
    act(() => {
      committed = getHook().commitAnswer();
    });
    await expect(committed).resolves.toBe("The answer I spoke before clicking.");

    unmount();
    vi.unstubAllGlobals();
  });

  it("joins multiple pre-click segments into one answer (server-VAD multi-utterance)", async () => {
    const { getHook, ws, unmount } = await connectHook();

    await act(async () => {
      ws().receive({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "First I check the runbook.",
      });
      ws().receive({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Then I confirm the change ticket.",
      });
    });

    let committed!: Promise<string>;
    act(() => {
      committed = getHook().commitAnswer();
    });
    await expect(committed).resolves.toBe(
      "First I check the runbook. Then I confirm the change ticket.",
    );

    unmount();
    vi.unstubAllGlobals();
  });

  it("does not leak a pre-click transcript into the NEXT turn's commit", async () => {
    const { getHook, ws, unmount } = await connectHook();

    // Turn 1: transcript arrives before click, drained by commit.
    await act(async () => {
      ws().receive({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Turn one answer.",
      });
    });
    let commit1!: Promise<string>;
    act(() => {
      commit1 = getHook().commitAnswer();
    });
    await expect(commit1).resolves.toBe("Turn one answer.");

    // Turn 2: buffer must be empty now, so a click with no new transcript waits then fails closed —
    // it must NOT re-resolve turn one's text.
    vi.useFakeTimers();
    let commit2!: Promise<string>;
    act(() => {
      commit2 = getHook().commitAnswer();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_500);
    });
    await expect(commit2).resolves.toBe("");
    vi.useRealTimers();

    unmount();
    vi.unstubAllGlobals();
  });

  it("does not leak a transcript across turns (each commit resolves its own turn's text)", async () => {
    const { getHook, ws, unmount } = await connectHook();

    // Turn 1.
    let commit1!: Promise<string>;
    act(() => {
      commit1 = getHook().commitAnswer();
    });
    await act(async () => {
      ws().receive({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "First answer.",
      });
    });
    await expect(commit1).resolves.toBe("First answer.");

    // Turn 2 — must resolve the SECOND turn's text, not the first's, and not a concatenation.
    let commit2!: Promise<string>;
    act(() => {
      commit2 = getHook().commitAnswer();
    });
    await act(async () => {
      ws().receive({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Second answer.",
      });
    });
    await expect(commit2).resolves.toBe("Second answer.");

    unmount();
    vi.unstubAllGlobals();
  });
});

/**
 * Regression guard for the "数字人不说话" bug (avatar renders but never speaks the next question).
 *
 * Production uses server-VAD (create_response=True): Azure auto-creates a response the moment the
 * user stops speaking. So when the page calls speakQuestion(next) — or commitAnswer nudges the turn
 * — there is usually ALREADY an active response, and a naive conversation.item.create +
 * response.create collides: Azure rejects with `conversation_already_has_active_response` and the
 * backend-authoritative next question is silently dropped (the avatar improvises instead, then goes
 * quiet). The fix (Plan A): CANCEL the in-flight response and QUEUE the question, then speak it on
 * the `response.done` that follows the cancel. A collision rejection re-queues the same attempt.
 */
describe("useInterviewVoice speakQuestion cancel-then-speak", () => {
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

  async function connectHook() {
    FakeWebSocket.last = null;
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    let hook!: ReturnType<typeof useInterviewVoice>;
    function SpeakHarness() {
      hook = useInterviewVoice("iv-1", { locale: "zh-CN", tokenProvider: () => "tok" });
      return null;
    }
    const { unmount } = render(<SpeakHarness />);
    let connectP!: Promise<void>;
    act(() => {
      connectP = hook.connect("zh-CN");
    });
    await act(async () => {
      for (let i = 0; i < 20 && !FakeWebSocket.last; i++) await Promise.resolve();
      FakeWebSocket.last!.receive({ type: "session.updated", session: {} });
      await connectP;
    });
    return { getHook: () => hook, ws: () => FakeWebSocket.last!, unmount };
  }

  // Parse each sent frame's `type`, in order, for readable assertions on the wire sequence.
  const sentTypes = (ws: FakeWebSocket) =>
    ws.sent.map((s) => (JSON.parse(s) as { type?: string }).type);

  it("speaks immediately (item.create + response.create) when the conversation is idle", async () => {
    const { getHook, ws, unmount } = await connectHook();

    act(() => {
      expect(getHook().speakQuestion("Question one.")).toBe(true);
    });

    const types = sentTypes(ws());
    expect(types).toContain("conversation.item.create");
    expect(types).toContain("response.create");
    expect(types).not.toContain("response.cancel");
    // The verbatim text rides on the assistant item.
    const item = ws().sent
      .map((s) => JSON.parse(s) as { type?: string; item?: { content?: { text?: string }[] } })
      .find((m) => m.type === "conversation.item.create");
    expect(item?.item?.content?.[0]?.text).toBe("Question one.");

    unmount();
    vi.unstubAllGlobals();
  });

  it("cancels and defers when a response is active, then speaks on response.done", async () => {
    const { getHook, ws, unmount } = await connectHook();

    // A server-VAD auto-response is in flight.
    await act(async () => {
      ws().receive({ type: "response.created" });
    });

    // The page wants to speak the next question NOW — must cancel, not collide.
    act(() => {
      expect(getHook().speakQuestion("The next question.")).toBe(true);
    });
    let types = sentTypes(ws());
    expect(types).toContain("response.cancel");
    // Nothing spoken yet — no assistant item / response.create while still active.
    expect(types).not.toContain("conversation.item.create");

    // The cancel resolves to response.done; the queued question now flushes onto the idle convo.
    await act(async () => {
      ws().receive({ type: "response.done" });
    });
    types = sentTypes(ws());
    expect(types).toContain("conversation.item.create");
    expect(types.filter((t) => t === "response.create").length).toBe(1);
    const item = ws().sent
      .map((s) => JSON.parse(s) as { type?: string; item?: { content?: { text?: string }[] } })
      .find((m) => m.type === "conversation.item.create");
    expect(item?.item?.content?.[0]?.text).toBe("The next question.");

    unmount();
    vi.unstubAllGlobals();
  });

  it("keeps only the latest queued question (latest-wins) across rapid speakQuestion calls", async () => {
    const { getHook, ws, unmount } = await connectHook();

    await act(async () => {
      ws().receive({ type: "response.created" });
    });
    act(() => {
      getHook().speakQuestion("stale question");
      getHook().speakQuestion("fresh question");
    });

    await act(async () => {
      ws().receive({ type: "response.done" });
    });
    const spoken = ws().sent
      .map((s) => JSON.parse(s) as { type?: string; item?: { content?: { text?: string }[] } })
      .filter((m) => m.type === "conversation.item.create")
      .map((m) => m.item?.content?.[0]?.text);
    expect(spoken).toEqual(["fresh question"]);

    unmount();
    vi.unstubAllGlobals();
  });

  it("re-queues the attempt on a collision rejection and speaks it after response.done", async () => {
    const { getHook, ws, unmount } = await connectHook();

    // Idle by our optimistic view, so speakQuestion emits directly...
    act(() => {
      getHook().speakQuestion("Colliding question.");
    });
    expect(sentTypes(ws())).toContain("response.create");

    // ...but Azure had a server-VAD auto-response we hadn't seen: it rejects the collision.
    await act(async () => {
      ws().receive({
        type: "error",
        error: {
          code: "conversation_already_has_active_response",
          message: "Conversation already has an active response",
        },
      });
    });
    // Session stays alive; the attempt is re-queued (not dropped).
    expect(getHook().connectionState).toBe("connected");

    // When the real auto-response finishes, the re-queued question is spoken.
    await act(async () => {
      ws().receive({ type: "response.done" });
    });
    const spoken = ws().sent
      .map((s) => JSON.parse(s) as { type?: string; item?: { content?: { text?: string }[] } })
      .filter((m) => m.type === "conversation.item.create")
      .map((m) => m.item?.content?.[0]?.text);
    expect(spoken).toContain("Colliding question.");

    unmount();
    vi.unstubAllGlobals();
  });

  it("returns false and sends nothing when the socket is not open", async () => {
    const { getHook, ws, unmount } = await connectHook();
    const before = ws().sent.length;
    // Simulate a closed socket.
    ws().readyState = 3;
    act(() => {
      expect(getHook().speakQuestion("won't send")).toBe(false);
    });
    expect(ws().sent.length).toBe(before);

    unmount();
    vi.unstubAllGlobals();
  });

  it("commitAnswer skips the response.create nudge while a response is active", async () => {
    const { getHook, ws, unmount } = await connectHook();

    // A response is in flight (server-VAD auto-response after the user stopped speaking).
    await act(async () => {
      ws().receive({ type: "response.created" });
    });
    const before = sentTypes(ws()).filter((t) => t === "response.create").length;

    // "I'm done" with no buffered transcript arms a pending commit — but must NOT fire a colliding
    // response.create while a response is already active.
    act(() => {
      void getHook().commitAnswer();
    });
    const after = sentTypes(ws()).filter((t) => t === "response.create").length;
    expect(after).toBe(before);

    unmount();
    vi.unstubAllGlobals();
  });

  it("commitAnswer still nudges (response.create) when the conversation is idle", async () => {
    const { getHook, ws, unmount } = await connectHook();
    // No active response — the nudge is needed to advance a manual-VAD turn.
    act(() => {
      void getHook().commitAnswer();
    });
    expect(sentTypes(ws())).toContain("response.create");

    unmount();
    vi.unstubAllGlobals();
  });
});
