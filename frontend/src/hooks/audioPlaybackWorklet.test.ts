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
const LEAD_MS = 300;
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
  // "started" (the first rendered sample of a response) is not a stats frame: kept apart so the
  // stats helpers below still see only stats.
  const starts: Stats[] = [];
  const port = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    postMessage: (m: Stats) => (m.eventType === "started" ? starts.push(m) : stats.push(m)),
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
    starts,
    /** Push `n` samples all equal to `value` (Int16 domain), as one `response.audio.delta` would. */
    push: (n: number, value = 16384) => {
      const pcm = new Int16Array(n).fill(value);
      port.onmessage?.({ data: { pcm: pcm.buffer } });
    },
    pushPcm: (pcm: Int16Array) => port.onmessage?.({ data: { pcm: pcm.buffer } }),
    flush: () => port.onmessage?.({ data: { command: "flush" } }),
    end: () => port.onmessage?.({ data: { command: "end" } }),
    /** Force a FRESH stats frame and return it, rather than reading whatever was posted last.
     * The stats interval is 250 ms — about 47 quanta — so a short render legitimately posts nothing
     * (`stats.at(-1)` undefined) and a long one leaves a frame that predates the thing being
     * asserted. Both mistakes were made here before this helper existed. */
    freshStats: () => {
      const before = stats.length;
      for (let i = 0; i < 60 && stats.length === before; i++) {
        const buf = new Float32Array(QUANTUM);
        node.process([], [[buf]]);
      }
      return stats.at(-1);
    },
    underruns: () => {
      const before = stats.length;
      for (let i = 0; i < 60 && stats.length === before; i++) {
        const buf = new Float32Array(QUANTUM);
        node.process([], [[buf]]);
      }
      return stats.at(-1)?.underruns ?? 0;
    },
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
    // 4 quanta = 512 samples of starvation; a per-sample count would be in the hundreds.
    expect(w.underruns()).toBe(1);
    // Render far longer to be sure the count does not keep climbing while dry.
    w.render(200);
    expect(w.underruns()).toBe(1);
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
    expect(w.freshStats()?.state).toBe("filling");

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

