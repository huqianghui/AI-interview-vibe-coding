/**
 * The avatar's WebRTC media quality, sampled while the call runs and sent as `voice.media` every
 * MEDIA_WINDOW_MS. The media flows browser ↔ Azure's TURN relay and never passes our backend, so
 * the browser's own `getStats()` is the only place it can be seen.
 *
 * Fed by the avatar health sampler (useAvatarStream, every 2 s), which already reads the report:
 * this adds no polling of its own. A window turns the report's cumulative counters into rates over
 * the window; gauges (RTT, jitter) are the window's last reading.
 */
import { trackEvent } from "./appInsights";
import { voiceMetrics } from "./voiceTimeline";

export const MEDIA_WINDOW_MS = 15_000;

/** Every measurement a `voice.media` window can carry (the docs and the workbook are pinned to it). */
export const MEDIA_MEASUREMENTS = [
  "window_s",
  "rtt_ms",
  "audio_jitter_ms",
  "available_in_kbps",
  "audio_loss_pct",
  "audio_concealed_pct",
  "jitter_buffer_ms",
  "audio_kbps",
  "video_loss_pct",
  "video_kbps",
  "video_fps",
  "video_frames_dropped",
  "video_freezes",
  "video_freeze_ms",
] as const;

type Row = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

interface Counters {
  at: number;
  audioPacketsReceived: number;
  audioPacketsLost: number;
  audioBytes: number;
  audioSamples: number;
  audioConcealed: number;
  audioSilentConcealed: number;
  jitterBufferDelay: number;
  jitterBufferEmitted: number;
  videoPacketsReceived: number;
  videoPacketsLost: number;
  videoBytes: number;
  framesDecoded: number;
  framesDropped: number;
  freezeCount: number;
  freezeSeconds: number;
}

interface Gauges {
  rttMs: number | null;
  audioJitterMs: number | null;
  availableIncomingKbps: number | null;
  resolution: string | null;
}

/** Read the counters and gauges a window needs from one getStats report. */
export function readMediaStats(report: { forEach(cb: (row: Row) => void): void }, at: number) {
  const rows: Row[] = [];
  report.forEach((row) => rows.push(row));
  const audio = rows.find((r) => r.type === "inbound-rtp" && r.kind === "audio");
  const video = rows.find((r) => r.type === "inbound-rtp" && r.kind === "video");
  const transport = rows.find((r) => r.type === "transport");
  const pairId = transport?.selectedCandidatePairId;
  const pair =
    (typeof pairId === "string" ? rows.find((r) => r.id === pairId) : undefined) ??
    rows.find((r) => r.type === "candidate-pair" && r.nominated === true && r.state === "succeeded");
  const counters: Counters = {
    at,
    audioPacketsReceived: num(audio?.packetsReceived),
    audioPacketsLost: num(audio?.packetsLost),
    audioBytes: num(audio?.bytesReceived),
    audioSamples: num(audio?.totalSamplesReceived),
    audioConcealed: num(audio?.concealedSamples),
    audioSilentConcealed: num(audio?.silentConcealedSamples),
    jitterBufferDelay: num(audio?.jitterBufferDelay),
    jitterBufferEmitted: num(audio?.jitterBufferEmittedCount),
    videoPacketsReceived: num(video?.packetsReceived),
    videoPacketsLost: num(video?.packetsLost),
    videoBytes: num(video?.bytesReceived),
    framesDecoded: num(video?.framesDecoded),
    framesDropped: num(video?.framesDropped),
    freezeCount: num(video?.freezeCount),
    freezeSeconds: num(video?.totalFreezesDuration),
  };
  const gauges: Gauges = {
    rttMs: typeof pair?.currentRoundTripTime === "number" ? pair.currentRoundTripTime * 1000 : null,
    audioJitterMs: typeof audio?.jitter === "number" ? audio.jitter * 1000 : null,
    availableIncomingKbps:
      typeof pair?.availableIncomingBitrate === "number" ? pair.availableIncomingBitrate / 1000 : null,
    resolution:
      typeof video?.frameWidth === "number" && typeof video?.frameHeight === "number"
        ? `${video.frameWidth}x${video.frameHeight}`
        : null,
  };
  return { counters, gauges };
}

const pct = (part: number, whole: number): number | undefined =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : undefined;

