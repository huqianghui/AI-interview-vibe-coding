/**
 * Coverage-audit addition: `readHealth`'s non-monotonic-counter guard (avatarHealth.ts, the block
 * right after computing `snapshot` that returns `health: null` when any counter is LOWER than the
 * previous snapshot) had no test exercising it directly. The existing `avatarHealth.test.ts` suite
 * only ever feeds counters that grow, so a regression that deleted the guard (or inverted one of its
 * four comparisons) would not fail any existing test.
 *
 * Why this matters, per the guard's own comment: a fresh `RTCPeerConnection` restarts its counters at
 * zero while `prev` still holds the OLD session's totals (a mode switch or self-heal rebuild both do
 * this), and two `getStats()` promises can resolve out of order. Either way the naive delta goes
 * negative, `dSamples > 0` reads that as "no audio arrived", and the restore's healthy streak resets
 * for no reason — the exact user-visible harm the ledger/health work exists to avoid. The fix treats a
 * non-monotonic report as a fresh baseline: no verdict for that window, correct deltas from the next
 * one onward (comparing the NEW snapshot forward, not the stale `prev`).
 *
 * New file rather than an addition to `avatarHealth.test.ts`, per this audit's constraint not to touch
 * existing test files.
 */
import { describe, expect, it } from "vitest";

import { readHealth } from "./avatarHealth";

/** Same shape as `avatarHealth.test.ts`'s local helper — a plain Map keyed by stat id, since
 * `readHealth` only needs `StatsReportLike` (anything with a `forEach`). */
function statsReport(rows: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  return new Map(rows.map((row) => [String(row.id), row]));
}

function report(opts: {
  concealed: number;
  totalSamples: number;
  framesDecoded: number;
  videoBytes: number;
}) {
  return statsReport([
    {
      id: "A",
      type: "inbound-rtp",
      kind: "audio",
      concealedSamples: opts.concealed,
      silentConcealedSamples: 0,
      totalSamplesReceived: opts.totalSamples,
    },
    {
      id: "V",
      type: "inbound-rtp",
      kind: "video",
      framesDecoded: opts.framesDecoded,
      bytesReceived: opts.videoBytes,
    },
  ]);
}

describe("readHealth — non-monotonic counters treated as a fresh baseline", () => {
  it("reports no verdict when totalSamplesReceived drops (new PC / out-of-order getStats), then resumes cleanly from the lower baseline", () => {
    const t0 = readHealth(
      null,
      report({ concealed: 0, totalSamples: 48_000, framesDecoded: 100, videoBytes: 500_000 }),
      1_000,
    );
    expect(t0.health).toBeNull(); // first sample: no window yet — sanity check on the fixture itself.

    // A normal healthy window, to prove this isn't just "always null".
    const t1 = readHealth(
      t0.snapshot,
      report({ concealed: 500, totalSamples: 96_000, framesDecoded: 150, videoBytes: 750_000 }),
      3_000,
    );
    expect(t1.health).not.toBeNull();
    expect(t1.health?.audioFlowing).toBe(true);

    // A fresh PeerConnection (mode switch / self-heal rebuild) starts every counter back at zero. Its
    // first sample is far BELOW the previous session's totals — must produce no verdict, not a
    // negative-delta "no audio arrived" reading.
    const t2 = readHealth(
      t1.snapshot,
      report({ concealed: 5, totalSamples: 4_000, framesDecoded: 2, videoBytes: 20_000 }),
      5_000,
    );
    expect(
      t2.health,
      "a lower counter than the previous snapshot must be treated as a fresh baseline, not a real window",
    ).toBeNull();
    // The new (lower) snapshot is still recorded — it becomes the baseline for the NEXT comparison.
    expect(t2.snapshot.totalSamplesReceived).toBe(4_000);

    // The next window, growing from the new PC's own baseline, must read as a normal healthy verdict —
    // proving the guard didn't just suppress this window, it correctly re-anchored for the next one.
    const t3 = readHealth(
      t2.snapshot,
      report({ concealed: 20, totalSamples: 52_000, framesDecoded: 60, videoBytes: 300_000 }),
      7_000,
    );
    expect(t3.health).not.toBeNull();
    expect(t3.health?.audioFlowing).toBe(true);
    expect(t3.health?.videoDecoding).toBe(true);
  });

  it("also guards on framesDecoded going backwards, independent of the audio counters", () => {
    const t0 = readHealth(
      null,
      report({ concealed: 0, totalSamples: 48_000, framesDecoded: 200, videoBytes: 500_000 }),
      1_000,
    );
    // Audio counters keep growing normally; only the video decoder's counter regresses (e.g. the video
    // m-line got re-added after being `inactive`, restarting its own stats independent of the audio
    // track that never dropped). Must still suppress the verdict — the guard checks all four counters,
    // not just the audio pair.
    const t1 = readHealth(
      t0.snapshot,
      report({ concealed: 100, totalSamples: 96_000, framesDecoded: 10, videoBytes: 500_050 }),
      3_000,
    );
    expect(t1.health).toBeNull();
  });
});
