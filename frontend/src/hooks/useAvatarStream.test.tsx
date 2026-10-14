/**
 * Regression guard for the avatar media-layer SELF-HEAL (数字人掉成球且回不来).
 *
 * The avatar's video/audio ride a SEPARATE RTCPeerConnection from the main Voice Live WS, so the
 * WS-close reconnect in useInterviewVoice does NOT cover an avatar-only media drop. Before the fix,
 * `oniceconnectionstatechange` only logged and `track.onended` flipped straight to the orb with no
 * path back — one media blip meant orb for the rest of the session.
 *
 * These tests drive a controllable fake RTCPeerConnection through the drop signals and assert:
 *   1. ICE `failed` → the hook asks its consumer to rebuild the Voice Live SESSION in the same mode,
 *      and never re-offers on the live one (Azure refuses that: `webrtc_connection_invalid`).
 *   2. A transient ICE `disconnected` that returns to `connected` within the grace window does NOT
 *      rebuild (no reconnect storm, no orb flash).
 *   3. `disconnect()` cancels a pending rebuild (no zombie rebuild after teardown).
 *   4. The budget is bounded across rebuilt sessions: video → video → audio-only → orb, three avatar
 *      sessions in all (Azure's allowance), and a rebuild waits out the allowance before it asks.
 *   5. Media actually flowing hands the next drop a fresh budget.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { HEALTH_THRESHOLDS as T } from "./avatarHealth";
import { useAvatarStream } from "./useAvatarStream";

/** Minimal controllable RTCPeerConnection stand-in. Captures the hook's event handlers so the test
 * can fire ICE state changes / gathering completion / track events on demand. */
