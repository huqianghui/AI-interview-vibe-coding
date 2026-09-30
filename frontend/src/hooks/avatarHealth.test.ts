/**
 * Unit guard for the weak-network media policy (`avatarHealth.ts`).
 *
 * These encode the findings the live probe paid for (`docs/avatar-weaknet-probe.md` §3.8/§3.9) so a
 * future refactor can't quietly undo them:
 *   - "bytes arriving but nothing decodes" must trigger a downgrade WITHOUT relying on any tuned
 *     threshold — that was the measured 1080p failure mode (~1 Mbps in, zero frames out, 30+ s).
 *   - concealment must be measured against samples RECEIVED, so DTX silence is not read as breakage.
 *   - restoring the picture must be hysteretic: a restore that immediately fails makes the next one
 *     harder, and two failures end the session in audio-only. No strobing.
 */
import { describe, expect, it } from "vitest";

import {
  HEALTH_THRESHOLDS as T,
  type DecisionState,
  type MediaHealth,
  initialDecisionState,
  isVideoStalled,
  readHealth,
  reduceHealth,
} from "./avatarHealth";

/** A `getStats()` report stand-in: a plain Map keyed by stat id. */
function statsReport(rows: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  return new Map(rows.map((row) => [String(row.id), row]));
}

function audioVideoReport(opts: {
  concealed: number;
  totalSamples: number;
  framesDecoded: number;
  videoBytes: number;
  rtt?: number;
}) {
  return statsReport([
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
    {
      id: "P",
      type: "candidate-pair",
      state: "succeeded",
      nominated: true,
      currentRoundTripTime: (opts.rtt ?? 300) / 1000,
    },
  ]);
}

const HEALTHY: MediaHealth = {
  concealmentRatio: 0.005,
  videoDecoding: true,
  videoBytesFlowing: true,
  rttMs: 120,
};
/** The measured 1080p failure: ~1 Mbps of video arriving, not one frame decoded. */
const WASTING: MediaHealth = { ...HEALTHY, videoDecoding: false };
/** Voice being invented by the concealment algorithm (the 31% case). */
const VOICE_DAMAGED: MediaHealth = { ...HEALTHY, concealmentRatio: 0.31 };

/** Feed healthy windows until the reducer acts, then STOP. Needed wherever a test cares about the
 * clock right after an action — feeding past it would let the probation window quietly expire. */
function feedUntilAction(
  state: DecisionState,
  health: MediaHealth,
  maxWindows: number,
  t0: number,
): { state: DecisionState; action: string | null; now: number } {
  let now = t0;
  let next = state;
  for (let i = 0; i < maxWindows; i++) {
    now += T.SAMPLE_INTERVAL_MS;
    const out = reduceHealth(next, health, now);
    next = out.state;
    if (out.action) return { state: next, action: out.action, now };
  }
  return { state: next, action: null, now };
}

/** Feed a series of identical windows, 1 sample interval apart, starting at `t0`. */
function feed(
  state: DecisionState,
  health: MediaHealth,
  count: number,
  t0: number,
): { state: DecisionState; actions: string[]; now: number } {
  const actions: string[] = [];
  let now = t0;
  let next = state;
  for (let i = 0; i < count; i++) {
    now += T.SAMPLE_INTERVAL_MS;
    const out = reduceHealth(next, health, now);
    next = out.state;
    if (out.action) actions.push(out.action);
  }
  return { state: next, actions, now };
}

