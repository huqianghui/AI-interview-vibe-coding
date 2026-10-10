/**
 * Voice timings, measured in the browser where the candidate experiences them, and sent to
 * Application Insights as three custom events:
 *
 * - `voice.setup`: once per voice connection. WebSocket open → `proxy.connected` →
 *   `session.updated` → first avatar frame → first interviewer audio actually heard.
 * - `voice.avatar`: once per avatar WebRTC handshake (the first one, every recovery rebuild, every
 *   media-mode switch). ICE gathering (first host / srflx (= the STUN answer) / relay (= the TURN
 *   allocation) candidate), our offer gate, Azure's SDP answer, ICE connected, first track, first
 *   painted frame, plus the selected candidate pair and its RTT.
 * - `voice.turn`: once per interviewer response. Everything from the end of the previous response:
 *   the candidate speaking (VAD), speech-to-text, "I'm done" waiting for the transcript, the
 *   `/answer` round trip (the brain or judge), the read request, `response.created`, the first text
 *   and audio deltas, the first sample the candidate actually HEARS, `response.done`.
 *
 * Every event carries `t_<mark>` offsets (ms from the event's first mark) for a waterfall and the
 * named durations below. Only timings, ids and outcomes: never text.
 *
 * All times come from `performance.now()`; the marks are pure bookkeeping, so the rules (first vs
 * last occurrence, when a turn closes) are unit-tested here instead of in the hooks.
 */
import { trackEvent } from "./appInsights";

type Properties = Record<string, string | number | boolean>;
export type Clock = () => number;

/** A named duration: `to - from`, reported only when both marks exist. */
export type SpanDef = readonly [name: string, from: string, to: string];

export class Timeline {
  private readonly marks = new Map<string, number>();

  constructor(private readonly clock: Clock = () => performance.now()) {}

  /** Record `name` at its FIRST occurrence; later calls are ignored. */
  mark(name: string, at: number = this.clock()): void {
    if (!this.marks.has(name)) this.marks.set(name, at);
  }

  /** Record `name` at its LATEST occurrence (e.g. the last VAD segment before a submit). */
  markLast(name: string, at: number = this.clock()): void {
    this.marks.set(name, at);
  }

  has(name: string): boolean {
    return this.marks.has(name);
  }

  get isEmpty(): boolean {
    return this.marks.size === 0;
  }

  /** `t_<mark>` offsets from the earliest mark, plus every span whose two ends exist. */
  measurements(spans: readonly SpanDef[]): Record<string, number> {
    const out: Record<string, number> = {};
    if (this.marks.size === 0) return out;
    const start = Math.min(...this.marks.values());
    for (const [name, at] of this.marks) out[`t_${name}`] = Math.round(at - start);
    for (const [name, from, to] of spans) {
      const a = this.marks.get(from);
      const b = this.marks.get(to);
      if (a !== undefined && b !== undefined) out[name] = Math.round(b - a);
    }
    return out;
  }
}

export const SETUP_SPANS: readonly SpanDef[] = [
  ["ws_open_ms", "connect_start", "ws_open"],
  ["proxy_connected_ms", "connect_start", "proxy_connected"],
  ["session_updated_ms", "connect_start", "session_updated"],
  ["first_video_frame_ms", "connect_start", "first_video_frame"],
  ["media_ready_ms", "connect_start", "media_ready"],
  ["first_audible_ms", "connect_start", "first_audible"],
];

