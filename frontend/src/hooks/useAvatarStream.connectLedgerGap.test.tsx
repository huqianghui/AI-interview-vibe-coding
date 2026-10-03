/**
 * Regression guard: EVERY path that can send a `session.avatar.connect` consults the rate-limit
 * ledger, not only the two that were wired to ask.
 *
 * This file began as an adversarial probe written to DOCUMENT a gap, and its original note said to
 * update it to assert throttled behaviour if `connect()` were ever wired through the ledger. That is
 * what happened, so the assertions below are inverted from the version that named the gap. The
 * analysis is kept because it is the reason the fix exists.
 *
 * The gap: `attemptRecovery` and `switchMediaMode` both called `avatarRequestWaitMs()` before
 * rebuilding. The consumer-driven `connect()` did not — it only RECORDED into the ledger via
 * `noteAvatarRequest()`. And that was reachable, not theoretical: `useInterviewVoice.ts` calls
 * `avatarStream.connect()` once per WS-level session, guarded only by `avatarStartedRef`, which resets
 * on every new session. Its reconnect loop lands retries at 1s/3s/7s (`RECONNECT_DELAYS`), all inside
 * Azure's ~20 s avatar window, so a flaky link fired three avatar offers, Azure refused the third
 * ("Avatar request was rate-limited. Retry after 43.0s.", measured 2026-09-30), the failure was caught
 * as non-fatal, and the candidate silently lost the picture for the rest of the session — the exact
 * outcome the ledger was added to prevent, arriving through the one unguarded path.
 *
 * The fix moved the check INTO `runHandshake`, next to the `noteAvatarRequest()` that already ran for
 * every offer, rather than adding a third call site that could be forgotten the same way. Placement
 * matters and is asserted indirectly here: the wait has to precede the `serverSdpPromise` whose 15 s
 * timeout is armed before the offer is sent, or a 20 s hold would guarantee an SDP timeout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useAvatarStream } from "./useAvatarStream";

const ICE_SERVERS = [{ urls: "stun:stun.example.com" }];

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

/** Let the newest (still-open) PC reach the point where its offer is sent — mirrors
 * `useAvatarStream.rateLimit.test.tsx`'s helper of the same name. */
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

describe("avatar-request ledger — every offer path, including consumer-driven connect()", () => {
  it("throttles a burst of connect() calls the way it throttles self-heal and mode switches", async () => {
    const videoRef = makeVideoRef();
    // Never answers the handshake — irrelevant here, since this asserts only whether the OFFER (the
    // thing Azure rate-limits) goes out, not whether the handshake completes.
    const sendOffer = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() => useAvatarStream(videoRef));

    // Each connect() is caught, and that is load-bearing rather than defensive habit: this test never
    // answers a handshake, and the 20 s advance at the end blows past each earlier handshake's own 15 s
    // SDP-answer timeout. Those rejections propagate out through connect(), so a bare `void` leaves two
    // unhandled rejections — which vitest reports as "348 passed" and then exits 1. Found by the ship
    // coverage audit checking the process exit code instead of trusting the summary line.
    //
    // Three WS-level reconnects landing inside Azure's ~20s avatar rate-limit window — exactly what
    // RECONNECT_DELAYS = [1000, 2000, 4000] in useInterviewVoice.ts produces on a flaky link (a fresh
    // avatarStream.connect() fires on every new WS session, at roughly 1s/3s/7s of wall-clock time,
    // all well inside the window). Each call here stands in for one of those sessions; nothing
    // awaits the previous handshake to completion first, because in production nothing does either
    // — the next WS session can open before the avatar handshake for the last one even settles.
    await act(async () => {
      void result.current.connect(ICE_SERVERS, sendOffer).catch(() => undefined);
    });
    await pushOfferOut();
    expect(sendOffer).toHaveBeenCalledTimes(1); // request 1 of the allowance

    await act(async () => {
      void result.current.connect(ICE_SERVERS, sendOffer).catch(() => undefined);
    });
    await pushOfferOut();
    expect(sendOffer).toHaveBeenCalledTimes(2); // request 2 — still inside the allowance either way

    // Measured: Azure accepts three inside the window, so the third still goes out…
    await act(async () => {
      void result.current.connect(ICE_SERVERS, sendOffer).catch(() => undefined);
    });
    await pushOfferOut();
    expect(sendOffer).toHaveBeenCalledTimes(3);

    // …and the FOURTH is the one it refuses (`rate_limit_exceeded`). It must be HELD, not sent.
    await act(async () => {
      void result.current.connect(ICE_SERVERS, sendOffer).catch(() => undefined);
    });
    await pushOfferOut();

    expect(
      sendOffer,
      "a fourth avatar offer inside the rate-limit window is refused by Azure, and a refused offer " +
        "still costs the attempt — connect() must hold it like the other two callers do",
    ).toHaveBeenCalledTimes(3);

    // …and released once the window has passed, so the hold is a delay and not a silent drop.
    await act(async () => {
      // One full window. Measured: 60 s, 3 requests — docs/avatar-rate-limit.md.
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await pushOfferOut();
    expect(
      sendOffer.mock.calls.length,
      "the held offer must eventually go out — a dropped offer would cost the picture just as surely",
    ).toBeGreaterThanOrEqual(4);
  });
});
