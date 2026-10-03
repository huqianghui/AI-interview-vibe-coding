/**
 * The capture worklet (public/audio-processor.js).
 *
 * It had no test at all before the P0-1 batching change, which is a bad place to have no test: it
 * is the one piece of code that decides what Azure hears. A wrong batch size is a silent
 * uplink-rate regression, a wrong clip is audible distortion on the loudest syllable, and a
 * leftover partial batch is audio from one turn appended to the next.
 *
 * The file is a `public/` asset loaded by URL at runtime, so it is not importable. It uses exactly
 * three globals from AudioWorkletGlobalScope, so it can be run here by supplying those three.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

interface Posted {
  msg: { eventType?: string; pcm?: ArrayBuffer };
  transfer?: Transferable[];
}

/** Load the worklet asset with a faked AudioWorkletGlobalScope and return an instance + its outbox. */
function loadProcessor(rate: number) {
  const src = readFileSync(
    resolve(__dirname, "../../public/audio-processor.js"),
    "utf8",
  );
  const posted: Posted[] = [];
  const port = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    postMessage: (msg: Posted["msg"], transfer?: Transferable[]) =>
      posted.push({ msg, transfer }),
  };
  class FakeProcessor {
    port = port;
  }
  let Registered: new () => {
    process: (inputs: Float32Array[][]) => boolean;
    port: typeof port;
  };
  const register = (_name: string, cls: unknown) => {
    Registered = cls as typeof Registered;
  };
  new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", src)(
    FakeProcessor,
    register,
    rate,
  );
  const node = new Registered!();
  return {
    node,
    posted,
    send: (command: string) => port.onmessage?.({ data: { command } }),
    /** Feed `n` render quanta of the spec-mandated 128 frames, all at `value`. */
    feed: (n: number, value = 0.5) => {
      for (let i = 0; i < n; i++)
        node.process([[new Float32Array(128).fill(value)]]);
    },
  };
}

const QUANTUM = 128;

describe("capture worklet batching", () => {
  let w: ReturnType<typeof loadProcessor>;
  beforeEach(() => {
    w = loadProcessor(16_000);
    w.send("START_RECORDING");
  });

  it("stays silent until a full batch exists, then posts exactly one message", () => {
    // 40 ms at 16 kHz = 640 samples = 5 quanta. This is the 5x message reduction, asserted
    // directly.
    w.feed(4);
    expect(w.posted).toHaveLength(0);
    w.feed(1);
    expect(w.posted).toHaveLength(1);
    expect(new Int16Array(w.posted[0].msg.pcm!)).toHaveLength(5 * QUANTUM);
  });

  it("posts one batch per 5 quanta and loses no samples across batches", () => {
    w.feed(20);
    expect(w.posted).toHaveLength(4);
    const total = w.posted.reduce(
      (n, p) => n + new Int16Array(p.msg.pcm!).length,
      0,
    );
    expect(total).toBe(20 * QUANTUM);
  });

  it("TRANSFERS the buffer instead of copying it", () => {
    w.feed(5);
    const { msg, transfer } = w.posted[0];
    expect(transfer).toEqual([msg.pcm]);
  });

  it("hands out a fresh buffer each time — two batches are not the same memory", () => {
    // If the worklet reused one buffer after transferring it, the second batch would write into a
    // detached ArrayBuffer and arrive empty.
    w.feed(10);
    expect(w.posted[0].msg.pcm).not.toBe(w.posted[1].msg.pcm);
    expect(new Int16Array(w.posted[1].msg.pcm!).some((v) => v !== 0)).toBe(
      true,
    );
  });

  it("emits Int16 PCM, and scales full-scale positive to 32767 rather than wrapping", () => {
    // The asymmetric scale matters: +1.0 * 0x8000 overflows to -32768, which turns the loudest
    // positive sample of every syllable into the loudest NEGATIVE one.
    w.feed(5, 1);
    const pcm = new Int16Array(w.posted[0].msg.pcm!);
    expect(pcm[0]).toBe(32767);
    expect([...pcm].every((v) => v === 32767)).toBe(true);
  });

  it("reaches the full negative floor", () => {
    w.feed(5, -1);
    expect(new Int16Array(w.posted[0].msg.pcm!)[0]).toBe(-32768);
  });

  it("clips out-of-range input instead of wrapping it", () => {
    w.feed(5, 4);
    expect(new Int16Array(w.posted[0].msg.pcm!)[0]).toBe(32767);
    const q = loadProcessor(16_000);
    q.send("START_RECORDING");
    q.feed(5, -4);
    expect(new Int16Array(q.posted[0].msg.pcm!)[0]).toBe(-32768);
  });
});

describe("capture worklet gating", () => {
  it("captures nothing before START_RECORDING", () => {
    const w = loadProcessor(16_000);
    w.feed(50);
    expect(w.posted).toHaveLength(0);
  });

  it("DISCARDS a half-collected batch on STOP, so one turn's tail cannot open the next", () => {
    const w = loadProcessor(16_000);
    w.send("START_RECORDING");
    w.feed(3); // half a batch, buffered
    w.send("STOP_RECORDING");
    w.send("START_RECORDING");
    w.feed(5); // a full batch of NEW audio
    expect(w.posted).toHaveLength(1);
    // 5 fresh quanta, not 3 stale + 2 fresh: had the partial survived, the batch would have
    // completed two quanta early and every later batch would straddle the turn boundary.
    expect(new Int16Array(w.posted[0].msg.pcm!)).toHaveLength(5 * QUANTUM);
  });

  it("survives a silent/absent input bus without posting", () => {
    const w = loadProcessor(16_000);
    w.send("START_RECORDING");
    expect(w.node.process([[]])).toBe(true);
    expect(w.node.process([])).toBe(true);
    expect(w.posted).toHaveLength(0);
  });
});

describe("capture worklet batch sizing", () => {
  it("always batches whole render quanta — the spec never delivers a partial one", () => {
    for (const rate of [16_000, 24_000, 44_100, 48_000]) {
      const w = loadProcessor(rate);
      w.send("START_RECORDING");
      w.feed(200);
      expect(w.posted.length).toBeGreaterThan(0);
      const len = new Int16Array(w.posted[0].msg.pcm!).length;
      expect(len % QUANTUM).toBe(0);
    }
  });

  it("tracks the sample rate, so the batch stays ~40 ms rather than a fixed sample count", () => {
    // The rate already moved once (24 kHz → 16 kHz). A hardcoded 640 would have silently become
    // 27 ms at 24 kHz and 13 ms at 48 kHz, quietly giving back the win.
    const ms = (rate: number) => {
      const w = loadProcessor(rate);
      w.send("START_RECORDING");
      w.feed(100);
      return (new Int16Array(w.posted[0].msg.pcm!).length / rate) * 1000;
    };
    expect(ms(16_000)).toBeCloseTo(40, 0);
    for (const rate of [24_000, 44_100, 48_000]) {
      expect(Math.abs(ms(rate) - 40)).toBeLessThan(6);
    }
  });
});