export const AVATAR_SPANS: readonly SpanDef[] = [
  // Waiting out Azure's avatar request allowance before the offer (0 unless reconnecting fast).
  ["hold_ms", "pc_created", "offer_start"],
  ["create_offer_ms", "offer_start", "offer_created"],
  ["stun_srflx_ms", "offer_created", "first_srflx"],
  ["turn_relay_ms", "offer_created", "first_relay"],
  ["first_host_ms", "offer_created", "first_host"],
  ["ice_gather_ms", "offer_created", "offer_sent"],
  ["sdp_answer_ms", "offer_sent", "answer_received"],
  ["ice_connect_ms", "answer_applied", "ice_connected"],
  ["pc_connect_ms", "answer_applied", "pc_connected"],
  ["first_track_ms", "answer_applied", "first_track"],
  ["first_frame_ms", "ice_connected", "first_frame"],
  ["total_ms", "offer_start", "first_frame"],
  ["total_audio_ms", "offer_start", "audio_live"],
];

export const TURN_SPANS: readonly SpanDef[] = [
  ["speaking_ms", "speech_started", "speech_stopped"],
  ["stt_ms", "speech_stopped", "transcript"],
  ["commit_wait_ms", "answer_click", "answer_submit"],
  ["answer_http_ms", "answer_submit", "answer_response"],
  ["answer_to_read_ms", "answer_response", "read_request"],
  ["read_to_created_ms", "read_request", "response_created"],
  ["created_to_first_text_ms", "response_created", "first_text"],
  ["created_to_first_audio_delta_ms", "response_created", "first_audio_delta"],
  ["created_to_audible_ms", "response_created", "first_audible"],
  ["response_ms", "response_created", "response_done"],
  // What the candidate feels: from finishing their answer to hearing the next question.
  ["click_to_audible_ms", "answer_click", "first_audible"],
  ["stop_to_audible_ms", "speech_stopped", "first_audible"],
];

/** Marks recorded at their latest occurrence: a turn can have several VAD segments, and an "I'm done"
 * refused for an empty answer is followed by another click. */
const TURN_LAST_MARKS = new Set(["speech_stopped", "transcript", "response_done", "answer_click"]);
/** Marks that belong to the NEXT turn: seeing one closes a turn still waiting for its audio. */
const TURN_OPENING_MARKS = new Set(["speech_started", "answer_click"]);
/** After `response.done`, how long a turn waits for its first audible sample before it is sent
 * anyway. Azure finishes sending a response's audio seconds before it finishes PLAYING, so the
 * first audible sample usually lands before `response.done`, but not always. */
export const TURN_AUDIBLE_GRACE_MS = 8_000;
/** A setup that never hears audio (no question read, a failed avatar) is still sent after this. */
export const SETUP_TIMEOUT_MS = 60_000;

type Emit = (name: string, measurements: Record<string, number>, properties: Properties) => void;

/** Telemetry runs inside WebSocket and WebRTC handlers of a live interview: it must never throw into
 * them. */
function guarded(what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.debug(`[telemetry] ${what} failed`, err);
  }
}

/**
 * Turn and setup bookkeeping for one voice hook. The hooks call `turn(...)` / `setup(...)` with mark
 * names; this decides when an event is complete and sends it.
 */
export class VoiceMetrics {
  private turnLine: Timeline;
  private setupLine: Timeline | null = null;
  private turnIndex = 0;
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private setupTimer: ReturnType<typeof setTimeout> | null = null;
  private context: Properties = {};

  constructor(
    private readonly emit: Emit = trackEvent,
    private readonly clock: Clock = () => performance.now(),
  ) {
    this.turnLine = new Timeline(clock);
  }

  /** Properties attached to every event (interview id, audio path, pipeline, ...). */
  setContext(next: Properties): void {
    this.context = { ...this.context, ...next };
  }

  get contextSnapshot(): Properties {
    return { ...this.context };
  }

  // --- setup -------------------------------------------------------------------------------------

  /** A new voice connection: send any setup still open and start a fresh one. */
  startSetup(): void {
    guarded("startSetup", () => {
      this.flushSetup("superseded");
      this.setupLine = new Timeline(this.clock);
      this.setupLine.mark("connect_start");
      this.setupTimer = setTimeout(() => this.flushSetup("timeout"), SETUP_TIMEOUT_MS);
    });
  }

