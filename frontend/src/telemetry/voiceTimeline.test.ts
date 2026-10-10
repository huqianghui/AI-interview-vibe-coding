import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIBLE_POLL_MS,
  AvatarHandshakeMetrics,
  candidateType,
  selectedPair,
  SETUP_TIMEOUT_MS,
  SILENCE_BEFORE_ONSET_MS,
  Timeline,
  TURN_AUDIBLE_GRACE_MS,
  VoiceMetrics,
  watchAudibleOnsets,
} from "./voiceTimeline";

type Sent = { name: string; m: Record<string, number>; p: Record<string, unknown> };

function harness() {
  let now = 1_000;
  const sent: Sent[] = [];
  const clock = () => now;
  const advance = (ms: number) => {
    now += ms;
  };
  const emit = (name: string, m: Record<string, number>, p: Record<string, unknown>) =>
    sent.push({ name, m, p });
  return { sent, clock, advance, emit };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Timeline", () => {
  it("keeps the first occurrence for mark and the latest for markLast", () => {
    const h = harness();
    const line = new Timeline(h.clock);
    line.mark("a");
    h.advance(10);
    line.mark("a");
    line.markLast("b");
    h.advance(5);
    line.markLast("b");
    expect(line.measurements([["a_to_b", "a", "b"]])).toEqual({ t_a: 0, t_b: 15, a_to_b: 15 });
  });

  it("leaves out a span whose end never happened", () => {
    const h = harness();
    const line = new Timeline(h.clock);
    line.mark("a");
    expect(line.measurements([["x", "a", "missing"]])).toEqual({ t_a: 0 });
  });
});

describe("VoiceMetrics turns", () => {
  it("breaks an answered turn into its stages and the candidate-felt latency", () => {
    const h = harness();
    const vm = new VoiceMetrics(h.emit, h.clock);
    vm.setContext({ interview_id: "iv1", audio_path: "webrtc" });
    const steps: [string, number][] = [
      ["speech_started", 0],
      ["speech_stopped", 4_000],
      ["transcript", 600],
      ["answer_click", 400],
      ["answer_submit", 100],
      ["answer_response", 1_500],
      ["read_request", 20],
      ["response_created", 200],
      ["first_text", 150],
      ["first_audible", 500],
      ["response_done", 300],
    ];
    for (const [name, after] of steps) {
      h.advance(after);
      vm.turn(name);
    }
    expect(h.sent).toHaveLength(1);
    const [turn] = h.sent;
    expect(turn.name).toBe("voice.turn");
    expect(turn.p).toMatchObject({ interview_id: "iv1", kind: "answer", turn_index: 0, heard: true });
    expect(turn.m).toMatchObject({
      speaking_ms: 4_000,
      stt_ms: 600,
      commit_wait_ms: 100,
      answer_http_ms: 1_500,
      read_to_created_ms: 200,
      created_to_first_text_ms: 150,
      created_to_audible_ms: 650,
      response_ms: 950,
      click_to_audible_ms: 2_470,
    });
  });

  it("measures STT from the LAST VAD segment before the submit", () => {
    const h = harness();
    const vm = new VoiceMetrics(h.emit, h.clock);
    vm.turn("speech_started");
    h.advance(1_000);
    vm.turn("speech_stopped");
    vm.turn("transcript");
    h.advance(2_000);
    vm.turn("speech_stopped");
    h.advance(300);
    vm.turn("transcript");
    vm.turn("response_created");
    vm.turn("first_audible");
    vm.turn("response_done");
    expect(h.sent[0].m.stt_ms).toBe(300);
  });

  it("does not count the previous question's tail as this turn's first audible sample", () => {
    const h = harness();
    const vm = new VoiceMetrics(h.emit, h.clock);
    vm.turn("answer_click");
    vm.turn("first_audible"); // still the previous read playing out
    h.advance(900);
    vm.turn("response_created");
    h.advance(100);
    vm.turn("first_audible");
    vm.turn("response_done");
    expect(h.sent[0].m.click_to_audible_ms).toBe(1_000);
  });

  it("waits a grace window after response.done for audio, then sends the turn unheard", () => {
    const h = harness();
    const vm = new VoiceMetrics(h.emit, h.clock);
    vm.turn("response_created");
    vm.turn("response_done");
    expect(h.sent).toHaveLength(0);
    vi.advanceTimersByTime(TURN_AUDIBLE_GRACE_MS);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].p).toMatchObject({ kind: "opening", heard: false });
  });

  it("sends a turn the moment its audio is heard when response.done came first", () => {
    const h = harness();
    const vm = new VoiceMetrics(h.emit, h.clock);
    vm.turn("response_created");
    vm.turn("response_done");
    h.advance(400);
    vm.turn("first_audible");
    expect(h.sent).toHaveLength(1);
    vi.advanceTimersByTime(TURN_AUDIBLE_GRACE_MS);
    expect(h.sent).toHaveLength(1);
  });

  it("closes a turn still waiting for audio when the candidate starts the next one", () => {
    const h = harness();
    const vm = new VoiceMetrics(h.emit, h.clock);
    vm.turn("response_created");
    vm.turn("response_done");
    vm.turn("speech_started");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].m).not.toHaveProperty("speaking_ms");
    vm.flush();
    expect(h.sent[1].p).toMatchObject({ turn_index: 1 });
  });
});

