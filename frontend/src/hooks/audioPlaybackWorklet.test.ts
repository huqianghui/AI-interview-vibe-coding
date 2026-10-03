/**
 * The playback jitter buffer (public/audio-playback-processor.js), perf review P0-2.
 *
 * Loaded the same way as the capture worklet's test: it is a `public/` asset so it cannot be
 * imported, but it uses only `AudioWorkletProcessor`, `registerProcessor` and `sampleRate`, so the
 * test supplies those three and exercises the real file.
 *
 * The last block is the part worth reading — a deterministic A/B against a model of the OLD
 * scheduler under the same arrival pattern. Without it, "the buffer helps" is an assertion.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const RATE = 24_000;
const QUANTUM = 128;
/** Mirrors TARGET_LEAD_MS / RAMP_MS in the worklet. */
const LEAD_MS = 150;
const RAMP_MS = 3;
const leadSamples = Math.ceil((RATE * LEAD_MS) / 1000);
const rampSamples = Math.ceil((RATE * RAMP_MS) / 1000);

interface Stats {
  eventType?: string;
  underruns: number;
  bufferedMs: number;
  state: string;
}

function load(rate = RATE) {
  const src = readFileSync(resolve(__dirname, "../../public/audio-playback-processor.js"), "utf8");
  const stats: Stats[] = [];
  const port = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    postMessage: (m: Stats) => stats.push(m),
  };
  class FakeProcessor {
    port = port;
  }
  let Registered!: new () => { process: (i: unknown[], o: Float32Array[][]) => boolean };
  new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", src)(
    FakeProcessor,
    (_n: string, cls: unknown) => {
      Registered = cls as typeof Registered;
    },
    rate,
  );
  const node = new Registered();
  const out: number[] = [];
  return {
    stats,
    /** Push `n` samples all equal to `value` (Int16 domain), as one `response.audio.delta` would. */
    push: (n: number, value = 16384) => {
      const pcm = new Int16Array(n).fill(value);
      port.onmessage?.({ data: { pcm: pcm.buffer } });
    },
    pushPcm: (pcm: Int16Array) => port.onmessage?.({ data: { pcm: pcm.buffer } }),
    flush: () => port.onmessage?.({ data: { command: "flush" } }),
    /** Render `q` quanta, appending to `out`. */
    render: (q: number) => {
      for (let i = 0; i < q; i++) {
        const buf = new Float32Array(QUANTUM);
        node.process([], [[buf]]);
        out.push(...buf);
      }
    },
    out,
  };
}

describe("playback prebuffer", () => {
  it("outputs silence until the target lead is queued — it does NOT start on the first chunk", () => {
    // This is the whole point. The old scheduler played chunk 1 at `currentTime`, i.e. with no
    // cushion at all, so the very first delivery hiccup was an audible gap.
    const w = load();
    w.push(leadSamples - QUANTUM);
    w.render(4);
    expect(w.out.every((s) => s === 0)).toBe(true);
  });

  it("starts once the lead is reached, and then reproduces the samples", () => {
    const w = load();
    w.push(leadSamples + QUANTUM);
    w.render(Math.ceil((leadSamples + QUANTUM) / QUANTUM));
    // Past the fade-in, every sample is the input value converted to float.
    const steady = w.out.slice(rampSamples, leadSamples);
    expect(steady.every((s) => Math.abs(s - 16384 / 32768) < 1e-6)).toBe(true);
  });

  it("fades in rather than stepping — the first sample is not full amplitude", () => {
    const w = load();
    w.push(leadSamples * 2, 32767);
    w.render(Math.ceil((leadSamples * 2) / QUANTUM));
    expect(w.out[0]).toBe(0);
    // Monotonically rising across the ramp, reaching full scale at its end.
    expect(w.out[Math.floor(rampSamples / 2)]).toBeGreaterThan(0);
    expect(w.out[Math.floor(rampSamples / 2)]).toBeLessThan(0.9);
    expect(w.out[rampSamples]).toBeCloseTo(32767 / 32768, 4);
  });

  it("converts Int16 to float without letting full scale exceed 1.0", () => {
    const w = load();
    const pcm = new Int16Array(leadSamples * 2).fill(-32768);
    w.pushPcm(pcm);
    w.render(Math.ceil((leadSamples * 2) / QUANTUM));
    expect(Math.min(...w.out)).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...w.out)).toBeLessThanOrEqual(1);
    expect(w.out[rampSamples]).toBe(-1);
  });
});

