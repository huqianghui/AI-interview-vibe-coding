/**
 * The avatar handshake's timing record (`voice.avatar`, voiceTimeline.ts) is wired to the real hook:
 * one event per peer connection, with the outcome that actually ended it, the STUN / TURN / SDP /
 * ICE / first-frame timings and the selected candidate pair. The rules themselves are unit-tested in
 * voiceTimeline.test.ts; this pins the WIRING, the part that can silently not land.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const tracked: { name: string; m: Record<string, number>; p: Record<string, unknown> }[] = [];
vi.mock("../telemetry/appInsights", () => ({
  trackEvent: (name: string, m: Record<string, number>, p: Record<string, unknown>) =>
    tracked.push({ name, m, p }),
}));

import { useAvatarStream } from "./useAvatarStream";
import { voiceMetrics } from "../telemetry/voiceTimeline";

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
  emitTrack(kind: "audio" | "video", receiver?: unknown) {
    const track = { kind, onended: null } as unknown as MediaStreamTrack;
    this.ontrack?.({ track, receiver, streams: [{ id: `${kind}-stream` } as unknown as MediaStream] });
  }
  fireConnection(state: string) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
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
  // performance.now() too: every timing here is read from it.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  FakePC.instances = [];
  tracked.length = 0;
  vi.stubGlobal("RTCPeerConnection", FakePC as unknown as typeof RTCPeerConnection);
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined) as never;
  // performance.now() too: every timing here is read from it.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const avatarEvents = () => tracked.filter((e) => e.name === "voice.avatar");

const SELECTED_RELAY_PAIR = [
  { id: "T", type: "transport", selectedCandidatePairId: "P" },
  { id: "P", type: "candidate-pair", localCandidateId: "L", remoteCandidateId: "R", currentRoundTripTime: 0.05 },
  { id: "L", type: "local-candidate", candidateType: "relay", protocol: "udp", relayProtocol: "udp" },
  { id: "R", type: "remote-candidate", candidateType: "relay" },
];

async function connected(videoRef = makeVideoRef()) {
  const sendOffer = vi.fn();
  const hook = renderHook(() => useAvatarStream(videoRef));
  await act(async () => {
    void hook.result.current.connect([{ urls: "turn:relay.example.com" }], sendOffer);
  });
  await flush();
  return { ...hook, videoRef, pc: FakePC.instances[0] };
}

describe("voice.avatar wiring", () => {
  it("sends one event when the first frame paints, with candidate, signalling and ICE timings", async () => {
    const { result, videoRef, pc } = await connected();
    await act(async () => {
      pc.emitCandidate("candidate:1 1 udp 2122260223 192.168.1.2 50000 typ host generation 0");
      await vi.advanceTimersByTimeAsync(20);
      pc.emitCandidate("candidate:2 1 udp 1686052607 20.1.1.1 50001 typ srflx raddr 0.0.0.0 rport 0");
      await vi.advanceTimersByTimeAsync(40);
      pc.emitCandidate("candidate:3 1 udp 41885439 20.1.2.3 3478 typ relay raddr 0.0.0.0 rport 0");
    });
    await completeHandshake(pc, result.current.handleServerSdp);
    pc.statsRows = SELECTED_RELAY_PAIR;
    await act(async () => {
      pc.fireIce("checking");
      pc.fireIce("connected");
      await Promise.resolve();
    });
    // The picture arrives and paints.
    Object.assign(videoRef.current, { videoWidth: 640, videoHeight: 360 });
    await act(async () => {
      pc.emitTrack("video");
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(avatarEvents()).toHaveLength(1);
    const [event] = avatarEvents();
    expect(event.p).toMatchObject({ label: "initial", video: true, outcome: "frame", local_candidate: "relay" });
    expect(Object.keys(event.m)).toEqual(
      expect.arrayContaining([
        "create_offer_ms",
        "first_host_ms",
        "stun_srflx_ms",
        "turn_relay_ms",
        "ice_gather_ms",
        "sdp_answer_ms",
        "ice_connect_ms",
        "first_frame_ms",
        "total_ms",
      ]),
    );
    expect(event.m.stun_srflx_ms).toBeGreaterThan(event.m.first_host_ms);
    expect(event.m.rtt_ms).toBe(50);

    // A later teardown does not send the same handshake twice.
    await act(async () => {
      result.current.disconnect();
      await Promise.resolve();
    });
    expect(avatarEvents()).toHaveLength(1);
  });

  it("ends the record with ice_failed, and the recovery rebuild gets a record of its own", async () => {
    const { result, pc } = await connected();
    await completeHandshake(pc, result.current.handleServerSdp);
    await act(async () => {
      pc.fireIce("failed");
      await Promise.resolve();
    });
    expect(avatarEvents().map((e) => e.p.outcome)).toEqual(["ice_failed"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600); // the recovery rebuild
    });
    expect(FakePC.instances).toHaveLength(2);
    await act(async () => {
      result.current.disconnect();
      await Promise.resolve();
    });
    expect(avatarEvents().map((e) => [e.p.label, e.p.outcome])).toEqual([
      ["initial", "ice_failed"],
      ["recovery", "closed"],
    ]);
  });

  it("ends an unfinished record with rebuilt when a recovery replaces its connection", async () => {
    const { result, pc } = await connected();
    await completeHandshake(pc, result.current.handleServerSdp);
    await act(async () => {
      pc.fireIce("connected");
      pc.fireIce("disconnected"); // never comes back: the grace window expires and it rebuilds
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(FakePC.instances.length).toBeGreaterThan(1);
    expect(avatarEvents()[0].p).toMatchObject({ label: "initial", outcome: "rebuilt" });
  });

  it("reports a connection that has ICE but never paints as no_frame", async () => {
    const { result, pc } = await connected();
    await completeHandshake(pc, result.current.handleServerSdp);
    await act(async () => {
      pc.fireIce("connected");
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(avatarEvents().map((e) => e.p.outcome)).toEqual(["no_frame"]);
  });

  it("times the interviewer's audio onsets on the avatar track, and stops on teardown", async () => {
    const turn = vi.spyOn(voiceMetrics, "turn");
    const { result, pc } = await connected();
    await completeHandshake(pc, result.current.handleServerSdp);
    let level = 0;
    const receiver = { getSynchronizationSources: () => [{ audioLevel: level }] };
    await act(async () => {
      pc.emitTrack("audio", receiver);
      await vi.advanceTimersByTimeAsync(400);
    });
    level = 0.4;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(turn).toHaveBeenCalledWith("first_audible");
    const calls = turn.mock.calls.length;
    await act(async () => {
      result.current.disconnect();
      level = 0;
      await vi.advanceTimersByTimeAsync(400);
      level = 0.4;
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(turn.mock.calls.length).toBe(calls);
  });

  it("samples WebRTC quality from the health sampler's stats while the call runs (voice.media)", async () => {
    const { result, pc } = await connected();
    await completeHandshake(pc, result.current.handleServerSdp);
    let frames = 0;
    let bytes = 0;
    const rows = () => [
      { id: "A", type: "inbound-rtp", kind: "audio", packetsReceived: frames * 2, packetsLost: 0, totalSamplesReceived: frames * 1920 },
      { id: "V", type: "inbound-rtp", kind: "video", framesDecoded: frames, bytesReceived: bytes },
      ...SELECTED_RELAY_PAIR,
    ];
    pc.statsRows = rows();
    await act(async () => {
      pc.fireIce("connected"); // starts the health sampler
      await Promise.resolve();
    });
    for (let i = 0; i < 10; i++) {
      frames += 50; // 25 fps over each 2 s tick
      bytes += 500_000;
      pc.statsRows = rows();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
    }
    const media = tracked.filter((e) => e.name === "voice.media");
    expect(media.length).toBeGreaterThan(0);
    expect(media[0].m.video_fps).toBe(25);
    expect(media[0].m.rtt_ms).toBe(50);
    expect(media[0].p).toMatchObject({ mode: "video", window_index: 0 });
  });
});