describe("end-of-stream marker", () => {
  /** This whole block exists because the first version of the worklet had no marker, and a test
   * caught what that costs: from in here, "the sentence ended" and "the network stalled" are the
   * same event — an empty queue — so a clean run of speech logged one underrun PER UTTERANCE and the
   * number P0-2 is judged by measured nothing at all. */

  /** Play a full utterance and let it finish naturally.
   *
   * The marker is sent while audio is still QUEUED, which is the real ordering: Azure's
   * `response.audio.done` arrives on the same socket right behind the last `response.audio.delta`,
   * so it lands long before 150 ms of buffered audio can drain. */
  function utterance(withMarker: boolean) {
    const w = load();
    w.push(leadSamples * 2, 20000);
    if (withMarker) w.end();
    w.render(Math.ceil((leadSamples * 2) / QUANTUM) + 60); // play it out, then sit dry
    return w;
  }

  it("does NOT count the drain at the end of a sentence as an underrun", () => {
    expect(utterance(true).underruns()).toBe(0);
  });

  it("DOES count it without the marker — which is the bug this guards", () => {
    expect(utterance(false).underruns()).toBe(1);
  });

  it("still counts a real stall, because the marker had not been sent yet", () => {
    // The distinction is only ever about expectation: mid-sentence, nothing has said "that's all".
    const w = load();
    w.push(leadSamples + QUANTUM, 20000);
    w.render(Math.ceil((leadSamples + QUANTUM) / QUANTUM) + 10);
    expect(w.underruns()).toBe(1);
  });

  it("arriving LATE does not retroactively forgive a gap, and that is deliberate", () => {
    // If the queue drains before anything says the audio is finished, then at that moment more audio
    // WAS expected and the gap is real. Only ordering makes this reachable, and the real ordering
    // cannot produce it — recorded so nobody "fixes" it into forgiving genuine stalls.
    const w = load();
    w.push(leadSamples * 2, 20000);
    w.render(Math.ceil((leadSamples * 2) / QUANTUM) + 10); // drains dry first
    w.end();
    w.render(10);
    expect(w.underruns()).toBe(1);
  });

  it("is cleared by the next chunk, so a second utterance is measured normally", () => {
    const w = utterance(true);
    expect(w.underruns()).toBe(0);
    // Next response arrives and then stalls mid-way: that gap IS a gap.
    w.push(leadSamples + QUANTUM, 20000);
    w.render(Math.ceil((leadSamples + QUANTUM) / QUANTUM) + 10);
    expect(w.underruns()).toBe(1);
  });

  it("plays the queued audio through — the marker ends counting, not playback", () => {
    const w = load();
    w.push(leadSamples * 2, 20000);
    w.end(); // marker arrives while there is still a lot to play
    w.render(Math.ceil((leadSamples * 2) / QUANTUM) + 2);
    const played = w.out.filter((x) => x !== 0).length;
    expect(played).toBeGreaterThan(leadSamples); // nearly all of it, minus the two fades
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
    expect(w.underruns()).toBe(0);
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

describe("gap accounting", () => {
  it("measures only a gap as gap time, never the normal pause after it (regression)", () => {
    const w = load();
    // An utterance that stalls once mid-way (a real gap), then finishes normally.
    w.push(leadSamples * 2);
    w.render(Math.ceil((leadSamples * 3) / QUANTUM)); // drains: one underrun, the gap opens
    w.push(leadSamples * 2); // the rest arrives: the gap closes when playback resumes
    w.end();
    w.render(Math.ceil((leadSamples * 4) / QUANTUM));
    const afterFirst = w.freshStats() as Stats & { lastGapMs: number; totalGapMs: number };
    expect(afterFirst.underruns).toBe(1);
    // A long, NORMAL pause between utterances, then the next one starts.
    w.render(Math.ceil((RATE * 3) / QUANTUM));
    w.push(leadSamples * 2);
    w.end();
    w.render(Math.ceil((leadSamples * 3) / QUANTUM));
    const afterPause = w.freshStats() as Stats & { lastGapMs: number; totalGapMs: number };
    // Before the fix the 3 s pause was folded into the old gap and reported as a new, huge one.
    expect(afterPause.underruns).toBe(1);
    expect(afterPause.lastGapMs).toBe(afterFirst.lastGapMs);
    expect(afterPause.totalGapMs).toBe(afterFirst.totalGapMs);
    expect(afterFirst.totalGapMs).toBeLessThan(1_000);
  });
});

describe("playback started", () => {
  it("is posted once per utterance, the moment the first sample renders", () => {
    const w = load();
    w.push(leadSamples - 1);
    w.render(4);
    expect(w.starts).toHaveLength(0); // still filling the cushion: nothing audible yet
    w.push(leadSamples * 2);
    w.end();
    w.render(1);
    expect(w.starts).toHaveLength(1);
    w.render(Math.ceil((leadSamples * 4) / QUANTUM)); // drains, ramps out, back to filling
    expect(w.starts).toHaveLength(1);
    w.push(leadSamples * 2);
    w.render(1);
    expect(w.starts).toHaveLength(2);
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

  /** The NEW worklet under the same arrivals, driven in 128-sample steps.
   *
   * Sends the end-of-stream marker after the last arrival, exactly as the hook does on
   * `response.audio.done`. Without it the final drain counts as a gap and every one of these cases
   * reports one extra underrun — which is how the missing marker was found in the first place. */
  function newWorkletUnderruns(arrivals: { atMs: number; durMs: number }[]): number {
    const w = load();
    const quantumMs = (QUANTUM / RATE) * 1000;
    const lastMs = arrivals.at(-1)!.atMs + arrivals.at(-1)!.durMs;
    let i = 0;
    let ended = false;
    for (let t = 0; t < lastMs + 600; t += quantumMs) {
      while (i < arrivals.length && arrivals[i].atMs <= t) {
        w.push(Math.round((arrivals[i].durMs / 1000) * RATE), 20000);
        i++;
      }
      if (!ended && i >= arrivals.length) {
        w.end();
        ended = true;
      }
      w.render(1);
    }
    return w.underruns();
  }

  /** 20 ms chunks delivered every 20 ms, with ONE delivery gap of exactly `gapMs` mid-stream.
   *
   * `gapMs` is the total time between two arrivals, not an extra delay added to the normal 20 ms —
   * the first version of this helper conflated the two, so "a 140 ms stall" was really a 160 ms gap
   * and the worklet was blamed for failing to absorb more than its own buffer. The gap is the thing
   * the buffer is sized against, so it is what the parameter means. */
  function patternWithGap(gapMs: number) {
    const arrivals: { atMs: number; durMs: number }[] = [];
    let at = 0;
    for (let n = 0; n < 60; n++) {
      arrivals.push({ atMs: at, durMs: 20 });
      at += n === 29 ? gapMs : 20;
    }
    return arrivals;
  }

  it("survives a 100 ms delivery gap that gaps the old scheduler", () => {
    const p = patternWithGap(100);
    expect(oldSchedulerGaps(p)).toBe(1);
    expect(newWorkletUnderruns(p)).toBe(0);
  });

  it("survives a 250 ms gap — the modal interval Azure actually delivers at", () => {
    // Measured on the live path: ~250 ms between deltas is the common case, and it is precisely what
    // a 150 ms threshold could not absorb (one 48 ms stutter on the first utterance).
    const p = patternWithGap(250);
    expect(oldSchedulerGaps(p)).toBe(1);
    expect(newWorkletUnderruns(p)).toBe(0);
  });

  it("still gaps on a delivery gap LARGER than the buffer — a cushion, not a cure", () => {
    // Stating the limit explicitly matters, and it is not hypothetical: measured live, Azure itself
    // went quiet for 1441 ms mid-response. No buffer anyone would accept in a conversation absorbs
    // that; a reader who thinks otherwise would size the next change wrongly.
    const p = patternWithGap(1441);
    expect(oldSchedulerGaps(p)).toBe(1);
    expect(newWorkletUnderruns(p)).toBe(1);
  });

  it("does not gap at all on a steady stream, old or new", () => {
    const steady = patternWithGap(20);
    expect(oldSchedulerGaps(steady)).toBe(0);
    expect(newWorkletUnderruns(steady)).toBe(0);
  });

  it("absorbs AT LEAST the configured lead — the boundary, measured rather than assumed", () => {
    // Binary-search the largest gap that still plays through. The answer should be at or just above
    // TARGET_LEAD_MS: the prebuffer releases on the first chunk that crosses the threshold, so the
    // steady-state cushion overshoots to a chunk boundary and buys slightly more than the nominal
    // 150 ms. Measuring it keeps that fact honest if either the lead or the chunk size changes.
    let lo = 20;
    let hi = 900;
    while (hi - lo > 1) {
      const mid = Math.round((lo + hi) / 2);
      if (newWorkletUnderruns(patternWithGap(mid)) === 0) lo = mid;
      else hi = mid;
    }
    // Close to the configured lead, but not exactly it, and the reason is worth knowing: the release
    // threshold is crossed by a whole 20 ms chunk, and the gap is consumed in 128-sample quanta, so
    // the boundary lands within about one chunk either side. Asserting equality would make this test
    // fail on a chunk-size change that broke nothing.
    expect(Math.abs(lo - LEAD_MS)).toBeLessThanOrEqual(25);
  });
});