describe("playback underrun", () => {
  /** Fill, play past the fade-in, then let the queue run dry. Returns the worklet. */
  function starve() {
    const w = load();
    w.push(leadSamples + rampSamples, 32767);
    w.render(Math.ceil((leadSamples + rampSamples) / QUANTUM) + 4); // 4 extra quanta: dry
    return w;
  }

  it("counts ONE underrun per gap, not one per silent sample", () => {
    const w = starve();
    const last = w.stats.at(-1);
    // 4 quanta = 512 samples of starvation; a per-sample count would be in the hundreds.
    expect(w.stats.length === 0 || last?.underruns === 1 || last === undefined).toBe(true);
    // Render far longer to be sure the count does not keep climbing while dry.
    w.render(200);
    expect(w.stats.at(-1)!.underruns).toBe(1);
  });

  it("ramps the gap in instead of cutting — no step to zero", () => {
    const w = starve();
    // Find where output first becomes 0 after the steady full-scale run, and check the slope.
    const firstZero = w.out.findIndex((s, i) => i > rampSamples && s === 0);
    expect(firstZero).toBeGreaterThan(rampSamples);
    const ramp = w.out.slice(firstZero - rampSamples, firstZero);
    expect(ramp[0]).toBeGreaterThan(0);
    expect(ramp[0]).toBeLessThan(1);
    // Monotonically decreasing to zero.
    for (let i = 1; i < ramp.length; i++) expect(ramp[i]).toBeLessThanOrEqual(ramp[i - 1]);
  });

  it("RE-ACCUMULATES the lead after a gap instead of restarting on the first sample", () => {
    // The old scheduler's `max(nextPlayTime, currentTime)` resumed with zero cushion, so gaps came
    // in clusters: one hiccup guaranteed the next one. This is the fix for that, not for the gap.
    const w = starve();
    w.push(QUANTUM); // a trickle — far less than the lead
    const before = w.out.length;
    w.render(4);
    expect(w.out.slice(before).every((s) => s === 0)).toBe(true);
    expect(w.stats.at(-1)!.state).toBe("filling");

    w.push(leadSamples); // now enough
    w.render(4);
    expect(w.out.slice(before + 4 * QUANTUM).some((s) => s !== 0)).toBe(true);
  });

  it("recovers with a fade-in, so resuming does not click either", () => {
    const w = starve();
    w.push(leadSamples * 2, 32767);
    const before = w.out.length;
    w.render(4);
    const resumed = w.out.slice(before);
    const firstNonZero = resumed.findIndex((s) => s !== 0);
    expect(firstNonZero).toBeGreaterThanOrEqual(0);
    expect(resumed[firstNonZero]).toBeLessThan(0.9);
  });
});

describe("playback flush", () => {
  it("drops the queue and goes quiet, with a fade rather than a cut", () => {
    const w = load();
    w.push(leadSamples * 4, 32767);
    w.render(Math.ceil(leadSamples / QUANTUM) + 2);
    const before = w.out.length;
    w.flush();
    w.render(8);
    const after = w.out.slice(before);
    // Ramps down, then silence — and the dropped audio never plays.
    expect(after[0]).toBeGreaterThan(0);
    expect(after.slice(rampSamples).every((s) => s === 0)).toBe(true);
  });

  it("does not count the flush as an underrun — it was asked for", () => {
    const w = load();
    w.push(leadSamples * 4, 32767);
    w.render(Math.ceil(leadSamples / QUANTUM) + 2);
    w.flush();
    w.render(200);
    expect(w.stats.at(-1)!.underruns).toBe(0);
  });

  it("can play again after a flush", () => {
    const w = load();
    w.push(leadSamples * 2, 32767);
    w.render(Math.ceil(leadSamples / QUANTUM) + 2);
    w.flush();
    w.render(4);
    const before = w.out.length;
    w.push(leadSamples * 2, 32767);
    w.render(Math.ceil(leadSamples / QUANTUM) + 2);
    expect(w.out.slice(before).some((s) => s !== 0)).toBe(true);
  });
});

