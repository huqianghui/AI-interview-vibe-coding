/**
 * Jitter-buffered playback worklet for the interviewer's voice (perf review P0-2).
 *
 * WHICH PATH THIS IS. With a digital human, the interviewer's audio arrives on the avatar's WebRTC
 * track and never touches this file. This is the OTHER path: a persona with no avatar, and — the
 * reason it is a P0 — the fallback meant to survive the worst networks, where UDP is blocked
 * entirely and the session is rebuilt without `avatar` so the audio rides the WebSocket as PCM
 * (`docs/avatar-weaknet-probe.md` §5.6). That is to say: the path we hold in reserve for bad links
 * had no resistance to a bad link.
 *
 * WHAT WAS WRONG. Playback used to schedule each `response.audio.delta` as its own
 * AudioBufferSourceNode at `max(nextPlayTime, currentTime)`. Two consequences:
 *
 *   - The TARGET LEAD WAS ZERO. The first chunk was scheduled at `currentTime` — already a render
 *     quantum late — and from then on the pipeline only had whatever cushion Azure's bursts happened
 *     to leave. Any delivery gap larger than that cushion is silence in the middle of a word.
 *   - Each gap COSTS TWICE. The waveform jumps to zero and back, which is an audible click at both
 *     edges, and `max(..., currentTime)` then resumes with no cushion at all — so the next gap is
 *     likelier than the last.
 *
 * WHY A WORKLET AND NOT A SMARTER SCHEDULER. Three things get easy here and stay hard with
 * BufferSources: a gap can be ramped instead of cut (we own every output sample), underruns can be
 * COUNTED rather than inferred (so the fix is measurable at all), and the queue can be dropped in
 * one message — which is what `stopAudio` needed in order to stop without closing the whole
 * AudioContext and re-entering the browser's autoplay gate. (Dropping the queue is also what
 * barge-in will need; that is not wired yet — see `flushPlayback` in useVoiceAudio.ts.)
 *
 * NO SharedArrayBuffer. The textbook ring buffer shares memory with the main thread, which needs
 * cross-origin isolation (COOP + COEP) — headers this deployment does not set and should not have to
 * set for one audio path. Chunks arrive by `postMessage` with the buffer transferred instead; the
 * queue lives entirely in here, so the only cost is that the main thread cannot read the buffer
 * depth directly. Hence the stats messages below.
 */

/** How much audio to hold before starting, and to re-accumulate after an underrun.
 *
 * This is a conversation, so the buffer is a latency/robustness trade and not a free win: every
 * millisecond here is a millisecond later the candidate hears the question, and a millisecond more
 * of the interviewer's voice already committed when the candidate interrupts.
 *
 * 300 ms IS A MEASURED VALUE, AND THE SURPRISE IS WHAT IT IS SIZED AGAINST. It is not network
 * jitter — it is AZURE'S OWN DELTA PACING. Measured on the live WS PCM path, logging each
 * `response.audio.delta`'s arrival interval against the audio it carries (one response, ~4.2 s of
 * speech in 10 deltas):
 *
 *   arrival gap   0   249    19   242     7    64   180     1     4     2  (ms)
 *   audio in it 200   300   500   500   500   500   500   500   500   275  (ms)
 *
 * Azure delivers far faster than realtime overall — the cushion grows past 3 s by the end — but the
 * FIRST delta carries only 200 ms and the second arrives ~250 ms later, and ~250 ms is the modal
 * interval. So the whole risk is concentrated in the first second, and a 150 ms threshold releases
 * playback too early to survive it: measured at 150 ms, the first utterance stuttered with a 48 ms
 * gap, exactly the 251 − 200 the table predicts. At 300 ms the same pacing plays through clean.
 *
 * THE COST IS ABOUT 100 ms, not 150: at 150 ms playback began ~150 ms after the first delta; at
 * 300 ms it waits for the second delta at ~250 ms. Against this app's measured ~1 s turn latency,
 * that buys a first word without a stutter.
 *
 * IT IS A CUSHION, NOT A CURE, and the measurements say so plainly: a third run saw Azure itself go
 * quiet for 1441 ms mid-response — 5x this buffer — and no threshold anyone would accept in a
 * conversation can absorb that. What the buffer does there is turn a click into a ramped dip and
 * count it, so the gap is diagnosable instead of anecdotal.
 *
 * Note what it does NOT control: how much audio is pending overall. The target is the floor the
 * buffer refuses to go below, not the amount of audio in flight. */
