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

// Mutable avatar-connectivity holder so the avatar-gate tests can flip `isConnected` between
// renders (the default is false — matches every pre-existing test that never touches it).
const avatarState = { isConnected: false };

// Stub the two sub-hooks so the test doesn't need a real WebRTC/audio stack — we only care about
// whether the hook's teardown effect fires `avatarStream.disconnect()` on re-render vs unmount.
vi.mock("./useAvatarStream", () => ({
  useAvatarStream: () => ({
    connect: vi.fn(),
    disconnect: disconnectSpy,
    handleServerSdp: vi.fn(),
    get isConnected() {
      return avatarState.isConnected;
    },
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
  avatarState.isConnected = false;
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
    // The rejected first attempt is re-queued and read after response.done. (Its response.create
    // was rejected, so the first item.create is never voiced — only the retry produces a spoken
    // response; the user hears the question once.) Assert the retry ACTUALLY fired: two frames for
    // this text (the rejected attempt + the retry). If the collision handler stops clearing
    // spokenTextRef, the idempotency guard swallows the retry (only 1 frame) and the re-queued
    // question is never voiced — the masked-regression this count guards against.
    expect(spoken.filter((t) => t === "Colliding question.").length).toBe(2);
    // And exactly two response.create attempts: the rejected one and the surviving retry.
    expect(sentTypes(ws()).filter((t) => t === "response.create").length).toBe(2);

    unmount();
    vi.unstubAllGlobals();
  });

  it("reads a question exactly ONCE even when response.done fires repeatedly (读三遍 fix)", async () => {
    // The regression: every `response.done` fires the pending-speak flush, and several routes lead
    // back into emitSpeak — so a single backend question was re-emitted on successive done events
    // and Azure read it 2–3 times (each a separate transcript bubble). One question text must map
    // to exactly one conversation.item.create + response.create, no matter how many done events land.
    const { getHook, ws, unmount } = await connectHook();

    act(() => {
      getHook().speakQuestion("How do you know your trials are under control?");
    });
    // The real response starts and ends; then more done events arrive (avatar audio segments, a
    // stray auto-response completing, etc.). None may re-read the already-spoken question.
    await act(async () => {
      ws().receive({ type: "response.created" });
      ws().receive({ type: "response.done" });
      ws().receive({ type: "response.done" });
      ws().receive({ type: "response.done" });
    });

    const reads = ws()
      .sent.map((s) => JSON.parse(s) as { type?: string; item?: { content?: { text?: string }[] } })
      .filter((m) => m.type === "conversation.item.create")
      .map((m) => m.item?.content?.[0]?.text);
    expect(reads).toEqual(["How do you know your trials are under control?"]);

    unmount();
    vi.unstubAllGlobals();
  });

  it("re-speaking the SAME current prompt is a no-op (idempotent per text)", async () => {
    // The page keys speakQuestion on the prompt text, but a reconnect/re-render can call it again
    // with the same current prompt. That must not queue a second read of a question already voiced.
    const { getHook, ws, unmount } = await connectHook();

    act(() => {
      getHook().speakQuestion("Same question.");
    });
    await act(async () => {
      ws().receive({ type: "response.created" });
      ws().receive({ type: "response.done" });
    });
    // Same text again while idle — no new read.
    act(() => {
      getHook().speakQuestion("Same question.");
    });

    const reads = ws()
      .sent.map((s) => JSON.parse(s) as { type?: string; item?: { content?: { text?: string }[] } })
      .filter((m) => m.type === "conversation.item.create")
      .map((m) => m.item?.content?.[0]?.text);
    expect(reads).toEqual(["Same question."]);

    unmount();
    vi.unstubAllGlobals();
  });

  it("does not re-queue an already-accepted question when a stray collision error arrives later", async () => {
    // Once response.created confirms the question was accepted, lastSpokenAttemptRef is cleared. A
    // later, UNRELATED collision error (e.g. a commitAnswer nudge colliding with a VAD response)
    // must NOT resurrect that accepted question into the pending-speak slot — doing so re-read it on
    // the next response.done, one of the routes that fed the 读三遍 symptom.
    const { getHook, ws, unmount } = await connectHook();

    act(() => {
      getHook().speakQuestion("Accepted question.");
    });
    // Azure accepts it: response.created lands, closing the retry slot for this attempt.
    await act(async () => {
      ws().receive({ type: "response.created" });
    });

    // A stray collision error arrives afterwards (a different frame collided). Nothing to re-queue.
    await act(async () => {
      ws().receive({
        type: "error",
        error: {
          code: "conversation_already_has_active_response",
          message: "Conversation already has an active response",
        },
      });
      ws().receive({ type: "response.done" });
    });

    const reads = ws()
      .sent.map((s) => JSON.parse(s) as { type?: string; item?: { content?: { text?: string }[] } })
      .filter((m) => m.type === "conversation.item.create")
      .map((m) => m.item?.content?.[0]?.text);
    expect(reads).toEqual(["Accepted question."]);

    unmount();
    vi.unstubAllGlobals();
  });

  it("resets the per-text guard across a disconnect/reconnect so a fresh session re-reads", async () => {
    // spokenTextRef is session state — cleanup() must reset it. Otherwise a reconnect that re-speaks
    // the same current question (the page keys on prompt text, unchanged across a reconnect) would be
    // silently swallowed and the candidate would sit in silence on the new session.
    const { getHook, ws, unmount } = await connectHook();

    act(() => {
      getHook().speakQuestion("Resumed question.");
    });
    await act(async () => {
      ws().receive({ type: "response.created" });
      ws().receive({ type: "response.done" });
    });

    // Tear the session down (cleanup resets spokenTextRef), then reconnect fresh.
    await act(async () => {
      await getHook().disconnect();
    });
    let reconnectP!: Promise<void>;
    act(() => {
      reconnectP = getHook().connect("zh-CN");
    });
    await act(async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
      ws().receive({ type: "session.updated", session: {} });
      await reconnectP;
    });

    // Same text on the NEW socket must actually read — the guard was reset by cleanup.
    act(() => {
      getHook().speakQuestion("Resumed question.");
    });
    const reads = ws()
      .sent.map((s) => JSON.parse(s) as { type?: string; item?: { content?: { text?: string }[] } })
      .filter((m) => m.type === "conversation.item.create")
      .map((m) => m.item?.content?.[0]?.text);
    expect(reads).toEqual(["Resumed question."]);

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

/**
 * Live transcript streaming (the "说了多少就展示多少" feature).
 *
 * User side: Azure emits `conversation.item.input_audio_transcription.delta` frames WHILE the user
 * is still speaking. The hook must accumulate them per conversation item and emit the RUNNING text
 * as a non-final segment under a stable per-item id — consumers replace same-id segments, so
 * emitting bare fragments would show only the newest word. The `.completed` event finalizes the
 * SAME id (one bubble, replaced in place, no duplicate) and remains the only source of
 * commitAnswer's submitted text (partials are display-only).
 *
 * Assistant side: `response.audio_transcript.delta` had the same replace-vs-append mismatch — the
 * hook now accumulates there too.
 */
describe("useInterviewVoice live transcript streaming", () => {
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

  type Seg = { id: string; role: string; content: string; isFinal: boolean };

  async function connectHook() {
    FakeWebSocket.last = null;
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    const segments: Seg[] = [];
    let hook!: ReturnType<typeof useInterviewVoice>;
    function StreamHarness() {
      hook = useInterviewVoice("iv-1", {
        locale: "zh-CN",
        tokenProvider: () => "tok",
        onTranscript: (seg) => segments.push(seg),
      });
      return null;
    }
    const { unmount } = render(<StreamHarness />);
    let connectP!: Promise<void>;
    act(() => {
      connectP = hook.connect("zh-CN");
    });
    await act(async () => {
      for (let i = 0; i < 20 && !FakeWebSocket.last; i++) await Promise.resolve();
      FakeWebSocket.last!.receive({ type: "session.updated", session: {} });
      await connectP;
    });
    return { getHook: () => hook, ws: () => FakeWebSocket.last!, segments, unmount };
  }

  it("streams user partials as a growing non-final segment, finalized in place by completed", async () => {
    const { ws, segments, unmount } = await connectHook();

    await act(async () => {
      ws().receive({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "item-1",
        delta: "I follow ",
      });
      ws().receive({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "item-1",
        delta: "the procedure",
      });
      ws().receive({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "item-1",
        transcript: "I follow the procedure.",
      });
    });

    const user = segments.filter((s) => s.role === "user");
    // Two growing partials + one final, ALL under the same stable id (in-place replacement).
    expect(user.map((s) => s.content)).toEqual([
      "I follow ",
      "I follow the procedure",
      "I follow the procedure.",
    ]);
    expect(user.map((s) => s.isFinal)).toEqual([false, false, true]);
    expect(new Set(user.map((s) => s.id)).size).toBe(1);

    unmount();
    vi.unstubAllGlobals();
  });

  it("keeps concurrent utterance items separate and falls back to counter ids without deltas", async () => {
    const { ws, segments, unmount } = await connectHook();

    await act(async () => {
      // Item A streams deltas; item B (no deltas — e.g. delta events unavailable) only completes.
      ws().receive({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "item-a",
        delta: "First",
      });
      ws().receive({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "item-b",
        transcript: "Second utterance.",
      });
      ws().receive({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "item-a",
        transcript: "First utterance.",
      });
    });

    const finals = segments.filter((s) => s.role === "user" && s.isFinal);
    expect(finals.map((s) => s.content)).toEqual(["Second utterance.", "First utterance."]);
    // item-a finalizes under its delta-stream id; item-b under a fallback id — and they differ.
    expect(finals[1].id).toBe("user-item-a");
    expect(finals[0].id).not.toBe(finals[1].id);

    unmount();
    vi.unstubAllGlobals();
  });

  it("still resolves commitAnswer from completed transcripts only (partials never submit)", async () => {
    const { getHook, ws, segments, unmount } = await connectHook();

    await act(async () => {
      ws().receive({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "item-1",
        delta: "partial words",
      });
    });
    let committed!: Promise<string>;
    act(() => {
      committed = getHook().commitAnswer();
    });
    await act(async () => {
      ws().receive({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "item-1",
        transcript: "The finalized answer.",
      });
    });
    await expect(committed).resolves.toBe("The finalized answer.");
    // The partial reached the panel (display) but never the commit path.
    expect(segments.some((s) => !s.isFinal && s.content === "partial words")).toBe(true);

    unmount();
    vi.unstubAllGlobals();
  });

  it("accumulates assistant audio_transcript deltas into a growing bubble", async () => {
    const { ws, segments, unmount } = await connectHook();

    await act(async () => {
      ws().receive({
        type: "response.audio_transcript.delta",
        response_id: "r1",
        item_id: "i1",
        delta: "Please describe ",
      });
      ws().receive({
        type: "response.audio_transcript.delta",
        response_id: "r1",
        item_id: "i1",
        delta: "a situation.",
      });
      ws().receive({
        type: "response.audio_transcript.done",
        response_id: "r1",
        item_id: "i1",
        transcript: "Please describe a situation.",
      });
    });

    const assistant = segments.filter((s) => s.role === "assistant");
    expect(assistant.map((s) => s.content)).toEqual([
      "Please describe ",
      "Please describe a situation.",
      "Please describe a situation.",
    ]);
    expect(assistant.map((s) => s.isFinal)).toEqual([false, false, true]);
    expect(new Set(assistant.map((s) => s.id)).size).toBe(1);

    unmount();
    vi.unstubAllGlobals();
  });
});

/**
 * Question-read delivery watchdog (the "换题没读题" fix).
 *
 * The cancel/queue/flush machinery has routes that can silently drop a queued question — and the
 * page latches "spoken" as soon as speakQuestion returns true, so one drop meant the question was
 * NEVER read aloud (intermittent: whether the `response.done` flush fired decided it). The hook
 * now owns delivery: a watch armed per speakQuestion is confirmed only when an assistant
 * transcript actually matches the question text, and an unconfirmed watch retries the read.
 */
describe("useInterviewVoice question-read watchdog", () => {
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

  function questionReads(ws: FakeWebSocket): string[] {
    return ws.sent
      .map((s) => JSON.parse(s) as { type?: string; item?: { content?: { text?: string }[] } })
      .filter((m) => m.type === "conversation.item.create")
      .map((m) => m.item?.content?.[0]?.text ?? "");
  }

  async function connectHook() {
    FakeWebSocket.last = null;
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    let hook!: ReturnType<typeof useInterviewVoice>;
    function WatchHarness() {
      hook = useInterviewVoice("iv-1", { locale: "zh-CN", tokenProvider: () => "tok" });
      return null;
    }
    const { unmount } = render(<WatchHarness />);
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

  it("retries an unconfirmed question read after the watchdog window", async () => {
    vi.useFakeTimers();
    const { getHook, ws, unmount } = await connectHook();

    act(() => {
      void getHook().speakQuestion("What is your greatest strength?");
    });
    expect(questionReads(ws())).toEqual(["What is your greatest strength?"]);

    // No assistant transcript ever matches (the read was silently dropped) → watchdog re-emits.
    await act(async () => {
      vi.advanceTimersByTime(13_000);
    });
    expect(questionReads(ws())).toEqual([
      "What is your greatest strength?",
      "What is your greatest strength?",
    ]);

    unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does NOT retry once the assistant transcript confirms the read", async () => {
    vi.useFakeTimers();
    const { getHook, ws, unmount } = await connectHook();

    act(() => {
      void getHook().speakQuestion("Describe a difficult decision you made.");
    });
    // The verbatim read starts playing — its transcript delta matches the question prefix.
    await act(async () => {
      ws().receive({
        type: "response.audio_transcript.delta",
        response_id: "r1",
        item_id: "i1",
        delta: "Describe a difficult decision",
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(questionReads(ws())).toEqual(["Describe a difficult decision you made."]);

    unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("a server-VAD auto-response does NOT confirm the watch (prefix mismatch) and retry still fires", async () => {
    vi.useFakeTimers();
    const { getHook, ws, unmount } = await connectHook();

    act(() => {
      void getHook().speakQuestion("How do you manage regulatory differences?");
    });
    // An improvised agent reply plays instead of the question — must not count as confirmation.
    await act(async () => {
      ws().receive({
        type: "response.audio_transcript.delta",
        response_id: "r-auto",
        item_id: "i-auto",
        delta: "Thank you — that's a good example of",
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(13_000);
    });
    expect(questionReads(ws()).length).toBe(2);

    unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("stops retrying after SPEAK_MAX_ATTEMPTS", async () => {
    vi.useFakeTimers();
    const { getHook, ws, unmount } = await connectHook();

    act(() => {
      void getHook().speakQuestion("Question that never confirms.");
    });
    await act(async () => {
      // Far beyond attempts × window — reads must cap at SPEAK_MAX_ATTEMPTS (4).
      for (let i = 0; i < 10; i++) vi.advanceTimersByTime(13_000);
    });
    expect(questionReads(ws()).length).toBe(4);

    unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("a newer question supersedes the watch on an older one", async () => {
    vi.useFakeTimers();
    const { getHook, ws, unmount } = await connectHook();

    act(() => {
      void getHook().speakQuestion("Old question?");
    });
    act(() => {
      void getHook().speakQuestion("New question?");
    });
    await act(async () => {
      vi.advanceTimersByTime(13_000);
    });
    const reads = questionReads(ws());
    // The old question was read once (its initial emit, which optimistically marked a response
    // active); the NEW question therefore QUEUED on its first attempt (0 emits) and is emitted by
    // its watchdog retry. Crucially the superseded OLD watch never retries.
    expect(reads.filter((r) => r === "Old question?").length).toBe(1);
    expect(reads.filter((r) => r === "New question?").length).toBe(1);

    unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("confirms a PARAPHRASED read by response id (no retry) — the 读两遍 regression", async () => {
    // The verbatim text is injected, but the agent often PARAPHRASES it ("Please introduce…" comes
    // out as "Could you tell me about…"). A prefix/text match then never fires, so the pre-fix
    // watchdog "retried" a read that had actually played and the question was spoken twice. The read
    // response's id is claimed on `response.created`; any transcript under that id confirms delivery
    // regardless of wording.
    vi.useFakeTimers();
    const { getHook, ws, unmount } = await connectHook();

    act(() => {
      void getHook().speakQuestion("Please introduce your relevant experience for this role.");
    });
    await act(async () => {
      ws().receive({ type: "response.created", response: { id: "resp-read-1" } });
      // A fully paraphrased transcript under the CLAIMED id — shares few surface words, but the id
      // proves it's our read playing.
      ws().receive({
        type: "response.audio_transcript.delta",
        response_id: "resp-read-1",
        item_id: "i1",
        delta: "Could you tell me a bit about what you've done that fits this position?",
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    // Read exactly once — the id-claim confirmed it despite the paraphrase.
    expect(questionReads(ws())).toEqual([
      "Please introduce your relevant experience for this role.",
    ]);

    unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("confirms a paraphrase by word-overlap when no response id is available (fuzzy fallback)", async () => {
    // Some paths carry no response.created id claim (e.g. transcript arrives under a different id).
    // A paraphrase still shares most of the question's CONTENT words, so ≥60% word overlap confirms
    // delivery — without false-confirming on an unrelated auto-response (covered by the next test).
    vi.useFakeTimers();
    const { getHook, ws, unmount } = await connectHook();

    act(() => {
      void getHook().speakQuestion("Describe how you resolved a difficult customer complaint.");
    });
    // No `response.created` id claim; the transcript reorders/rewords but keeps the content words.
    await act(async () => {
      ws().receive({
        type: "response.audio_transcript.done",
        response_id: "r-unclaimed",
        item_id: "i1",
        transcript: "Please describe how you resolved a difficult complaint from a customer.",
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(questionReads(ws())).toEqual([
      "Describe how you resolved a difficult customer complaint.",
    ]);

    unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does NOT confirm on an unrelated auto-response under a different id (retry still fires)", async () => {
    // The guard against over-eager confirmation: an improvised auto-response under an id we did NOT
    // claim, sharing few of the question's words, must not confirm — the watchdog still retries.
    vi.useFakeTimers();
    const { getHook, ws, unmount } = await connectHook();

    act(() => {
      void getHook().speakQuestion("How do you manage regulatory differences across markets?");
    });
    await act(async () => {
      // Claimed id is resp-read; the transcript arrives under a DIFFERENT id with unrelated words.
      ws().receive({ type: "response.created", response: { id: "resp-read" } });
      ws().receive({
        type: "response.audio_transcript.delta",
        response_id: "r-auto-other",
        item_id: "i-auto",
        delta: "Thanks, that's helpful. Let's continue.",
      });
    });
    // The delta above IS under a non-claimed id AND fails word-overlap → no confirmation. But note
    // the claimed-id delta path would confirm; here the auto-response used its own id, so retry runs.
    await act(async () => {
      vi.advanceTimersByTime(13_000);
    });
    expect(questionReads(ws()).length).toBe(2);

    unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});

/**
 * First-read avatar gate (the "第一句话前面的词被吃掉" fix).
 *
 * When the avatar is enabled, the assistant's spoken audio rides the avatar's OWN WebRTC track,
 * live only once its handshake completes and frames paint. A question read fired the instant the WS
 * reaches `connected` clips its opening words. The hook holds the FIRST read until the avatar is
 * connected (released early on connect, or after a bounded timeout so silence never results); voice-
 * only sessions (avatar disabled) never gate.
 */
describe("useInterviewVoice first-read avatar gate", () => {
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

  function questionReads(ws: FakeWebSocket): string[] {
    return ws.sent
      .map((s) => JSON.parse(s) as { type?: string; item?: { content?: { text?: string }[] } })
      .filter((m) => m.type === "conversation.item.create")
      .map((m) => m.item?.content?.[0]?.text ?? "");
  }

  // Connect with a controllable avatar. `avatarEnabled` decides whether proxy.connected advertises
  // the avatar (arming the gate). Returns a rerender to re-run the isConnected-watching effect after
  // flipping `avatarState.isConnected`.
  async function connectHook(avatarEnabled: boolean) {
    FakeWebSocket.last = null;
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    let hook!: ReturnType<typeof useInterviewVoice>;
    function GateHarness({ tick }: { tick: number }) {
      hook = useInterviewVoice("iv-1", { locale: "zh-CN", tokenProvider: () => "tok" });
      return <div data-testid="tick">{tick}</div>;
    }
    const { unmount, rerender } = render(<GateHarness tick={0} />);
    let connectP!: Promise<void>;
    act(() => {
      connectP = hook.connect("zh-CN");
    });
    await act(async () => {
      for (let i = 0; i < 20 && !FakeWebSocket.last; i++) await Promise.resolve();
      if (avatarEnabled) {
        FakeWebSocket.last!.receive({ type: "proxy.connected", avatar_enabled: true });
      }
      FakeWebSocket.last!.receive({ type: "session.updated", session: {} });
      await connectP;
    });
    return {
      getHook: () => hook,
      ws: () => FakeWebSocket.last!,
      rerender: (t: number) => rerender(<GateHarness tick={t} />),
      unmount,
    };
  }

  it("holds the first read until the avatar connects, then reads it once", async () => {
    const { getHook, ws, rerender, unmount } = await connectHook(true);

    // Avatar enabled but not yet painting frames — the first read is HELD (nothing on the wire).
    act(() => {
      expect(getHook().speakQuestion("First question, please introduce yourself.")).toBe(true);
    });
    expect(questionReads(ws())).toEqual([]);

    // Avatar starts painting frames → the effect releases the held read.
    avatarState.isConnected = true;
    act(() => {
      rerender(1);
    });
    expect(questionReads(ws())).toEqual(["First question, please introduce yourself."]);

    unmount();
    vi.unstubAllGlobals();
  });

  it("releases the held first read after the timeout if the avatar never connects", async () => {
    vi.useFakeTimers();
    const { getHook, ws, unmount } = await connectHook(true);

    act(() => {
      getHook().speakQuestion("Gated question.");
    });
    expect(questionReads(ws())).toEqual([]);

    // Avatar never connects — the bounded gate elapses and the question is read anyway (no silence).
    await act(async () => {
      vi.advanceTimersByTime(6_500);
    });
    expect(questionReads(ws())).toEqual(["Gated question."]);

    unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does NOT gate when the avatar is disabled (voice-only reads immediately)", async () => {
    const { getHook, ws, unmount } = await connectHook(false);

    act(() => {
      getHook().speakQuestion("Voice-only question.");
    });
    // No avatar → audio plays over the WS AudioContext, ready at session.updated: read immediately.
    expect(questionReads(ws())).toEqual(["Voice-only question."]);

    unmount();
    vi.unstubAllGlobals();
  });

  it("gates only the FIRST read — later questions read immediately even mid-handshake", async () => {
    const { getHook, ws, rerender, unmount } = await connectHook(true);

    // First read held, then released when the avatar connects.
    act(() => {
      getHook().speakQuestion("First question.");
    });
    avatarState.isConnected = true;
    act(() => {
      rerender(1);
    });
    expect(questionReads(ws())).toEqual(["First question."]);
    // Complete the first read's response lifecycle so the conversation is idle again.
    await act(async () => {
      ws().receive({ type: "response.created", response: { id: "r1" } });
      ws().receive({ type: "response.done" });
    });

    // A later question reads immediately (not gated) now that the conversation is idle.
    act(() => {
      getHook().speakQuestion("Second question.");
    });
    expect(questionReads(ws())).toEqual(["First question.", "Second question."]);

    unmount();
    vi.unstubAllGlobals();
  });

  it("supersedes a held first read with a newer question (latest-wins)", async () => {
    const { getHook, ws, rerender, unmount } = await connectHook(true);

    act(() => {
      getHook().speakQuestion("Stale first question.");
      getHook().speakQuestion("Fresh first question.");
    });
    expect(questionReads(ws())).toEqual([]);

    avatarState.isConnected = true;
    act(() => {
      rerender(1);
    });
    // Only the latest held text is read when the gate releases.
    expect(questionReads(ws())).toEqual(["Fresh first question."]);

    unmount();
    vi.unstubAllGlobals();
  });
});