describe("readHealth", () => {
  it("returns no health for the first sample (there is no window yet)", () => {
    const { snapshot, health } = readHealth(
      null,
      audioVideoReport({ concealed: 10, totalSamples: 96_000, framesDecoded: 50, videoBytes: 250_000 }),
      1_000,
    );
    expect(health).toBeNull();
    expect(snapshot.totalSamplesReceived).toBe(96_000);
  });

  it("measures concealment against samples RECEIVED, not wall clock", () => {
    const first = readHealth(
      null,
      audioVideoReport({ concealed: 0, totalSamples: 0, framesDecoded: 0, videoBytes: 0 }),
      0,
    );
    // 96k samples arrived in this window (2 s of 48 kHz audio); 24k of them were concealed.
    const second = readHealth(
      first.snapshot,
      audioVideoReport({ concealed: 24_000, totalSamples: 96_000, framesDecoded: 50, videoBytes: 250_000 }),
      2_000,
    );
    expect(second.health?.concealmentRatio).toBeCloseTo(0.25, 5);
  });

  it("reads DTX silence as 0% concealed rather than 100% broken", () => {
    // Nobody is speaking: neither counter moves. A per-second normalisation would call this total loss.
    const base = { concealed: 5_000, totalSamples: 480_000, framesDecoded: 600, videoBytes: 3_000_000 };
    const first = readHealth(null, audioVideoReport(base), 0);
    const second = readHealth(first.snapshot, audioVideoReport(base), 2_000);
    expect(second.health?.concealmentRatio).toBe(0);
  });

  it("flags video as not decoding while bytes still flow, and surfaces RTT", () => {
    const first = readHealth(
      null,
      audioVideoReport({ concealed: 0, totalSamples: 0, framesDecoded: 400, videoBytes: 1_000_000 }),
      0,
    );
    const second = readHealth(
      first.snapshot,
      // Same frame count, 250 KB more video: the 1080p-frozen signature.
      audioVideoReport({
        concealed: 0,
        totalSamples: 96_000,
        framesDecoded: 400,
        videoBytes: 1_250_000,
        rtt: 876,
      }),
      2_000,
    );
    expect(second.health?.videoDecoding).toBe(false);
    expect(second.health?.videoBytesFlowing).toBe(true);
    expect(second.health?.rttMs).toBe(876);
  });

  it("flags stalled video when no bytes arrive", () => {
    const base = { concealed: 0, totalSamples: 0, framesDecoded: 400, videoBytes: 1_000_000 };
    const first = readHealth(null, audioVideoReport(base), 0);
    const second = readHealth(first.snapshot, audioVideoReport(base), 2_000);
    expect(second.health?.videoBytesFlowing).toBe(false);
  });
});

describe("reduceHealth downgrade", () => {
  it("drops the picture after BAD_WINDOWS of bytes-without-decode (no threshold involved)", () => {
    const { state, actions } = feed(initialDecisionState(), WASTING, T.BAD_WINDOWS, 0);
    expect(actions).toEqual(["downgrade"]);
    expect(state.mode).toBe("audio-only");
  });

  it("drops the picture when the interviewer's voice is being concealed away", () => {
    const { state, actions } = feed(initialDecisionState(), VOICE_DAMAGED, T.BAD_WINDOWS, 0);
    expect(actions).toEqual(["downgrade"]);
    expect(state.mode).toBe("audio-only");
  });

  it("does not drop on a single bad window, and forgives a recovered blip", () => {
    const one = feed(initialDecisionState(), WASTING, 1, 0);
    expect(one.actions).toEqual([]);
    expect(one.state.badWindows).toBe(1);

    const recovered = reduceHealth(one.state, HEALTHY, one.now + T.SAMPLE_INTERVAL_MS);
    expect(recovered.action).toBeNull();
    expect(recovered.state.badWindows).toBe(0);
    expect(recovered.state.mode).toBe("video");
  });

  it("stays put on a healthy link", () => {
    const { state, actions } = feed(initialDecisionState(), HEALTHY, 20, 0);
    expect(actions).toEqual([]);
    expect(state.mode).toBe("video");
  });
});

