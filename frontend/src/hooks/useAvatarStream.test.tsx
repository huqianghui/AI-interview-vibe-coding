/**
 * Regression guard for the avatar media-layer SELF-HEAL (数字人掉成球且回不来).
 *
 * The avatar's video/audio ride a SEPARATE RTCPeerConnection from the main Voice Live WS, so the
 * WS-close reconnect in useInterviewVoice does NOT cover an avatar-only media drop. Before the fix,
 * `oniceconnectionstatechange` only logged and `track.onended` flipped straight to the orb with no
 * path back — one media blip meant orb for the rest of the session.
 *
 * These tests drive a controllable fake RTCPeerConnection through the drop signals and assert:
 *   1. ICE `failed` → the hook rebuilds the PC and re-runs the handshake (a 2nd offer is sent).
 *   2. A transient ICE `disconnected` that returns to `connected` within the grace window does NOT
 *      rebuild (no reconnect storm, no orb flash).
 *   3. `disconnect()` cancels a pending rebuild (no zombie handshake after teardown).
 *   4. The recovery budget is bounded: repeated failed rebuilds stop after MAX_RECOVERY_ATTEMPTS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

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

  constructor(public config: RTCConfiguration) {
    FakePC.instances.push(this);
  }
  addTransceiver() {}
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
}

function makeVideoRef() {
  // attachStream only runs when a video track arrives (we don't fire ontrack here), so a bare
  // srcObject-holder is enough for connect()'s `videoRef.current.srcObject = null` writes.
  return { current: { srcObject: null } as unknown as HTMLVideoElement };
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
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useAvatarStream self-heal", () => {
  it("rebuilds the avatar connection and re-handshakes on ICE failed", async () => {
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn();
    const { result } = renderHook(() => useAvatarStream(videoRef));

    await act(async () => {
      void result.current.connect([{ urls: "stun:stun.example.com" }], sendOffer);
    });
    await completeHandshake(FakePC.instances[0], result.current.handleServerSdp);
    expect(FakePC.instances).toHaveLength(1);
    expect(sendOffer).toHaveBeenCalledTimes(1);

    // ICE fails → immediate recovery scheduled (500ms backoff for attempt #1).
    await act(async () => {
      FakePC.instances[0].fireIce("failed");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600); // fire the recovery timer → rebuild
    });
    expect(FakePC.instances).toHaveLength(2);
    expect(FakePC.instances[0].closed).toBe(true); // old PC torn down

    // The rebuilt PC re-runs the full handshake → a 2nd offer goes out.
    await completeHandshake(FakePC.instances[1], result.current.handleServerSdp);
    expect(sendOffer).toHaveBeenCalledTimes(2);
  });

  it("does NOT rebuild on a transient disconnected that self-heals within the grace window", async () => {
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn();
    const { result } = renderHook(() => useAvatarStream(videoRef));

    await act(async () => {
      void result.current.connect([{ urls: "stun:stun.example.com" }], sendOffer);
    });
    await completeHandshake(FakePC.instances[0], result.current.handleServerSdp);

    // Transient blip: disconnected then back to connected before the 3s grace expires.
    await act(async () => {
      FakePC.instances[0].fireIce("disconnected");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      FakePC.instances[0].fireIce("connected"); // recovered on its own
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000); // well past the grace window
    });

    // No rebuild, no extra offer — the orb never flashed.
    expect(FakePC.instances).toHaveLength(1);
    expect(sendOffer).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending rebuild when disconnect() is called", async () => {
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn();
    const { result } = renderHook(() => useAvatarStream(videoRef));

    await act(async () => {
      void result.current.connect([{ urls: "stun:stun.example.com" }], sendOffer);
    });
    await completeHandshake(FakePC.instances[0], result.current.handleServerSdp);

    // Failure schedules a rebuild; disconnect() before the backoff fires must abort it.
    await act(async () => {
      FakePC.instances[0].fireIce("failed");
    });
    await act(async () => {
      result.current.disconnect();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(FakePC.instances).toHaveLength(1); // no zombie rebuild
    expect(sendOffer).toHaveBeenCalledTimes(1);
  });

  it("bounds recovery: stops rebuilding after MAX_RECOVERY_ATTEMPTS failed handshakes", async () => {
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn();
    const { result } = renderHook(() => useAvatarStream(videoRef));

    await act(async () => {
      void result.current.connect([{ urls: "stun:stun.example.com" }], sendOffer);
    });
    await completeHandshake(FakePC.instances[0], result.current.handleServerSdp);
    expect(FakePC.instances).toHaveLength(1);

    // Kick off recovery; let each rebuilt handshake FAIL by never sending a server SDP (the 15s SDP
    // timeout rejects), which chains into the next bounded attempt. Advance generously to let all
    // backoffs (500/1500/3000ms) + gathering(8s) + SDP(15s) timeouts elapse for every attempt.
    await act(async () => {
      FakePC.instances[0].fireIce("failed");
    });
    await act(async () => {
      // Complete ICE gathering on each rebuilt PC as it appears so the handshake advances to the
      // SDP wait, then let the SDP timeout reject it. Loop over a long virtual window.
      for (let i = 0; i < 40; i++) {
        FakePC.instances.forEach((pc) => {
          if (!pc.closed && pc.localDescription) pc.completeGathering();
        });
        await vi.advanceTimersByTimeAsync(3000);
      }
    });

    // MAX_RECOVERY_ATTEMPTS = 3 → at most the original + 3 rebuilds, then it gives up (orb).
    expect(FakePC.instances.length).toBeLessThanOrEqual(4);
    expect(result.current.isConnected).toBe(false);
  });
});