describe("playback stats", () => {
  it("reports buffer depth, so the buffer is measurable from the main thread", () => {
    const w = load();
    w.push(leadSamples * 4);
    w.render(Math.ceil((RATE * 0.3) / QUANTUM)); // past one stats interval
    const s = w.stats.at(-1)!;
    expect(s.eventType).toBe("stats");
    expect(s.state).toBe("playing");
    expect(s.bufferedMs).toBeGreaterThan(0);
  });

  it("tracks the sample rate, so the lead stays 150 ms at any context rate", () => {
    for (const rate of [16_000, 24_000, 48_000]) {
      const w = load(rate);
      const lead = Math.ceil((rate * LEAD_MS) / 1000);
      w.push(lead - 1);
      w.render(1);
      expect(w.out.every((s) => s === 0)).toBe(true); // one sample short: still filling
      w.push(QUANTUM * 2);
      w.render(2);
      expect(w.out.some((s) => s !== 0)).toBe(true);
    }
  });
});

describe("A/B against the old scheduler, same arrival pattern", () => {
  /** The OLD playback logic, as a pure model: schedule at max(nextPlayTime, now), zero target lead.
   * Returns the number of gaps (times the pipeline had nothing to play). */
  function oldSchedulerGaps(arrivals: { atMs: number; durMs: number }[]): number {
    let nextPlay = 0;
    let gaps = 0;
    for (const a of arrivals) {
      if (nextPlay < a.atMs) {
        // `max(nextPlayTime, currentTime)` — the pipeline was dry between nextPlay and now.
        if (nextPlay > 0) gaps++;
        nextPlay = a.atMs;
      }
      nextPlay += a.durMs;
    }
    return gaps;
  }

  /** The NEW worklet under the same arrivals, driven in 128-sample steps. */
  function newWorkletUnderruns(arrivals: { atMs: number; durMs: number }[]): number {
    const w = load();
    const quantumMs = (QUANTUM / RATE) * 1000;
    const totalMs = arrivals.at(-1)!.atMs + arrivals.at(-1)!.durMs + 400;
    let i = 0;
    for (let t = 0; t < totalMs; t += quantumMs) {
      while (i < arrivals.length && arrivals[i].atMs <= t) {
        w.push(Math.round((arrivals[i].durMs / 1000) * RATE), 20000);
        i++;
      }
      w.render(1);
    }
    return w.stats.at(-1)?.underruns ?? 0;
  }

  /** 20 ms chunks of audio, delivered every 20 ms except for `stallMs` inserted once mid-stream. */
  function patternWithStall(stallMs: number) {
    const arrivals: { atMs: number; durMs: number }[] = [];
    let at = 0;
    for (let n = 0; n < 60; n++) {
      if (n === 30) at += stallMs;
      arrivals.push({ atMs: at, durMs: 20 });
      at += 20;
    }
    return arrivals;
  }

  it("survives a 100 ms delivery stall that gaps the old scheduler", () => {
    const p = patternWithStall(100);
    expect(oldSchedulerGaps(p)).toBe(1);
    expect(newWorkletUnderruns(p)).toBe(0);
  });

  it("survives a 140 ms stall — just inside the 150 ms lead", () => {
    const p = patternWithStall(140);
    expect(oldSchedulerGaps(p)).toBe(1);
    expect(newWorkletUnderruns(p)).toBe(0);
  });

  it("still gaps on a stall LARGER than the buffer — the buffer is a cushion, not a cure", () => {
    // Stating the limit explicitly matters: 150 ms of lead cannot absorb a 400 ms stall, and a
    // reader who thinks otherwise would size the next change wrongly.
    const p = patternWithStall(400);
    expect(oldSchedulerGaps(p)).toBe(1);
    expect(newWorkletUnderruns(p)).toBe(1);
  });

  it("does not gap at all on a steady stream, old or new", () => {
    const steady = patternWithStall(0);
    expect(oldSchedulerGaps(steady)).toBe(0);
    expect(newWorkletUnderruns(steady)).toBe(0);
  });
});