describe("VoiceMetrics setup", () => {
  it("is sent when the first interviewer audio is heard", () => {
    const h = harness();
    const vm = new VoiceMetrics(h.emit, h.clock);
    vm.startSetup();
    h.advance(300);
    vm.setup("ws_open");
    h.advance(200);
    vm.setup("session_updated");
    h.advance(2_000);
    vm.setup("first_video_frame");
    vm.turn("response_created");
    h.advance(500);
    vm.turn("first_audible");
    const setup = h.sent.find((s) => s.name === "voice.setup")!;
    expect(setup.p.outcome).toBe("heard");
    expect(setup.m).toMatchObject({
      ws_open_ms: 300,
      session_updated_ms: 500,
      first_video_frame_ms: 2_500,
      first_audible_ms: 3_000,
    });
  });

  it("is sent on timeout when nothing is ever heard", () => {
    const h = harness();
    const vm = new VoiceMetrics(h.emit, h.clock);
    vm.startSetup();
    vi.advanceTimersByTime(SETUP_TIMEOUT_MS);
    expect(h.sent.map((s) => s.p.outcome)).toEqual(["timeout"]);
  });

  it("sends the open setup when a reconnect starts a new one", () => {
    const h = harness();
    const vm = new VoiceMetrics(h.emit, h.clock);
    vm.startSetup();
    vm.startSetup();
    expect(h.sent.map((s) => s.p.outcome)).toEqual(["superseded"]);
  });
});

describe("AvatarHandshakeMetrics", () => {
  it("reports STUN, TURN, gathering, signalling, ICE and first frame, once", async () => {
    const h = harness();
    const hs = new AvatarHandshakeMetrics({ label: "initial" }, h.emit, h.clock);
    const steps: [string, number][] = [
      ["offer_created", 30],
      ["first_host", 5],
      ["first_srflx", 60],
      ["first_relay", 90],
      ["offer_sent", 300],
      ["answer_received", 700],
      ["answer_applied", 10],
      ["ice_connected", 250],
      ["first_track", 20],
      ["first_frame", 400],
    ];
    for (const [name, after] of steps) {
      h.advance(after);
      hs.mark(name);
    }
    let resolveStats!: () => void;
    hs.waitFor(new Promise<void>((r) => (resolveStats = r)).then(() => hs.set({ local_candidate: "relay", rtt_ms: 42 })));
    const sending = hs.finish("frame");
    void hs.finish("again");
    expect(h.sent).toHaveLength(0); // held for the stats read
    resolveStats();
    await sending;
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].p).toMatchObject({ label: "initial", local_candidate: "relay", outcome: "frame" });
    expect(h.sent[0].m).toMatchObject({
      create_offer_ms: 30,
      first_host_ms: 5,
      stun_srflx_ms: 65,
      turn_relay_ms: 155,
      ice_gather_ms: 455,
      sdp_answer_ms: 700,
      ice_connect_ms: 250,
      first_frame_ms: 420,
      total_ms: 1_865,
      rtt_ms: 42,
    });
  });
});

describe("watchAudibleOnsets", () => {
  it("fires on each sound that follows enough silence, not on every loud sample", () => {
    const h = harness();
    let level = 0;
    const receiver = {
      getSynchronizationSources: () => [{ audioLevel: level }],
    } as unknown as RTCRtpReceiver;
    let onsets = 0;
    const stop = watchAudibleOnsets(receiver, () => onsets++, h.clock);
    const tick = (ms: number) => {
      for (let t = 0; t < ms; t += AUDIBLE_POLL_MS) {
        h.advance(AUDIBLE_POLL_MS);
        vi.advanceTimersByTime(AUDIBLE_POLL_MS);
      }
    };
    tick(SILENCE_BEFORE_ONSET_MS);
    level = 0.3;
    tick(1_000);
    expect(onsets).toBe(1);
    level = 0; // a breath shorter than the silence window: the same utterance
    tick(100);
    level = 0.3;
    tick(200);
    expect(onsets).toBe(1);
    level = 0;
    tick(SILENCE_BEFORE_ONSET_MS + 100);
    level = 0.3;
    tick(100);
    expect(onsets).toBe(2);
    stop();
    level = 0;
    tick(1_000);
    level = 0.3;
    tick(100);
    expect(onsets).toBe(2);
  });

  it("is a no-op where the browser has no synchronization sources", () => {
    const stop = watchAudibleOnsets({} as RTCRtpReceiver, () => undefined);
    stop();
  });
});

describe("candidate helpers", () => {
  it("reads the candidate type from a candidate line", () => {
    expect(candidateType("candidate:1 1 udp 2122260223 10.0.0.2 5000 typ host generation 0")).toBe("host");
    expect(candidateType("candidate:2 1 udp 1 20.1.1.1 3478 typ relay raddr 0.0.0.0")).toBe("relay");
    expect(candidateType(undefined)).toBeNull();
  });

  it("finds the selected pair through the transport", () => {
    const entries: Record<string, unknown>[] = [
      { id: "T", type: "transport", selectedCandidatePairId: "P" },
      { id: "P", type: "candidate-pair", localCandidateId: "L", remoteCandidateId: "R", currentRoundTripTime: 0.0425 },
      { id: "L", type: "local-candidate", candidateType: "relay", protocol: "udp", relayProtocol: "tls" },
      { id: "R", type: "remote-candidate", candidateType: "relay" },
    ];
    const report = new Map(entries.map((e) => [e.id as string, e])) as unknown as RTCStatsReport;
    expect(selectedPair(report)).toEqual({
      local_candidate: "relay",
      protocol: "udp",
      relay_protocol: "tls",
      remote_candidate: "relay",
      rtt_ms: 43,
    });
  });
});
