/**
 * The avatar quota itself, pinned to the DOCUMENTED number — and the production failure it explains.
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
 * Read `Retry after` as "how long until the oldest connection ages out", and both observations fit a
 * 60 s window exactly: 43.0s ⇒ the oldest was 17 s old, 7.0s ⇒ 53 s old.
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

describe("documented avatar quota: 2 new connections per minute", () => {
  it("lets two offers through and HOLDS the third — the published allowance, not a guess", async () => {
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() => useAvatarStream(videoRef));

    for (let i = 0; i < 2; i++) {
      await act(async () => {
        void result.current.connect(ICE_SERVERS, sendOffer).catch(() => undefined);
      });
      await pushOfferOut();
    }
    expect(sendOffer).toHaveBeenCalledTimes(2);

    await act(async () => {
      void result.current.connect(ICE_SERVERS, sendOffer).catch(() => undefined);
    });
    await pushOfferOut();
    expect(sendOffer, "the third offer in the window is the one Azure refuses").toHaveBeenCalledTimes(2);
  });

  it("reproduces the production failure: 25 s after two offers, a third must still be HELD", async () => {
    // This is the exact regression. 25 s is past the old 20 s window and well short of the documented
    // 60 s one, so the old ledger sent this offer and Azure refused it with "Retry after 7.0s"; the new
    // one has to hold it. Nothing else in this file would have caught the difference, because every
    // other case puts its requests close together.
    const videoRef = makeVideoRef();
    const sendOffer = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() => useAvatarStream(videoRef));

    for (let i = 0; i < 2; i++) {
      await act(async () => {
        void result.current.connect(ICE_SERVERS, sendOffer).catch(() => undefined);
      });
      await pushOfferOut();
    }
    expect(sendOffer).toHaveBeenCalledTimes(2);

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
    ).toHaveBeenCalledTimes(2);

    // Released once the OLDEST request ages out, not a fixed delay after the attempt.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(36_000);
    });
    await pushOfferOut();
    expect(sendOffer.mock.calls.length).toBeGreaterThanOrEqual(3);
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
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        void first.result.current.connect(ICE_SERVERS, sendOffer).catch(() => undefined);
      });
      await pushOfferOut();
    }
    expect(sendOffer).toHaveBeenCalledTimes(2); // allowance spent

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
    ).toHaveBeenCalledTimes(3);
  });
});
