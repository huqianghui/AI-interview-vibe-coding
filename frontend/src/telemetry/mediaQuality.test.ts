import { describe, expect, it } from "vitest";
import { MEDIA_WINDOW_MS, MediaQualityWindow, readMediaStats, windowMeasurements } from "./mediaQuality";
import { voiceMetrics } from "./voiceTimeline";

/** A getStats report shaped like Chrome's, from cumulative counters. */
function report(c: {
  audioRecv: number;
  audioLost: number;
  audioBytes: number;
  samples: number;
  concealed: number;
  silent: number;
  jbDelay: number;
  jbEmitted: number;
  videoRecv: number;
  videoLost: number;
  videoBytes: number;
  decoded: number;
  dropped: number;
  freezes: number;
  freezeS: number;
}) {
  const rows: Record<string, unknown>[] = [
    {
      id: "A",
      type: "inbound-rtp",
      kind: "audio",
      packetsReceived: c.audioRecv,
      packetsLost: c.audioLost,
      bytesReceived: c.audioBytes,
      totalSamplesReceived: c.samples,
      concealedSamples: c.concealed,
      silentConcealedSamples: c.silent,
      jitterBufferDelay: c.jbDelay,
      jitterBufferEmittedCount: c.jbEmitted,
      jitter: 0.012,
    },
    {
      id: "V",
      type: "inbound-rtp",
      kind: "video",
      packetsReceived: c.videoRecv,
      packetsLost: c.videoLost,
      bytesReceived: c.videoBytes,
      framesDecoded: c.decoded,
      framesDropped: c.dropped,
      freezeCount: c.freezes,
      totalFreezesDuration: c.freezeS,
      frameWidth: 1920,
      frameHeight: 1080,
    },
    { id: "T", type: "transport", selectedCandidatePairId: "P" },
    { id: "P", type: "candidate-pair", currentRoundTripTime: 0.25, availableIncomingBitrate: 3_000_000 },
  ];
  return { forEach: (cb: (r: Record<string, unknown>) => void) => rows.forEach(cb) };
}

const ZERO = {
  audioRecv: 0,
  audioLost: 0,
  audioBytes: 0,
  samples: 0,
  concealed: 0,
  silent: 0,
  jbDelay: 0,
  jbEmitted: 0,
  videoRecv: 0,
  videoLost: 0,
  videoBytes: 0,
  decoded: 0,
  dropped: 0,
  freezes: 0,
  freezeS: 0,
};
// 15 s later: 50 audio packets/s with 1% loss, 32 kbps audio, 2% audible concealment, a 60 ms
// jitter buffer, 2 Mbps video at 25 fps with one 400 ms freeze.
const AFTER_15S = {
  audioRecv: 742,
  audioLost: 8,
  audioBytes: 60_000,
  samples: 720_000,
  concealed: 20_000,
  silent: 5_600,
  jbDelay: 43.2,
  jbEmitted: 720,
  videoRecv: 3_000,
  videoLost: 0,
  videoBytes: 3_750_000,
  decoded: 375,
  dropped: 2,
  freezes: 1,
  freezeS: 0.4,
};

describe("windowMeasurements", () => {
  it("turns cumulative counters into the window's rates, and keeps gauges as read", () => {
    const a = readMediaStats(report(ZERO), 0).counters;
    const { counters: b, gauges } = readMediaStats(report(AFTER_15S), 15_000);
    expect(windowMeasurements(a, b, gauges)).toEqual({
      window_s: 15,
      rtt_ms: 250,
      audio_jitter_ms: 12,
      available_in_kbps: 3000,
      audio_loss_pct: 1.1,
      audio_concealed_pct: 2,
      jitter_buffer_ms: 60,
      audio_kbps: 32,
      video_loss_pct: 0,
      video_kbps: 2000,
      video_fps: 25,
      video_frames_dropped: 2,
      video_freezes: 1,
      video_freeze_ms: 400,
    });
    expect(gauges.resolution).toBe("1920x1080");
  });

  it("leaves out what an audio-only connection cannot measure instead of reporting zeros", () => {
    const a = readMediaStats({ forEach: () => undefined }, 0).counters;
    const b = readMediaStats({ forEach: () => undefined }, 15_000).counters;
    const m = windowMeasurements(a, b, { rttMs: null, audioJitterMs: null, availableIncomingKbps: null, resolution: null });
    expect(m).not.toHaveProperty("rtt_ms");
    expect(m).not.toHaveProperty("audio_loss_pct");
    expect(m).not.toHaveProperty("jitter_buffer_ms");
  });
});

describe("MediaQualityWindow", () => {
  it("sends one batched voice.media per window with the call's context, starting from the first tick", () => {
    voiceMetrics.setContext({ interview_id: "iv-media" });
    const sent: { name: string; m: Record<string, number>; p: Record<string, unknown>; urgent?: boolean }[] = [];
    const w = new MediaQualityWindow((name, m, p = {}, urgent) => sent.push({ name, m, p, urgent }));
    w.sample(report(ZERO), 0, "video"); // the baseline
    w.sample(report(AFTER_15S), MEDIA_WINDOW_MS - 2_000, "video"); // window not over yet
    expect(sent).toHaveLength(0);
    w.sample(report(AFTER_15S), MEDIA_WINDOW_MS, "video");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      name: "voice.media",
      urgent: false,
      p: { interview_id: "iv-media", mode: "video", window_index: 0, resolution: "1920x1080" },
    });
    expect(sent[0].m.video_fps).toBe(25);
    // The next window starts where this one ended.
    w.sample(report(AFTER_15S), 2 * MEDIA_WINDOW_MS, "audio-only");
    expect(sent[1].p).toMatchObject({ mode: "audio-only", window_index: 1 });
    expect(sent[1].m.video_fps).toBe(0);
  });

  it("never throws into the health sampler", () => {
    const w = new MediaQualityWindow(() => {
      throw new Error("sink down");
    });
    const bad = { forEach: () => { throw new Error("bad report"); } };
    expect(() => w.sample(bad, 0, "video")).not.toThrow();
    w.sample(report(ZERO), 0, "video");
    expect(() => w.sample(report(AFTER_15S), MEDIA_WINDOW_MS, "video")).not.toThrow();
  });
});
