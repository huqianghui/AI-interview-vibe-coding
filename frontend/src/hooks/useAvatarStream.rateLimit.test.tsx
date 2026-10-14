/**
 * Regression guard for the AVATAR RATE-LIMIT allowance (TODOS.md, filed from the v0.40.0.0 review).
 *
 * Azure rate-limits avatar session creation — a third `session.avatar.connect` inside roughly 20 s was
 * refused with `"Avatar request was rate-limited. Retry after 43.0s."` (measured 2026-09-30). The
 * self-heal used to re-offer on the live session with 500/1500/3000 ms backoffs, so its attempts landed
 * inside ~5 s and spent the allowance on requests Azure would never honour.
 *
 * The self-heal now rebuilds the whole session instead (Azure refuses a same-session re-offer outright,
 * `webrtc_connection_invalid`), so it sends no offer of its own: every avatar request goes out from a
 * session's connect(), through the one ledger. The exhaustion path (video → audio-only → orb) is pinned
 * in `useAvatarStream.test.tsx`.
 *
 * The WS send throws on every offer after the first, so a failing session is observable in virtual
 * time without waiting out the 15 s SDP timeout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useAvatarStream } from "./useAvatarStream";

const ICE_SERVERS = [{ urls: "stun:stun.example.com" }];
/** Mirrors the module constants under test. Kept local on purpose: if someone widens the allowance in
 * the hook, these tests should fail and make them re-justify it — which is exactly what happened twice
 * on 2026-10-03.
 *
 * First the window: it was 20_000 here, mirroring an inference from "a third request inside roughly
 * 20 s was refused". That inference was invalid — requests landing close together says nothing about
 * the window's length.
 *
 * Then both numbers were MEASURED against the live service, five sessions in separate browser contexts:
 * three were accepted and the FOURTH refused with `rate_limit_exceeded`, and the two refusals' retry-
 * after values both counted down to the first request's timestamp + 60 s (within half a second). So the
 * window is 60 s and the allowance is 3 — one more than Azure publishes for S0.
 * See `docs/avatar-rate-limit.md`. */
const WINDOW_MS = 60_000;
/** Measured allowance inside one window. Used below so the chain's shape is tied to the number. */
const ALLOWANCE = 3;

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
  it("spends no allowance on the self-heal itself, and holds a rebuilt session's offer until Azure would accept it", async () => {
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn(() => Promise.resolve());
    const requests: string[] = [];
    const { result } = renderHook(() =>
      useAvatarStream(videoRef, { onModeSwitchRequest: (next) => requests.push(next) }),
    );

    // Session 1 drops; the self-heal asks for a rebuild and sends nothing itself.
    await act(async () => {
      void result.current.connect(ICE_SERVERS, sendOffer);
    });
    await pushOfferOut();
    await answerHandshake(result.current.handleServerSdp);
    await act(async () => {
      FakePC.instances[0].fireIce("failed");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(requests).toEqual(["video"]);
    expect(sendOffer, "the self-heal must not re-offer on the session it is leaving").toHaveBeenCalledTimes(1);

    // The consumer rebuilds; each rebuilt session's offer goes through the ledger. Sessions 2 and 3 fit
    // the measured allowance of 3 per window.
    for (const n of [2, 3]) {
      await act(async () => {
        void result.current.connect(ICE_SERVERS, sendOffer);
      });
      await pushOfferOut();
      expect(sendOffer).toHaveBeenCalledTimes(n);
      await answerHandshake(result.current.handleServerSdp);
    }

    // A fourth inside the window would be refused, so it is held, not sent.
    await act(async () => {
      void result.current.connect(ICE_SERVERS, sendOffer);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await pushOfferOut();
    expect(
      sendOffer,
      "a FOURTH avatar offer inside the window would be refused, so it must not be sent",
    ).toHaveBeenCalledTimes(ALLOWANCE);

    // Once the window has passed, it proceeds — a delay, not a silent drop.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WINDOW_MS);
    });
    await pushOfferOut();
    expect(sendOffer).toHaveBeenCalledTimes(ALLOWANCE + 1);
  });
});