/** One window's measurements from its first and last counters (exported for tests). */
export function windowMeasurements(a: Counters, b: Counters, g: Gauges): Record<string, number> {
  const seconds = (b.at - a.at) / 1000;
  const d = (k: keyof Counters) => Math.max(0, b[k] - a[k]);
  const out: Record<string, number | undefined> = {
    window_s: Math.round(seconds),
    rtt_ms: g.rttMs === null ? undefined : Math.round(g.rttMs),
    audio_jitter_ms: g.audioJitterMs === null ? undefined : Math.round(g.audioJitterMs),
    available_in_kbps:
      g.availableIncomingKbps === null ? undefined : Math.round(g.availableIncomingKbps),
    audio_loss_pct: pct(d("audioPacketsLost"), d("audioPacketsLost") + d("audioPacketsReceived")),
    // Audible concealment only: silence fill is not damage (see avatarHealth.readHealth).
    audio_concealed_pct: pct(
      Math.max(0, d("audioConcealed") - d("audioSilentConcealed")),
      d("audioSamples"),
    ),
    jitter_buffer_ms:
      d("jitterBufferEmitted") > 0
        ? Math.round((d("jitterBufferDelay") / d("jitterBufferEmitted")) * 1000)
        : undefined,
    audio_kbps: seconds > 0 ? Math.round((d("audioBytes") * 8) / seconds / 1000) : undefined,
    video_loss_pct: pct(d("videoPacketsLost"), d("videoPacketsLost") + d("videoPacketsReceived")),
    video_kbps: seconds > 0 ? Math.round((d("videoBytes") * 8) / seconds / 1000) : undefined,
    video_fps: seconds > 0 ? Math.round((d("framesDecoded") / seconds) * 10) / 10 : undefined,
    video_frames_dropped: d("framesDropped"),
    video_freezes: d("freezeCount"),
    video_freeze_ms: Math.round(d("freezeSeconds") * 1000),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as Record<
    string,
    number
  >;
}

type Emit = typeof trackEvent;

/** Windows over one peer connection's stats. `sample()` on every health tick; it sends a window
 * once MEDIA_WINDOW_MS have passed since the window began. */
/** A partial window shorter than this is not worth sending when a connection ends. */
export const MIN_PARTIAL_WINDOW_MS = 5_000;

/** A cumulative counter went DOWN: the stream restarted (e.g. a new SSRC on the same connection). */
function restarted(a: Counters, b: Counters): boolean {
  return (Object.keys(a) as (keyof Counters)[]).some((k) => k !== "at" && b[k] < a[k]);
}

/** Windows over one peer connection's stats. `sample()` on every health tick (with a monotonic
 * clock: `performance.now()`); it sends a window once MEDIA_WINDOW_MS have passed since the window
 * began. `finish()` when the connection ends sends the partial window, which is often the degraded
 * stretch that made it end. */
export class MediaQualityWindow {
  private start: Counters | null = null;
  private last: { counters: Counters; gauges: Gauges; mode: string } | null = null;
  private index = 0;

  constructor(private readonly emit: Emit = trackEvent) {}

  sample(report: { forEach(cb: (row: Row) => void): void }, at: number, mode: string): void {
    try {
      const { counters, gauges } = readMediaStats(report, at);
      if (!this.start || restarted(this.start, counters)) {
        // A rate across a counter reset would be invented: start a fresh window instead.
        this.start = counters;
        this.last = null;
        return;
      }
      this.last = { counters, gauges, mode };
      if (at - this.start.at >= MEDIA_WINDOW_MS) this.send();
    } catch (err) {
      console.debug("[telemetry] media sample failed", err);
    }
  }

  /** The connection is ending: send what the current window has, if it is long enough to mean
   * anything. */
  finish(): void {
    try {
      if (this.start && this.last && this.last.counters.at - this.start.at >= MIN_PARTIAL_WINDOW_MS) {
        this.send(true);
      }
      this.start = null;
      this.last = null;
    } catch (err) {
      console.debug("[telemetry] media finish failed", err);
    }
  }

  private send(partial = false): void {
    if (!this.start || !this.last) return;
    const { counters, gauges, mode } = this.last;
    const props: Record<string, string | number | boolean> = {
      ...voiceMetrics.contextSnapshot,
      mode,
      window_index: this.index,
      partial,
    };
    if (gauges.resolution) props.resolution = gauges.resolution;
    // Periodic: rides the SDK's next batch rather than flushing on every window.
    this.emit("voice.media", windowMeasurements(this.start, counters, gauges), props, false);
    this.index += 1;
    this.start = counters;
    this.last = null;
  }
}