class FakePC {
  static instances: FakePC[] = [];
  iceConnectionState = "new";
  connectionState = "new";
  iceGatheringState = "new";
  localDescription: { sdp: string } | null = null;
  remoteDescription: unknown = null;
  closed = false;
  onicecandidate: ((e: { candidate: RTCIceCandidate | null }) => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((e: unknown) => void) | null = null;

  /** Every addTransceiver call, so a test can assert the video direction (recvonly vs inactive). */
  transceivers: { kind: string; direction: string }[] = [];
  /** Rows the next getStats() resolves with. Tests mutate this to drive the health sampler. */
  statsRows: Record<string, unknown>[] = [];

  constructor(public config: RTCConfiguration) {
    FakePC.instances.push(this);
  }
  addTransceiver(kind: string, init?: RTCRtpTransceiverInit) {
    this.transceivers.push({ kind, direction: init?.direction ?? "sendrecv" });
  }
  async getStats() {
    return new Map(this.statsRows.map((row) => [String(row.id), row]));
  }
  async createOffer() {
    return { type: "offer", sdp: "fake-offer-sdp" } as RTCSessionDescriptionInit;
  }
  async setLocalDescription(desc: RTCSessionDescriptionInit) {
    this.localDescription = { sdp: desc.sdp ?? "fake-offer-sdp" };
  }
  async setRemoteDescription(desc: unknown) {
    this.remoteDescription = desc;
  }
  close() {
    this.closed = true;
  }

  // --- test drivers ---
  fireIce(state: string) {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }
  completeGathering() {
    this.iceGatheringState = "complete";
    this.onicecandidate?.({ candidate: null });
  }
  emitCandidate(sdpFragment: string) {
    this.onicecandidate?.({ candidate: { candidate: sdpFragment } as RTCIceCandidate });
  }
  /** Deliver a remote track, the way Azure does once the answer is applied. */
  emitTrack(kind: "audio" | "video") {
    const track = { kind, onended: null } as unknown as MediaStreamTrack;
    this.ontrack?.({ track, streams: [{ id: `${kind}-stream` } as unknown as MediaStream] });
  }
}

function makeVideoRef() {
  // attachStream needs `play()` and the dimension getters; 0x0 means "no frames yet", so isConnected
  // stays false unless a test says otherwise.
  return {
    current: {
      srcObject: null,
      videoWidth: 0,
      videoHeight: 0,
      muted: false,
      play: () => Promise.resolve(),
    } as unknown as HTMLVideoElement,
  };
}

/** Stats rows shaped like a real inbound-rtp report, for the health sampler. */
function statsRows(opts: {
  concealed: number;
  totalSamples: number;
  framesDecoded: number;
  videoBytes: number;
}): Record<string, unknown>[] {
  return [
    {
      id: "A",
      type: "inbound-rtp",
      kind: "audio",
      concealedSamples: opts.concealed,
      totalSamplesReceived: opts.totalSamples,
    },
    {
      id: "V",
      type: "inbound-rtp",
      kind: "video",
      framesDecoded: opts.framesDecoded,
      bytesReceived: opts.videoBytes,
    },
    { id: "T", type: "transport", selectedCandidatePairId: "P" },
    { id: "P", type: "candidate-pair", state: "succeeded", nominated: true, currentRoundTripTime: 0.3 },
  ];
}

/** Flush pending microtasks (createOffer/setLocalDescription/setRemoteDescription resolutions). */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Drive one full offer→answer handshake to completion on the given fake PC. */
async function completeHandshake(
  pc: FakePC,
  handleServerSdp: (raw: string) => void,
) {
  await flush(); // createOffer + setLocalDescription resolve
  await act(async () => {
    pc.completeGathering(); // resolves the ICE-gathering gate → sendSdpOffer fires
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    handleServerSdp(btoa(JSON.stringify({ type: "answer", sdp: "fake-answer-sdp" })));
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  FakePC.instances = [];
  vi.stubGlobal("RTCPeerConnection", FakePC as unknown as typeof RTCPeerConnection);
  // jsdom's media play() is a not-implemented stub that returns undefined, which would blow up the
  // hook's `audio.play().catch(...)` when an audio track arrives.
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined) as never;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useAvatarStream ICE gathering gate", () => {
  it("sends the offer shortly after the first relay candidate instead of waiting out the 8s cap", async () => {
    // Networks with VPN/mDNS interfaces often never signal gathering "complete" — the old gate
    // then stalled EVERY avatar connect for the full 8s safety timeout (issue 5, measured live).
    // Azure's avatar path runs over its TURN relay, so one relay candidate is enough to proceed.
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn();
    const { result } = renderHook(() => useAvatarStream(videoRef));

    await act(async () => {
      void result.current.connect([{ urls: "turn:relay.example.com" }], sendOffer);
    });
    await flush(); // createOffer + setLocalDescription resolve

    // A host candidate alone must NOT open the fast path (it can't reach Azure's TURN relay).
    await act(async () => {
      FakePC.instances[0].emitCandidate(
        "candidate:1 1 udp 2122260223 192.168.1.2 50000 typ host generation 0",
      );
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(sendOffer).not.toHaveBeenCalled();

    // First relay candidate → 300ms settle window → offer goes out, no gathering-complete needed.
    await act(async () => {
      FakePC.instances[0].emitCandidate(
        "candidate:2 1 udp 41885439 20.1.2.3 3478 typ relay raddr 0.0.0.0 rport 0 generation 0",
      );
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(sendOffer).toHaveBeenCalledTimes(1);

    // Late gathering-complete must not send a second offer.
    await act(async () => {
      FakePC.instances[0].completeGathering();
      await Promise.resolve();
    });
    expect(sendOffer).toHaveBeenCalledTimes(1);
  });
});

describe("useAvatarStream self-heal", () => {
  /** Render with a recorder standing in for `useInterviewVoice`, which answers a request by rebuilding
   * the whole Voice Live session (here: the test calls connect() again). */
  function renderWithConsumer(videoRef: ReturnType<typeof makeVideoRef>) {
    const requests: string[] = [];
    const { result } = renderHook(() =>
      useAvatarStream(videoRef, { onModeSwitchRequest: (next) => requests.push(next) }),
    );
    return { result, requests };
  }

  /** Connect a new session on a new PC and complete its handshake; returns that PC. */
  async function newSession(result: { current: ReturnType<typeof useAvatarStream> }, sendOffer: ReturnType<typeof vi.fn>) {
    const before = FakePC.instances.length;
    await act(async () => {
      void result.current.connect([{ urls: "stun:stun.example.com" }], sendOffer);
    });
    const pc = FakePC.instances[before];
    await completeHandshake(pc, result.current.handleServerSdp);
    return pc;
  }

  it("asks for a session rebuild in the same mode on ICE failed, never re-offering on the live session", async () => {
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn();
    const { result, requests } = renderWithConsumer(videoRef);
    const pc = await newSession(result, sendOffer);
    expect(sendOffer).toHaveBeenCalledTimes(1);

    await act(async () => {
      pc.fireIce("failed");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(requests).toEqual(["video"]);
    expect(pc.closed).toBe(true); // the dead media is torn down
    // The bug: a second `session.avatar.connect` on the same session, which Azure refuses.
    expect(FakePC.instances, "no new PeerConnection on the old session").toHaveLength(1);
    expect(sendOffer, "no re-offer on the old session").toHaveBeenCalledTimes(1);
    expect(result.current.isConnected).toBe(false);
  });

  it("does NOT rebuild on a transient disconnected that self-heals within the grace window", async () => {
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn();
    const { result, requests } = renderWithConsumer(videoRef);
    const pc = await newSession(result, sendOffer);

    // Transient blip: disconnected then back to connected before the 3s grace expires.
    await act(async () => {
      pc.fireIce("disconnected");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      pc.fireIce("connected"); // recovered on its own
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000); // well past the grace window
    });

    // No rebuild — the orb never flashed.
    expect(requests).toEqual([]);
    expect(pc.closed).toBe(false);
  });

  it("cancels a pending rebuild when disconnect() is called", async () => {
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn();
    const { result, requests } = renderWithConsumer(videoRef);
    const pc = await newSession(result, sendOffer);

    // A drop inside its grace window; disconnect() before it expires must abort the rebuild.
    await act(async () => {
      pc.fireIce("disconnected");
    });
    await act(async () => {
      result.current.disconnect();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(requests).toEqual([]); // no zombie rebuild
  });

  it("bounds the self-heal across rebuilt sessions: video once more, then audio-only, then the orb", async () => {
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn();
    const { result, requests } = renderWithConsumer(videoRef);

    // The 2026-10-14 production shape: ICE never connects on any session (the audio track still
    // arrives with the answer, which must not count as media flowing).
    const failNext = async () => {
      const pc = await newSession(result, sendOffer);
      await act(async () => {
        pc.emitTrack("audio");
        pc.fireIce("failed");
        await vi.advanceTimersByTimeAsync(0);
      });
      return pc;
    };

    await failNext();
    expect(requests).toEqual(["video"]);

    // A WS reconnect tears the media down between sessions; the count must survive it, or Azure ending
    // the stream would hand every session a fresh budget and never stop.
    act(() => {
      result.current.disconnect();
    });
    await failNext();
    expect(requests).toEqual(["video", "audio-only"]);
    expect(result.current.mediaMode).toBe("audio-only");

    const audioPc = await failNext();
    expect(audioPc.transceivers.find((t) => t.kind === "video")?.direction).toBe("inactive");
    expect(requests, "the fallback session was audio-only's one retry: the orb, no fourth session").toEqual([
      "video",
      "audio-only",
    ]);
    expect(sendOffer, "three avatar sessions — Azure's whole allowance").toHaveBeenCalledTimes(3);
    expect(result.current.isConnected).toBe(false);
  });

  it("holds a rebuild until Azure's avatar allowance has room, instead of creating a session it refuses", async () => {
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn();
    const { result, requests } = renderWithConsumer(videoRef);
    // Spend the allowance (3 sessions inside the window), with the last one dropping.
    await newSession(result, sendOffer);
    await newSession(result, sendOffer);
    const third = await newSession(result, sendOffer);
    await act(async () => {
      third.fireIce("failed");
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(requests, "a fourth session now would be refused at creation").toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(requests, "a delay, not a silent drop").toEqual(["video"]);
  });

  it("treats a rebuilt session whose handshake never completes as the next failure, not the end", async () => {
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn();
    const { result, requests } = renderWithConsumer(videoRef);
    const first = await newSession(result, sendOffer);
    await act(async () => {
      first.fireIce("failed");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(requests).toEqual(["video"]);

    // The rebuilt session's offer is never answered (refused, or lost): the 15 s SDP timeout rejects it.
    await act(async () => {
      void result.current.connect([{ urls: "stun:stun.example.com" }], sendOffer).catch(() => undefined);
    });
    await flush();
    await act(async () => {
      FakePC.instances[1].completeGathering();
      await vi.advanceTimersByTimeAsync(16_000);
    });
    expect(requests, "stranding the orb on a live session was the old failure").toEqual(["video", "audio-only"]);
  });

  it("recovers a later drop on a connection it had given up on, once that connection came back", async () => {
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn();
    const { result, requests } = renderWithConsumer(videoRef);
    act(() => {
      result.current.setVideoPreference("off"); // audio-only from the start
    });
    const audio1 = await newSession(result, sendOffer);
    await act(async () => {
      audio1.fireIce("failed");
      await vi.advanceTimersByTimeAsync(0);
    });
    const audio2 = await newSession(result, sendOffer);
    await act(async () => {
      audio2.fireIce("failed"); // second audio-only failure: the orb
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(requests).toEqual(["audio-only"]);

    // The connection it gave up on comes back on its own, then genuinely drops later.
    await act(async () => {
      audio2.fireIce("connected");
      audio2.fireIce("failed");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(requests, "a stuck recovering flag used to swallow this drop").toEqual(["audio-only", "audio-only"]);
  });

  it("gives a later independent drop a fresh budget once frames have painted", async () => {
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn();
    const { result, requests } = renderWithConsumer(videoRef);

    const first = await newSession(result, sendOffer);
    await act(async () => {
      first.fireIce("failed");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(requests).toEqual(["video"]);

    // The rebuilt session paints real frames: that drop is over.
    const second = await newSession(result, sendOffer);
    Object.assign(videoRef.current!, { videoWidth: 640, videoHeight: 360 });
    await act(async () => {
      second.fireIce("connected");
      second.emitTrack("video");
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(result.current.isConnected).toBe(true);

    await act(async () => {
      second.fireIce("failed");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(requests, "a fresh drop retries in video, not straight to audio-only").toEqual(["video", "video"]);
  });
});

describe("useAvatarStream weak-network adaptation", () => {
  /** Cumulative inbound counters; one "step" is one 2 s sampling window. */
  function counters() {
    return { concealed: 0, totalSamples: 0, framesDecoded: 0, videoBytes: 0 };
  }
  /** A good window: audio arrives nearly intact and frames decode. */
  function healthyStep(c: ReturnType<typeof counters>) {
    c.totalSamples += 96_000;
    c.concealed += 100;
    c.framesDecoded += 50;
    c.videoBytes += 250_000;
    return statsRows(c);
  }
  /** The measured 1080p failure: ~1 Mbps of video arriving, not a single frame decoded. */
  function wastingStep(c: ReturnType<typeof counters>) {
    c.totalSamples += 96_000;
    c.concealed += 100;
    c.videoBytes += 250_000; // frames NOT advanced
    return statsRows(c);
  }
  /** Audio-only: no video counters move at all, and the voice is clean. */
  function audioOnlyStep(c: ReturnType<typeof counters>) {
    c.totalSamples += 96_000;
    c.concealed += 100;
    return statsRows(c);
  }

  async function tick(pc: FakePC, rows: Record<string, unknown>[]) {
    pc.statsRows = rows;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(T.SAMPLE_INTERVAL_MS);
    });
  }

  /** Render with a recorder for the mode-switch requests. Azure refuses to renegotiate an avatar
   * connection on a live session, so the hook can only ASK for a rebuild; `useInterviewVoice` answers
   * by reconnecting the whole Voice Live session. These tests stand in for that consumer. */
  function renderStream(videoRef: ReturnType<typeof makeVideoRef>) {
    const requests: string[] = [];
    const { result } = renderHook(() =>
      useAvatarStream(videoRef, { onModeSwitchRequest: (next) => requests.push(next) }),
    );
    return { result, requests };
  }

  /** Bring a fresh connection all the way live: offer out, answer applied, ICE up, tracks delivered. */
  async function bringUp(
    result: { current: ReturnType<typeof useAvatarStream> },
    sendOffer: ReturnType<typeof vi.fn>,
    pcIndex: number,
  ) {
    await act(async () => {
      void result.current.connect([{ urls: "turn:relay.example.com" }], sendOffer);
    });
    const pc = FakePC.instances[pcIndex];
    await completeHandshake(pc, result.current.handleServerSdp);
    await act(async () => {
      pc.fireIce("connected");
      pc.emitTrack("audio");
    });
    return pc;
  }

  it("offers video recvonly on a normal connect and keeps it while the link is healthy", async () => {
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn();
    const { result, requests } = renderStream(videoRef);
    const pc = await bringUp(result, sendOffer, 0);

    expect(pc.transceivers).toEqual([
      { kind: "video", direction: "recvonly" },
      { kind: "audio", direction: "recvonly" },
    ]);

    const c = counters();
    for (let i = 0; i < 10; i++) await tick(pc, healthyStep(c));

    expect(requests).toEqual([]); // nothing to change on a good link
    expect(FakePC.instances).toHaveLength(1);
    expect(result.current.mediaMode).toBe("video");
  });

  it("asks for a session rebuild — never a live re-offer — when the picture stops decoding", async () => {
    // Bytes in, zero frames out: the picture is pure waste and is starving the voice. Re-offering on the
    // live session would be refused by Azure ("WebRTC connection is in connected state"), so the hook
    // must tear its media down and delegate the rebuild upward instead.
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn();
    const { result, requests } = renderStream(videoRef);
    const pc = await bringUp(result, sendOffer, 0);

    const c = counters();
    for (let i = 0; i <= T.BAD_WINDOWS; i++) await tick(pc, wastingStep(c));

    expect(requests).toEqual(["audio-only"]);
    expect(FakePC.instances).toHaveLength(1); // no in-place rebuild
    expect(pc.closed).toBe(true); // …and the wasteful video stream is stopped immediately
    expect(sendOffer).toHaveBeenCalledTimes(1);
    expect(result.current.mediaMode).toBe("audio-only");
    expect(result.current.isConnected).toBe(false);
  });

  it("offers video INACTIVE on the rebuilt session, and treats the audio track as ready", async () => {
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn();
    const { result, requests } = renderStream(videoRef);
    const pc = await bringUp(result, sendOffer, 0);

    const c = counters();
    for (let i = 0; i <= T.BAD_WINDOWS; i++) await tick(pc, wastingStep(c));
    expect(requests).toEqual(["audio-only"]);

    // The consumer reconnects (what useInterviewVoice.restartForMediaMode does).
    const audioPc = await bringUp(result, sendOffer, 1);

    expect(audioPc.transceivers).toEqual([
      { kind: "video", direction: "inactive" },
      { kind: "audio", direction: "recvonly" },
    ]);
    // Nothing paints, so the orb stays — but the read gate must be released by the live audio track,
    // otherwise every audio-only question sits out the full 6 s gate in silence.
    expect(result.current.isConnected).toBe(false);
    expect(result.current.isMediaReady).toBe(true);
  });

  it("does NOT drop the picture on concealment alone while the video decodes fine", async () => {
    // Asserted the opposite until 2026-09-30. The calibration run measured the audible ratio at 16.9%
    // when the policy decided to downgrade under 3% loss, and 17.0-19.3% on the same link with the
    // shaping removed — the signal's damaged range sits inside its healthy range, so it cannot justify
    // taking the picture away. `USE_VOICE_DAMAGE_TRIGGER` is false; the threshold-free video trigger is
    // what protects the interview. Re-enabling needs a metric that separates the conditions (TODOS.md).
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn();
    const { result, requests } = renderStream(videoRef);
    const pc = await bringUp(result, sendOffer, 0);

    const c = counters();
    for (let i = 0; i <= T.BAD_WINDOWS + 2; i++) {
      c.totalSamples += 96_000;
      c.concealed += 30_000; // a third of the audio synthesised, and none of it silent
      c.framesDecoded += 50; // …but the picture is perfectly fine
      c.videoBytes += 250_000;
      await tick(pc, statsRows(c));
    }

    expect(requests, "concealment alone must not cost the candidate the picture").toEqual([]);
    expect(result.current.mediaMode).toBe("video");
  });

  it("honours a preference pinned BEFORE the first connect", async () => {
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn();
    const { result } = renderStream(videoRef);

    await act(async () => {
      result.current.setVideoPreference("off");
    });
    expect(result.current.mediaMode).toBe("audio-only");

    await act(async () => {
      void result.current.connect([{ urls: "turn:relay.example.com" }], sendOffer);
    });
    expect(FakePC.instances[0].transceivers[0]).toEqual({ kind: "video", direction: "inactive" });
  });

  it("asks to restore the picture once the link has been healthy for the full hold", async () => {
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn();
    const { result, requests } = renderStream(videoRef);
    const pc = await bringUp(result, sendOffer, 0);

    const c = counters();
    for (let i = 0; i <= T.BAD_WINDOWS; i++) await tick(pc, wastingStep(c));
    expect(requests).toEqual(["audio-only"]);

    const audioPc = await bringUp(result, sendOffer, 1);
    const windows =
      Math.ceil(Math.max(T.INITIAL_HEALTHY_HOLD_MS, T.MIN_AFTER_DOWNGRADE_MS) / T.SAMPLE_INTERVAL_MS) + 3;
    const c2 = counters();
    for (let i = 0; i < windows; i++) await tick(audioPc, audioOnlyStep(c2));

    expect(requests).toEqual(["audio-only", "video"]);
    expect(result.current.mediaMode).toBe("video");

    // And the rebuilt session asks for the picture again.
    const videoPc = await bringUp(result, sendOffer, 2);
    expect(videoPc.transceivers[0]).toEqual({ kind: "video", direction: "recvonly" });
  });

  it("retries a restore the actuator vetoed, instead of recording one that never happened", async () => {
    // Production has a gap the test above does not reproduce: the policy's cooldown is measured from
    // the moment it DECIDES to downgrade, while the actuator's is measured from when the REBUILT
    // session connects — about five seconds later. So the first restore decision is always slightly
    // early and `switchMediaMode` vetoes it. Before the fix `reduceHealth` had already recorded the
    // mode as "video", and from the video branch an audio-only session can never satisfy a downgrade
    // trigger (no video bytes to be wasted, no voice being concealed), so nothing ever asked again.
    // Measured live 2026-09-30: the picture did not come back in 225 s. Deterministic, not a race.
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn();
    const { result, requests } = renderStream(videoRef);
    const pc = await bringUp(result, sendOffer, 0);

    const c = counters();
    for (let i = 0; i <= T.BAD_WINDOWS; i++) await tick(pc, wastingStep(c));
    expect(requests).toEqual(["audio-only"]);
    const decidedAt = Date.now();

    // The rebuilt session lands later than the decision, as it does live (~5 s of teardown + connect).
    const REBUILD_LAG_MS = 6_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REBUILD_LAG_MS);
    });
    const audioPc = await bringUp(result, sendOffer, 1);
    const connectedAt = Date.now();

    // When each side is willing: the policy from the decision, the actuator from the connect.
    const policyAllowsAt = decidedAt + Math.max(T.MIN_AFTER_DOWNGRADE_MS, T.INITIAL_HEALTHY_HOLD_MS);
    const actuatorAllowsAt = connectedAt + T.VIDEO_SWITCH_MIN_INTERVAL_MS;
    expect(
      actuatorAllowsAt - policyAllowsAt,
      "this test only means something while the actuator is stricter than the policy — if a threshold " +
        "change closed that gap, delete the test rather than let it pass vacuously",
    ).toBeGreaterThan(T.SAMPLE_INTERVAL_MS);

    // Walk to one window PAST the policy's allowance: it has decided to restore and been refused.
    const c2 = counters();
    while (Date.now() < policyAllowsAt + T.SAMPLE_INTERVAL_MS) await tick(audioPc, audioOnlyStep(c2));
    expect(requests, "the actuator refused, so no rebuild was requested").toEqual(["audio-only"]);
    expect(
      result.current.mediaMode,
      "and the policy must not claim the picture is back when the media is still audio-only",
    ).toBe("audio-only");

    // Past the actuator's allowance it must ask again — the veto was "not yet", not "no".
    while (Date.now() < actuatorAllowsAt + T.SAMPLE_INTERVAL_MS) await tick(audioPc, audioOnlyStep(c2));
    expect(requests, "once the cooldown passes the picture must be asked for again").toEqual([
      "audio-only",
      "video",
    ]);
    expect(result.current.mediaMode).toBe("video");
  });

  it("keeps the picture off for the whole session when the candidate pinned it off", async () => {
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn();
    const { result, requests } = renderStream(videoRef);
    await bringUp(result, sendOffer, 0);

    await act(async () => {
      result.current.setVideoPreference("off");
    });
    expect(requests).toEqual(["audio-only"]);
    expect(result.current.mediaMode).toBe("audio-only");

    const audioPc = await bringUp(result, sendOffer, 1);
    expect(audioPc.transceivers[0]).toEqual({ kind: "video", direction: "inactive" });

    // A long, perfectly healthy stretch must NOT hand the picture back — the human decided.
    const windows = Math.ceil((T.INITIAL_HEALTHY_HOLD_MS * 3) / T.SAMPLE_INTERVAL_MS);
    const c = counters();
    for (let i = 0; i < windows; i++) await tick(audioPc, audioOnlyStep(c));

    expect(requests).toEqual(["audio-only"]); // no restore request
    expect(result.current.videoPreference).toBe("off");
  });

  it('retries a pin the cooldown refused, so "turn the picture on" is not silently dropped', async () => {
    // `setVideoPreference("on")` records the preference and then asks the actuator, which vetoes while
    // the cooldown is live. `reduceHealth` short-circuits on any non-"auto" preference, so before the
    // fix nothing ever asked again and the candidate's request was dropped for the rest of the session.
    // The UI's own gate usually stops a human reaching this, but that gate only knows about the 60 s
    // cooldown while the actuator also enforces Azure's request allowance, so the two can disagree.
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn();
    const { result, requests } = renderStream(videoRef);
    await bringUp(result, sendOffer, 0);

    // Pin OFF first: dropping the picture is never vetoed.
    await act(async () => {
      result.current.setVideoPreference("off");
    });
    expect(requests).toEqual(["audio-only"]);
    const audioPc = await bringUp(result, sendOffer, 1);

    // Ask for it back at once. The rebuilt session restarted the cooldown, so this is refused.
    await act(async () => {
      result.current.setVideoPreference("on");
    });
    expect(requests, "refused while the cooldown is live").toEqual(["audio-only"]);
    expect(result.current.videoPreference, "but the intent is on record").toBe("on");
    expect(result.current.mediaMode).toBe("audio-only");

    // Let sampling windows pass. Once the cooldown expires the pin must be honoured with no further
    // input from the candidate.
    const windows = Math.ceil(T.VIDEO_SWITCH_MIN_INTERVAL_MS / T.SAMPLE_INTERVAL_MS) + 3;
    const c = counters();
    for (let i = 0; i < windows; i++) await tick(audioPc, audioOnlyStep(c));

    expect(requests, "the pin must be retried, not forgotten").toEqual(["audio-only", "video"]);
    expect(result.current.mediaMode).toBe("video");
  });

  it("keeps the audio-only mode through a media drop, and does not spend the self-heal budget on the switch", async () => {
    // A policy switch is not a failure: the rebuilt session must still get its self-heal rebuild. And a
    // link that just proved it can't carry video must not get the picture back via recovery.
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn();
    const { result, requests } = renderStream(videoRef);
    const pc = await bringUp(result, sendOffer, 0);

    const c = counters();
    for (let i = 0; i <= T.BAD_WINDOWS; i++) await tick(pc, wastingStep(c));
    expect(requests).toEqual(["audio-only"]);

    const audioPc = await bringUp(result, sendOffer, 1);
    expect(FakePC.instances).toHaveLength(2);

    // Now break the media for real.
    await act(async () => {
      audioPc.fireIce("failed");
      await vi.advanceTimersByTimeAsync(0);
    });

    // A consumed budget would show the orb here and ask for nothing.
    expect(requests).toEqual(["audio-only", "audio-only"]);
    const rebuilt = await bringUp(result, sendOffer, 2);
    expect(rebuilt.transceivers[0]).toEqual({ kind: "video", direction: "inactive" });
  });

});