  setup(name: string): void {
    guarded("setup", () => {
      if (!this.setupLine) return;
      this.setupLine.mark(name);
      if (name === "first_audible") this.flushSetup("heard");
    });
  }

  private flushSetup(outcome: string): void {
    if (this.setupTimer) clearTimeout(this.setupTimer);
    this.setupTimer = null;
    const line = this.setupLine;
    this.setupLine = null;
    if (!line) return;
    this.emit("voice.setup", line.measurements(SETUP_SPANS), { ...this.context, outcome });
  }

  // --- turns -------------------------------------------------------------------------------------

  turn(name: string): void {
    guarded("turn", () => this.recordTurn(name));
  }

  private recordTurn(name: string): void {
    if (this.turnTimer && TURN_OPENING_MARKS.has(name)) this.flushTurn();
    // The tail of the previous question can still be playing after its response.done; a sample is
    // only "this turn's first audible" once this turn's response exists.
    if (name === "first_audible" && !this.turnLine.has("response_created")) return;
    if (TURN_LAST_MARKS.has(name)) this.turnLine.markLast(name);
    else this.turnLine.mark(name);

    if (name === "first_audible") {
      this.setup("first_audible");
      if (this.turnLine.has("response_done")) this.flushTurn();
    } else if (name === "response_done") {
      if (this.turnLine.has("first_audible")) this.flushTurn();
      else this.armTurnTimer();
    }
  }

  private armTurnTimer(): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = setTimeout(() => this.flushTurn(), TURN_AUDIBLE_GRACE_MS);
  }

  private flushTurn(): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
    const line = this.turnLine;
    this.turnLine = new Timeline(this.clock);
    if (line.isEmpty) return;
    // answer: the candidate submitted, and this is the next read. aside: they spoke but did not
    // submit, so the response was a judge nudge (or, in the Playground, a model turn). opening: a
    // read with nothing before it, i.e. question 1 or a reconnect's re-read.
    const kind = line.has("answer_submit")
      ? "answer"
      : line.has("speech_started")
        ? "aside"
        : "opening";
    this.emit("voice.turn", line.measurements(TURN_SPANS), {
      ...this.context,
      turn_index: this.turnIndex,
      kind,
      heard: line.has("first_audible"),
    });
    this.turnIndex += 1;
  }

  /** The connection is going away: send whatever is open. */
  flush(): void {
    guarded("flush", () => {
      this.flushTurn();
      this.flushSetup("closed");
    });
  }
}

export const PENDING_LIMIT_MS = 2_000;

/** One avatar handshake. `finish()` sends it once; later calls are ignored. */
export class AvatarHandshakeMetrics {
  readonly line: Timeline;
  private done = false;
  private readonly props: Properties;
  private readonly pending: Promise<unknown>[] = [];

  constructor(
    props: Properties,
    private readonly emit: Emit = trackEvent,
    clock: Clock = () => performance.now(),
  ) {
    this.line = new Timeline(clock);
    this.props = { ...voiceMetrics.contextSnapshot, ...props };
    this.line.mark("pc_created");
  }

  mark(name: string): void {
    if (!this.done) guarded("avatar mark", () => this.line.mark(name));
  }

  has(name: string): boolean {
    return this.line.has(name);
  }

  /** Candidate pair and other facts learned along the way (e.g. from getStats). */
  set(next: Properties): void {
    Object.assign(this.props, next);
  }

  get finished(): boolean {
    return this.done;
  }

  /** Hold the event until `work` settles (a getStats read racing the first frame), but never longer
   * than PENDING_LIMIT_MS: a stats read on a connection closing underneath it may never answer. */
  waitFor(work: Promise<unknown>): void {
    const limit = new Promise((resolve) => setTimeout(resolve, PENDING_LIMIT_MS));
    this.pending.push(Promise.race([work.catch(() => undefined), limit]));
  }

