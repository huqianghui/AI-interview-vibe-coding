/**
 * Coverage for the Azure avatar rate-limit cooldown (weak-network media adaptation, 2026-09-30):
 * `canEnableVideo` / `videoEnableAtMs`, and the "not restoring the picture yet" branch of
 * `switchMediaMode` (`HEALTH_THRESHOLDS.VIDEO_SWITCH_MIN_INTERVAL_MS`).
 *
 * `useAvatarStream.test.tsx` (self-heal regression suite) never touches `canEnableVideo`,
 * `videoEnableAtMs`, `setVideoPreference`, or the cooldown branch — every connect() there completes
 * a handshake and moves straight to ICE-drop scenarios. This is a separate NEW test file (not an
 * edit to the existing one) so the audit's "only add new test files" constraint holds; the fake
 * `RTCPeerConnection` below is a trimmed copy of that file's `FakePC` (only what a bare `connect()`
 * needs to run its synchronous prefix — these tests never need the handshake to finish, since
 * `avatarConnectedAtRef`/`sendOfferRef`/`canEnableVideo` are all set before `runHandshake` awaits).
 *
 * Note: `switchMediaMode` tears the connection down (`sendOfferRef.current = null`) and delegates
 * the *rebuild* to the consumer via `onModeSwitchRequest` (Azure won't renegotiate a live avatar
 * session — see the module header). The real consumer is `restartForMediaMode` in
 * `useInterviewVoice.ts`, which always calls `connect()` again. The fake `onModeSwitchRequest`
 * below mirrors that contract (it re-`connect()`s), because without it a *second*
 * `setVideoPreference` call would hit `setVideoPreference`'s own `!sendOfferRef.current` bypass
 * branch instead of the cooldown branch this file exists to cover — confirmed by first running this
 * suite without the rebuild and watching `mediaMode` flip straight to "video" with no cooldown check
 * at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { HEALTH_THRESHOLDS as T } from "./avatarHealth";
import { useAvatarStream } from "./useAvatarStream";

class FakePC {
  static instances: FakePC[] = [];
  onicecandidate: ((e: { candidate: RTCIceCandidate | null }) => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  iceConnectionState = "new";
  iceGatheringState = "new";
  localDescription: { sdp: string } | null = null;
  closed = false;
  constructor(public config: RTCConfiguration) {
    FakePC.instances.push(this);
  }
  addTransceiver() {
    /* no-op: these tests never need a real SDP */
  }
  async getStats() {
    return new Map();
  }
  async createOffer() {
    return { type: "offer", sdp: "fake-offer-sdp" } as RTCSessionDescriptionInit;
  }
  async setLocalDescription(desc: RTCSessionDescriptionInit) {
    this.localDescription = { sdp: desc.sdp ?? "fake-offer-sdp" };
  }
  async setRemoteDescription() {
    /* never reached: these tests don't complete the handshake */
  }
  close() {
    this.closed = true;
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

const ICE_SERVERS = [{ urls: "stun:stun.example.com" }];

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

/** Starts `connect()` and returns once its synchronous prefix has run (avatarConnectedAtRef,
 * sendOfferRef, canEnableVideo=false are all set there, before the handshake's awaits) — these
 * tests never need the handshake itself to finish. `onModeSwitchRequest` mirrors the real
 * consumer contract by re-`connect()`ing (see the file header) so a *second*
 * `setVideoPreference` call exercises `switchMediaMode`'s cooldown branch instead of
 * `setVideoPreference`'s no-live-session bypass. */
function startConnect() {
  const videoRef = makeVideoRef();
  const sendOffer = vi.fn();
  const modeSwitches: ("video" | "audio-only")[] = [];
  // The callback has to reach the hook that has not been rendered yet, so it reads through a holder
  // instead of a forward-declared binding. Same indirection a ref gives, without a `let` that is
  // assigned exactly once.
  const hook: { result?: ReturnType<typeof renderHook<ReturnType<typeof useAvatarStream>, unknown>>["result"] } = {};
  const onModeSwitchRequest = (next: "video" | "audio-only") => {
    modeSwitches.push(next);
    void hook.result?.current.connect(ICE_SERVERS, sendOffer).catch(() => undefined);
  };
  const { result } = renderHook(() => useAvatarStream(videoRef, { onModeSwitchRequest }));
  hook.result = result;
  act(() => {
    void result.current.connect(ICE_SERVERS, sendOffer).catch(() => undefined);
  });
  return { result, modeSwitches };
}

describe("useAvatarStream video rate-limit cooldown", () => {
  it("starts a fresh connect with the cooldown active: canEnableVideo false, videoEnableAtMs ~60s out", () => {
    const t0 = Date.now();
    const { result } = startConnect();
    expect(result.current.canEnableVideo).toBe(false);
    expect(result.current.videoEnableAtMs).not.toBeNull();
    expect(result.current.videoEnableAtMs! - t0).toBeCloseTo(T.VIDEO_SWITCH_MIN_INTERVAL_MS, -2);
  });

  it("flips canEnableVideo back on and clears videoEnableAtMs once the cooldown elapses", async () => {
    const { result } = startConnect();
    expect(result.current.canEnableVideo).toBe(false);

    // The poller runs every 1s and only actually flips once VIDEO_SWITCH_MIN_INTERVAL_MS has passed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(T.VIDEO_SWITCH_MIN_INTERVAL_MS + 1_000);
    });
    expect(result.current.canEnableVideo).toBe(true);
    expect(result.current.videoEnableAtMs).toBeNull();
  });

  it('refuses to restore the picture mid-cooldown: "on" mid-window is a silent no-op, no rebuild requested', () => {
    const { result, modeSwitches } = startConnect();

    // Drop the picture (never delayed) — this DOES ask the consumer to rebuild.
    act(() => result.current.setVideoPreference("off"));
    expect(modeSwitches).toEqual(["audio-only"]);
    expect(result.current.mediaMode).toBe("audio-only");

    // Well short of the 60s Azure avatar rate-limit window (which restarted when the consumer's
    // rebuild called connect() again for the audio-only session).
    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    // Asking for the picture back mid-cooldown must NOT ask the consumer to rebuild, and the mode
    // must stay audio-only — the "not restoring the picture yet" branch in switchMediaMode.
    act(() => result.current.setVideoPreference("on"));
    expect(modeSwitches).toEqual(["audio-only"]);
    expect(result.current.mediaMode).toBe("audio-only");
  });

  it('restores the picture once the cooldown has elapsed: "on" after 60s does request a rebuild', () => {
    const { result, modeSwitches } = startConnect();

    act(() => result.current.setVideoPreference("off"));
    expect(modeSwitches).toEqual(["audio-only"]);

    act(() => {
      vi.advanceTimersByTime(T.VIDEO_SWITCH_MIN_INTERVAL_MS + 1_000);
    });

    act(() => result.current.setVideoPreference("on"));
    expect(modeSwitches).toEqual(["audio-only", "video"]);
    expect(result.current.mediaMode).toBe("video");
  });
});
