/**
 * Regression guard for the AVATAR RATE-LIMIT allowance (TODOS.md, filed from the v0.40.0.0 review).
 *
 * Azure rate-limits avatar session creation — a third `session.avatar.connect` inside roughly 20 s was
 * refused with `"Avatar request was rate-limited. Retry after 43.0s."` (measured 2026-09-30). Two
 * consequences the self-heal path used to get wrong:
 *
 *   1. Its backoffs were 500/1500/3000 ms, so all three attempts landed inside ~5 s and the third was
 *      spent on a request Azure would never honour.
 *   2. When the budget ran out it showed the orb and stopped. That STRANDED the session: the stats
 *      sampler dies with the connection, so the weak-network policy could not act either, and the
 *      candidate finished the interview picture-less with no automatic way back.
 *
 * These tests drive a fast-failing handshake (the WS send throws) so the attempt chain is observable in
 * virtual time without waiting out the 15 s SDP timeout per attempt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useAvatarStream } from "./useAvatarStream";

const ICE_SERVERS = [{ urls: "stun:stun.example.com" }];
/** Mirrors the module constants under test. Kept local on purpose: if someone widens the allowance in
 * the hook, these tests should fail and make them re-justify it against the measurement. */
const WINDOW_MS = 20_000;

class FakePC {
  static instances: FakePC[] = [];
  iceConnectionState = "new";
  connectionState = "new";
  iceGatheringState = "new";
  localDescription: { sdp: string } | null = null;
  closed = false;
  onicecandidate: ((e: { candidate: RTCIceCandidate | null }) => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  transceivers: { kind: string; direction: string }[] = [];
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
  async setRemoteDescription() {}
  close() {
    this.closed = true;
  }
  completeGathering() {
    this.iceGatheringState = "complete";
    this.onicecandidate?.({ candidate: null });
  }
  fireIce(state: string) {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }
}

function makeVideoRef() {
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

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Answer the offer, so the session is genuinely live before a test drops it. */
async function answerHandshake(handleServerSdp: (raw: string) => void) {
  await act(async () => {
    handleServerSdp(btoa(JSON.stringify({ type: "answer", sdp: "fake-answer-sdp" })));
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Let the newest PC reach the point where the offer is sent. */
async function pushOfferOut() {
  await flush();
  await act(async () => {
    FakePC.instances.forEach((pc) => {
      if (!pc.closed && pc.localDescription) pc.completeGathering();
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  FakePC.instances = [];
  vi.stubGlobal("RTCPeerConnection", FakePC as unknown as typeof RTCPeerConnection);
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined) as never;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("avatar rate-limit allowance", () => {
  it("holds a self-heal attempt until Azure would accept it, instead of spending it on a refusal", async () => {
    const videoRef = makeVideoRef();
    // First offer succeeds; every later one throws, so each rebuild fails immediately and the next
    // attempt is scheduled in the same virtual instant. That isolates the BACKOFF decision, which is
    // what this test is about, from the 15 s SDP timeout.
    let calls = 0;
    const sendOffer = vi.fn(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve();
      return Promise.reject(new Error("ws send failed"));
    });

    const { result } = renderHook(() => useAvatarStream(videoRef));
    await act(async () => {
      void result.current.connect(ICE_SERVERS, sendOffer);
    });
    await pushOfferOut();
    await answerHandshake(result.current.handleServerSdp);
    expect(sendOffer).toHaveBeenCalledTimes(1); // one request on the ledger

    // Drop the media. Attempt 1 is inside the allowance (1 request so far), so it runs at its table
    // backoff of 500 ms and becomes request 2.
    await act(async () => {
      FakePC.instances[0].fireIce("failed");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    await pushOfferOut();
    expect(sendOffer).toHaveBeenCalledTimes(2);

    // Attempt 2's table backoff is 1500 ms, but the allowance is now spent (2 requests inside the
    // window), so the attempt MUST wait for the first request to age out instead. Before the fix a
    // third offer went out here and Azure refused it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await pushOfferOut();
    expect(
      sendOffer,
      "a third avatar offer inside the rate-limit window would be refused, so it must not be sent",
    ).toHaveBeenCalledTimes(2);

    // Once the window has passed, the attempt proceeds.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WINDOW_MS);
    });
    await pushOfferOut();
    expect(sendOffer.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("asks for audio-only when video self-heal is exhausted, rather than stranding the session", async () => {
    const videoRef = makeVideoRef();
    let calls = 0;
    const sendOffer = vi.fn(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve();
      return Promise.reject(new Error("ws send failed"));
    });
    const modeSwitches: string[] = [];

    const { result } = renderHook(() =>
      useAvatarStream(videoRef, { onModeSwitchRequest: (next) => modeSwitches.push(next) }),
    );
    await act(async () => {
      void result.current.connect(ICE_SERVERS, sendOffer);
    });
    await pushOfferOut();
    await answerHandshake(result.current.handleServerSdp);

    await act(async () => {
      FakePC.instances[0].fireIce("failed");
    });
    // Walk far enough for all three attempts (each now spaced by the allowance) plus the downgrade.
    for (let i = 0; i < 12; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WINDOW_MS);
      });
      await pushOfferOut();
      if (modeSwitches.length > 0) break;
    }

    expect(modeSwitches, "an exhausted video self-heal must fall back to the mode the link can carry").toEqual([
      "audio-only",
    ]);
    expect(result.current.mediaMode).toBe("audio-only");
  });

  it("does not bounce modes: an exhausted AUDIO-ONLY self-heal shows the orb and asks for nothing", async () => {
    const videoRef = makeVideoRef();
    let calls = 0;
    const sendOffer = vi.fn(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve();
      return Promise.reject(new Error("ws send failed"));
    });
    const modeSwitches: string[] = [];

    const { result } = renderHook(() =>
      useAvatarStream(videoRef, { onModeSwitchRequest: (next) => modeSwitches.push(next) }),
    );
    // Pin audio-only BEFORE connecting, so the session comes up without a picture to lose.
    act(() => {
      result.current.setVideoPreference("off");
    });
    await act(async () => {
      void result.current.connect(ICE_SERVERS, sendOffer);
    });
    await pushOfferOut();
    await answerHandshake(result.current.handleServerSdp);
    expect(FakePC.instances[0].transceivers.find((t) => t.kind === "video")?.direction).toBe("inactive");

    await act(async () => {
      FakePC.instances[0].fireIce("failed");
    });
    for (let i = 0; i < 12; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WINDOW_MS);
      });
      await pushOfferOut();
    }

    expect(modeSwitches, "there is no lighter mode to fall back to — the orb is the honest answer").toEqual([]);
    expect(result.current.isConnected).toBe(false);
  });
});