  /** Stop recording marks and send the event once everything it waits for has settled. */
  async finish(outcome: string): Promise<void> {
    if (this.done) return;
    this.done = true;
    await Promise.all(this.pending);
    guarded("avatar finish", () => {
      // Numbers (the pair RTT) are measurements, so the workbook can chart them; the rest are labels.
      const measurements = this.line.measurements(AVATAR_SPANS);
      const props: Properties = { outcome };
      for (const [key, value] of Object.entries(this.props)) {
        if (typeof value === "number") measurements[key] = value;
        else props[key] = value;
      }
      this.emit("voice.avatar", measurements, props);
    });
  }
}

/** An audio level above this is the interviewer speaking (WebRTC `audioLevel` is 0..1, and the
 * avatar's audio between utterances is digital silence). */
export const AUDIBLE_LEVEL = 0.01;
/** Only a sound after at least this much silence is a new utterance starting. */
export const SILENCE_BEFORE_ONSET_MS = 300;
export const AUDIBLE_POLL_MS = 50;

/**
 * Call `onOnset` each time the avatar's received audio goes from silence to sound. The WebRTC path
 * has no "playback started" event of its own, so the receiver's audio level stands in for it; it is
 * measured as packets arrive, a jitter buffer (tens of ms) ahead of the speaker. Returns a stop
 * function. A browser without `getSynchronizationSources` (or no receiver) gets a no-op.
 */
export function watchAudibleOnsets(
  receiver: RTCRtpReceiver | undefined,
  onOnset: () => void,
  clock: Clock = () => performance.now(),
): () => void {
  if (typeof receiver?.getSynchronizationSources !== "function") return () => undefined;
  let silentSince: number | null = clock();
  const id = setInterval(() => {
    const level = receiver.getSynchronizationSources()[0]?.audioLevel ?? 0;
    const now = clock();
    if (level > AUDIBLE_LEVEL) {
      if (silentSince !== null && now - silentSince >= SILENCE_BEFORE_ONSET_MS) onOnset();
      silentSince = null;
    } else if (silentSince === null) {
      silentSince = now;
    }
  }, AUDIBLE_POLL_MS);
  return () => clearInterval(id);
}

/** The ICE candidate type in an `RTCIceCandidate.candidate` line, or null. */
export function candidateType(line: string | undefined): string | null {
  const match = / typ (host|srflx|prflx|relay)(\s|$)/.exec(line ?? "");
  return match ? match[1] : null;
}

/** The selected candidate pair from a `getStats()` report: local/remote type, protocol and RTT. */
export function selectedPair(stats: RTCStatsReport): Properties | null {
  let pairId: string | undefined;
  stats.forEach((s: { type: string; selectedCandidatePairId?: string }) => {
    if (s.type === "transport" && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
  });
  let pair: Record<string, unknown> | undefined;
  stats.forEach((s: Record<string, unknown>) => {
    if (s.type !== "candidate-pair") return;
    if (pairId ? s.id === pairId : s.nominated === true && s.state === "succeeded") pair = s;
  });
  if (!pair) return null;
  const local = stats.get(pair.localCandidateId as string) as Record<string, unknown> | undefined;
  const remote = stats.get(pair.remoteCandidateId as string) as Record<string, unknown> | undefined;
  const out: Properties = {};
  if (local?.candidateType) out.local_candidate = String(local.candidateType);
  if (local?.protocol) out.protocol = String(local.protocol);
  if (local?.relayProtocol) out.relay_protocol = String(local.relayProtocol);
  if (remote?.candidateType) out.remote_candidate = String(remote.candidateType);
  if (typeof pair.currentRoundTripTime === "number") {
    out.rtt_ms = Math.round(pair.currentRoundTripTime * 1000);
  }
  return out;
}

/** The page's one voice connection at a time (interview page or editor Playground) shares this. */
export const voiceMetrics = new VoiceMetrics();