const TARGET_LEAD_MS = 300;

/** Fade length at a discontinuity. Long enough to remove the click (a step is broadband; 3 ms of
 * ramp pushes the energy below ~300 Hz where there is little of it), short enough to be inaudible
 * as a volume change. */
const RAMP_MS = 3;

/** How often to report buffer depth and underruns to the main thread. Frequent enough to catch a
 * dip, rare enough not to post hundreds of messages a second from the audio thread. */
const STATS_INTERVAL_MS = 250;

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    /** Int16 chunks, oldest first. Each is exactly what arrived in one `response.audio.delta`. */
    this.queue = [];
    /** Read offset into `queue[0]`, in samples. */
    this.offset = 0;
    /** Samples currently queued (kept as a running total so `process` never walks the queue). */
    this.queued = 0;

    this.targetSamples = Math.ceil((sampleRate * TARGET_LEAD_MS) / 1000);
    this.rampSamples = Math.max(1, Math.ceil((sampleRate * RAMP_MS) / 1000));
    this.statsInterval = Math.ceil((sampleRate * STATS_INTERVAL_MS) / 1000);

    /** "filling" = waiting for the target lead; "playing" = draining the queue; "ramping-out" =
     * the queue ran dry and we are easing the last sample to zero rather than cutting it. */
    this.state = "filling";
    /** Remaining fade-in samples (set when playback starts, so the first sample is not a step). */
    this.fadeIn = 0;
    /** Remaining fade-out samples, and the value being faded from. */
    this.fadeOut = 0;
    this.lastSample = 0;

    this.underruns = 0;
    /** Length of the most recent gap, in samples. The buffer depth at REPORT time is useless for
     * diagnosis — by then the audio that ended the gap has arrived (measured live: a warning said
     * "buffer 757ms" about a gap that by definition happened at depth zero). How long the
     * interviewer was silent is the number that says whether it was a click or a dropout. */
    this.gapSamples = 0;
    this.lastGapSamples = 0;
    /** A counted gap is open (from the underrun until playback resumes). Only then is silence gap
     * time: without it, every pause between utterances after the session's first underrun was
     * measured as part of that gap, and the next utterance's start reported it as a long one. */
    this.inGap = false;
    /** All gap time so far, so the page can add up gaps without pairing each one to its report. */
    this.totalGapSamples = 0;
    this.sinceStats = 0;
    /** Set by the main thread when Azure says the response's audio is complete
     * (`response.audio.done`). Cleared by the next chunk that arrives.
     *
     * Without it the counter is useless, which a test caught before this shipped: from inside the
     * worklet, "the sentence ended" and "the network stalled" are the same event — the queue goes
     * empty — so a run of normal speech would have logged one underrun PER UTTERANCE and the metric
     * P0-2 is judged by would have measured nothing. The main thread is the only side that knows
     * which it was. */
    this.endOfStream = false;

    this.port.onmessage = (e) => {
      const data = e.data;
      if (data.pcm) {
        const chunk = new Int16Array(data.pcm);
        if (chunk.length > 0) {
          this.queue.push(chunk);
          this.queued += chunk.length;
          // More audio is coming after all — whatever drain follows is a stall, not an ending.
          this.endOfStream = false;
        }
        return;
      }
      if (data.command === "end") {
        this.endOfStream = true;
        return;
      }
      if (data.command === "flush") {
        // Drop everything, immediately, with a fade so even this abrupt stop does not click.
        // Currently called on session teardown only. It is also what barge-in WOULD need — see
        // `flushPlayback` in useVoiceAudio.ts for why that is not wired yet.
        this.queue.length = 0;
        this.offset = 0;
        this.queued = 0;
        this.underruns = 0;
        this.inGap = false;
        this.gapSamples = 0;
        this.totalGapSamples = 0;
        this.endOfStream = true;
        if (this.state === "playing") {
          this.state = "ramping-out";
          this.fadeOut = this.rampSamples;
        }
      }
    };
  }

  /** Pull one sample from the queue. Only valid when `this.queued > 0`. */
  _shift() {
    const chunk = this.queue[0];
    const raw = chunk[this.offset++];
    if (this.offset >= chunk.length) {
      this.queue.shift();
      this.offset = 0;
    }
    this.queued--;
    // Int16 → float. Divide by 32768 for both signs: it is the inverse of the capture side's
    // asymmetric scale, and the half-LSB of error it leaves on positive samples is inaudible,
    // whereas dividing by 32767 would let a full-scale sample exceed 1.0 and clip downstream.
    return raw / 32768;
  }

  /** One output sample, advancing the state machine. */
  _next() {
    if (this.state === "filling") {
      if (this.queued < this.targetSamples) {
        // Silence while refilling after a counted gap is part of that gap, so measure it here.
        if (this.inGap) this.gapSamples++;
        return 0;
      }
      if (this.inGap) {
        this.lastGapSamples = this.gapSamples;
        this.totalGapSamples += this.gapSamples;
        this.inGap = false;
      }
      this.state = "playing";
      this.fadeIn = this.rampSamples;
      // Sent at once, not with the next stats tick (up to 250 ms later): the page times "the
      // candidate starts hearing the interviewer" from this message (voiceTimeline.ts).
      this.port.postMessage({ eventType: "started" });
    }

    if (this.state === "playing") {
      if (this.queued > 0) {
        let s = this._shift();
        if (this.fadeIn > 0) {
          // Ramp 0 → 1 across rampSamples.
          s *= (this.rampSamples - this.fadeIn) / this.rampSamples;
          this.fadeIn--;
        }
        this.lastSample = s;
        return s;
      }
      // Ran dry. Count it ONLY if audio was still expected — one per gap, not per silent sample.
      // An expected ending drains the same way and must not be counted (see `endOfStream`).
      if (!this.endOfStream) {
        this.underruns++;
        this.gapSamples = 0;
        this.inGap = true;
      }
      this.state = "ramping-out";
      this.fadeOut = this.rampSamples;
    }

    if (this.state === "ramping-out") {
      if (this.fadeOut > 0) {
        // Ease the last value to zero. There is no real audio to play here — this exists only so
        // the gap starts with a slope instead of a step.
        const s = (this.lastSample * this.fadeOut) / this.rampSamples;
        this.fadeOut--;
        return s;
      }
      // Back to waiting for a full cushion, rather than restarting on the first sample that
      // arrives. Resuming with no lead is what made the old scheduler's gaps come in clusters.
      this.state = "filling";
      this.lastSample = 0;
    }

    return 0;
  }

  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    for (let i = 0; i < out.length; i++) out[i] = this._next();

    this.sinceStats += out.length;
    if (this.sinceStats >= this.statsInterval) {
      this.sinceStats = 0;
      this.port.postMessage({
        eventType: "stats",
        underruns: this.underruns,
        bufferedMs: (this.queued / sampleRate) * 1000,
        lastGapMs: (this.lastGapSamples / sampleRate) * 1000,
        totalGapMs: (this.totalGapSamples / sampleRate) * 1000,
        state: this.state,
      });
    }
    // Never return false: this node stays connected for the life of the session and must keep
    // pulling, otherwise the first chunk after a quiet spell would have nothing running to play it.
    return true;
  }
}

registerProcessor("audio-playback-processor", PlaybackProcessor);