describe("reduceHealth restore", () => {
  /** Windows of healthy sampling needed to clear both the healthy hold and the post-downgrade cooldown
   * (the Azure avatar rate limit makes the cooldown the longer of the two). */
  function holdWindows(holdMs: number) {
    return Math.ceil(Math.max(holdMs, T.MIN_AFTER_DOWNGRADE_MS) / T.SAMPLE_INTERVAL_MS) + 2;
  }

  /** Get to audio-only the way the real thing does, then return the clock. */
  function downgraded(t0 = 0) {
    const out = feed(initialDecisionState(), WASTING, T.BAD_WINDOWS, t0);
    expect(out.state.mode).toBe("audio-only");
    return out;
  }

  it("will not restore before the healthy hold has elapsed", () => {
    const down = downgraded();
    const windows = Math.floor(T.INITIAL_HEALTHY_HOLD_MS / T.SAMPLE_INTERVAL_MS) - 2;
    const { state, actions } = feed(down.state, HEALTHY, windows, down.now);
    expect(actions).toEqual([]);
    expect(state.mode).toBe("audio-only");
  });

  it("restores once the link has been healthy for the full hold and past the rate-limit cooldown", () => {
    const down = downgraded();
    const windows = holdWindows(T.INITIAL_HEALTHY_HOLD_MS);
    const { state, actions } = feed(down.state, HEALTHY, windows, down.now);
    expect(actions).toEqual(["restore"]);
    expect(state.mode).toBe("video");
  });

  it("restarts the healthy streak when the link wobbles mid-hold", () => {
    const down = downgraded();
    const half = Math.floor(T.INITIAL_HEALTHY_HOLD_MS / T.SAMPLE_INTERVAL_MS / 2);
    const first = feed(down.state, HEALTHY, half, down.now);
    // One damaged window resets the clock…
    const wobble = reduceHealth(first.state, VOICE_DAMAGED, first.now + T.SAMPLE_INTERVAL_MS);
    expect(wobble.state.healthySince).toBeNull();
    // …so the remaining half of the hold is no longer enough.
    const second = feed(wobble.state, HEALTHY, half, first.now + T.SAMPLE_INTERVAL_MS);
    expect(second.actions).toEqual([]);
    expect(second.state.mode).toBe("audio-only");
  });

  it("doubles the required hold after a restore that immediately fails, then gives up for good", () => {
    // 1st cycle: downgrade → heal → restore. Stop the clock at the restore so the probation window is
    // still open when the link collapses again.
    const down1 = downgraded();
    const up1 = feedUntilAction(down1.state, HEALTHY, holdWindows(T.INITIAL_HEALTHY_HOLD_MS), down1.now);
    expect(up1.action).toBe("restore");

    // The link is still bad: it collapses again inside probation ⇒ one failed restore, hold doubles.
    const down2 = feed(up1.state, WASTING, T.BAD_WINDOWS, up1.now);
    expect(down2.actions).toEqual(["downgrade"]);
    expect(down2.state.failedRestores).toBe(1);
    expect(down2.state.healthyHoldMs).toBe(T.INITIAL_HEALTHY_HOLD_MS * 2);

    // The old, shorter hold must no longer be enough.
    const tooShort = feedUntilAction(
      down2.state,
      HEALTHY,
      Math.floor(T.INITIAL_HEALTHY_HOLD_MS / T.SAMPLE_INTERVAL_MS),
      down2.now,
    );
    expect(tooShort.action).toBeNull();

    // The doubled hold earns a second attempt.
    const up2 = feedUntilAction(
      tooShort.state,
      HEALTHY,
      holdWindows(T.INITIAL_HEALTHY_HOLD_MS * 2),
      tooShort.now,
    );
    expect(up2.action).toBe("restore");

    // It fails too ⇒ MAX_RESTORE_ATTEMPTS reached: audio-only for the rest of the session, no matter
    // how long the link behaves afterwards.
    const down3 = feed(up2.state, WASTING, T.BAD_WINDOWS, up2.now);
    expect(down3.actions).toEqual(["downgrade"]);
    expect(down3.state.failedRestores).toBe(T.MAX_RESTORE_ATTEMPTS);

    const forever = feed(down3.state, HEALTHY, holdWindows(T.INITIAL_HEALTHY_HOLD_MS * 8), down3.now);
    expect(forever.actions).toEqual([]);
    expect(forever.state.mode).toBe("audio-only");
  });

  it("honours the cooldown even if the hold is already satisfied", () => {
    // Heal for well over the hold, but keep the clock inside MIN_AFTER_DOWNGRADE_MS.
    const down = downgraded();
    const state: DecisionState = { ...down.state, healthyHoldMs: T.SAMPLE_INTERVAL_MS };
    const windows = Math.floor(T.MIN_AFTER_DOWNGRADE_MS / T.SAMPLE_INTERVAL_MS) - 2;
    const { actions } = feed(state, HEALTHY, Math.max(2, windows), down.now);
    expect(actions).toEqual([]);
  });
});

describe("reduceHealth with a pinned preference", () => {
  it("never moves the mode when the candidate pinned the picture on", () => {
    const pinned: DecisionState = { ...initialDecisionState(), preference: "on" };
    const { state, actions } = feed(pinned, WASTING, 10, 0);
    expect(actions).toEqual([]);
    expect(state.mode).toBe("video");
  });

  it("never moves the mode when the candidate pinned the picture off", () => {
    const pinned = initialDecisionState("off");
    expect(pinned.mode).toBe("audio-only");
    const { state, actions } = feed(pinned, HEALTHY, 60, 0);
    expect(actions).toEqual([]);
    expect(state.mode).toBe("audio-only");
  });
});

describe("isVideoStalled", () => {
  it("reports a stall only after STALL_WINDOWS of silence, and only in video mode", () => {
    const stalled: MediaHealth = { ...HEALTHY, videoBytesFlowing: false, videoDecoding: false };
    const one = feed(initialDecisionState(), stalled, 1, 0);
    expect(isVideoStalled(one.state)).toBe(false);

    // The same windows also count as "wasting"? No — bytes are NOT flowing, so the downgrade trigger
    // does not fire; a dead video stream is reported to the UI, and ICE handles the recovery.
    const two = feed(one.state, stalled, T.STALL_WINDOWS - 1, one.now);
    expect(isVideoStalled(two.state)).toBe(true);
    expect(two.state.mode).toBe("video");

    expect(isVideoStalled({ ...two.state, mode: "audio-only" })).toBe(false);
  });
});
