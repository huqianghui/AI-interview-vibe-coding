/**
 * The avatar quota itself, pinned to the MEASURED numbers — and the production failure they explain.
 *
 * Azure publishes, for real-time text-to-speech avatar on S0, **2 new connections per minute**, and in
 * the same place says "avatars used in Voice Live follow the quotas and limits described in Real-time
 * text-to-speech avatar". So the digital human rides the Speech avatar quota, NOT Voice Live's own
 * 30/minute — the single easiest thing to get wrong here, because one resource publishes both.
 * `docs/avatar-rate-limit.md` has the full write-up.
 *
 * WHAT WENT WRONG IN PRODUCTION (2026-10-03). The ledger's window was 20_000 ms, inferred from "a third
 * request inside roughly 20 s was refused" (measured 2026-09-30). That inference was invalid: requests
 * landing close together says nothing about how long the window is. At 2 per 20 s the ledger allowed
 * SIX per minute, so it waved through offers Azure was certain to refuse, and the candidate was shown
 *
 *     Voice unavailable: Avatar request was rate-limited. Retry after 7.0s. — you can continue by text.
 *
 * THEN THE WHOLE THING WAS MEASURED, which confirmed the window and corrected the allowance. Five
 * sessions in separate browser contexts (separate ledgers, so our own throttle could not interfere):
 *
 *   #1  4681ms  accepted (connecting -> switch_to_speaking)
 *   #2 11105ms  accepted
 *   #3 17665ms  accepted          <- the PUBLISHED allowance of 2 says this should have been refused
 *   #4 24180ms  rate_limit_exceeded  "Retry after 40.0s."
 *   #5 31083ms  rate_limit_exceeded  "Retry after 34.0s."
 *
 * Both refusals name the same absolute moment (24180+40000 = 64180; 31083+34000 = 65083) and #1 was at
 * 4681, so #1 + 60_000 = 64681 lands within half a second of each: two independent confirmations that
 * the window is 60 s and that `Retry after` counts down to the OLDEST request ageing out.
 *
 * So these tests mirror the measured allowance of THREE. Holding at the published two is not the safe
 * choice — it stalls a third connect for up to 60 s that Azure would have taken at once, and 60 s of
 * silence is indistinguishable from failure to the candidate.
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

describe("avatar quota: measured 3 new connections per 60 s", () => {
  it("lets three offers through and HOLDS the fourth — the measured allowance", async () => {
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() => useAvatarStream(videoRef));

    for (let i = 0; i < 3; i++) {
      await act(async () => {
        void result.current.connect(ICE_SERVERS, sendOffer).catch(() => undefined);
      });
      await pushOfferOut();
    }
    expect(sendOffer, "three were accepted by the real service").toHaveBeenCalledTimes(3);

    await act(async () => {
      void result.current.connect(ICE_SERVERS, sendOffer).catch(() => undefined);
    });
    await pushOfferOut();
    expect(sendOffer, "the FOURTH is the one Azure refused, with rate_limit_exceeded").toHaveBeenCalledTimes(3);
  });

  it("reproduces the production failure: 25 s after three offers, a fourth must still be HELD", async () => {
    // This is the exact regression. 25 s is past the old 20 s window and well short of the measured
    // 60 s one, so the old ledger sent this offer and Azure refused it; the new one has to hold it.
    // Nothing else in this file would have caught the difference, because every other case puts its
    // requests close together, where both windows behave identically.
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() => useAvatarStream(videoRef));

    for (let i = 0; i < 3; i++) {
      await act(async () => {
        void result.current.connect(ICE_SERVERS, sendOffer).catch(() => undefined);
      });
      await pushOfferOut();
    }
    expect(sendOffer).toHaveBeenCalledTimes(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    await act(async () => {
      void result.current.connect(ICE_SERVERS, sendOffer).catch(() => undefined);
    });
    await pushOfferOut();
    expect(
      sendOffer,
      "25 s is inside Azure's 60 s window: sending here is what produced the production error",
    ).toHaveBeenCalledTimes(3);

    // Released once the OLDEST request ages out, not a fixed delay after the attempt.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(36_000);
    });
    await pushOfferOut();
    expect(sendOffer.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("KNOWN LIMITATION: the ledger is per-mount, so two surfaces cannot protect each other", async () => {
    // Asserted rather than left implicit, because it is the other half of the production failure and it
    // is invisible in the code: `avatarRequestsRef` is a `useRef`, so a second mount starts empty while
    // Azure keeps counting. In practice that means the interview page and the editor Playground open at
    // once (which is what the owner had), a page reload, a second tab, or simply a SECOND CANDIDATE on
    // the same Speech resource — the quota is per-resource and spans all of them.
    //
    // sessionStorage would fix the reload and the Playground cases but not two candidates; that one
    // needs a raised quota or server-side queueing. Recorded in docs/avatar-rate-limit.md rather than
    // patched blind.
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn(() => Promise.resolve());

    const first = renderHook(() => useAvatarStream(videoRef));
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        void first.result.current.connect(ICE_SERVERS, sendOffer).catch(() => undefined);
      });
      await pushOfferOut();
    }
    expect(sendOffer).toHaveBeenCalledTimes(3); // allowance spent

    // A second surface, mounted fresh — the Playground, another tab, another candidate.
    const second = renderHook(() => useAvatarStream(makeVideoRef()));
    await act(async () => {
      void second.result.current.connect(ICE_SERVERS, sendOffer).catch(() => undefined);
    });
    await pushOfferOut();
    expect(
      sendOffer,
      "documents TODAY'S behaviour: the fresh ledger sends an offer Azure will refuse. If this ever " +
        "fails because the ledger became shared, that is an improvement — update the test, do not " +
        "widen the window",
    ).toHaveBeenCalledTimes(4);
  });
});
