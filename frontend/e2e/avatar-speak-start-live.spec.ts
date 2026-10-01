/**
 * Avatar speak-start latency: the gap the latency series left open.
 *
 * Voice Live 系列 03 §6 models a turn as VAD stop + transcript + brain + "read → first audio chunk",
 * and closes with the one thing it could not measure: 「数字人开口」相对首段音频的 avatar 渲染/传输增量,
 * 需浏览器层(WebRTC 音频轨能量检测)实测. In avatar mode the reply audio never appears on the WebSocket —
 * it rides the WebRTC audio track — so the probe that produced §6's numbers is structurally blind to the
 * last hop: the one the candidate actually hears.
 *
 * This spec measures that hop in the browser, against real Azure:
 *
 *   t_read_sent      frontend sends response.create (pre_generated read request)
 *   t_read_created   Azure acks with response.created          → §6 measured up to about here
 *   t_first_sample   inbound audio samples start arriving       ← media begins
 *   t_first_energy   totalAudioEnergy starts growing            ← THE CANDIDATE HEARS IT
 *   t_first_frame    framesDecoded starts growing               ← the mouth starts moving
 *
 * totalAudioEnergy is the W3C cumulative-energy counter on inbound-rtp audio. It separates "packets are
 * arriving" from "a voice is audible": comfort noise and DTX silence advance totalSamplesReceived while
 * leaving energy flat. Measuring arrival instead of audibility was exactly the error that invalidated
 * five weak-network runs (docs/avatar-weaknet-probe.md §5.4.2), so this probe reports both and never
 * calls a sample-count a speak-start.
 *
 * Read the SPEAK-START table it prints. Set LIVE_VOICE=1 to opt in; it costs a real avatar session.
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

import { expect, test } from "@playwright/test";
import { enterVoiceChannel, primeCandidateLogin, waitForInterviewStage } from "./helpers/candidateLogin";

/** import.meta.url, not __dirname: this is an ESM spec, and __dirname throws here — AFTER all the console
 *  output, which is how it silently voided a weak-network run (docs/avatar-weaknet-probe.md §5.4.4). */
const OUT_DIR = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "output");

const LIVE = process.env.LIVE_VOICE === "1";
const BASE = process.env.BASE || "http://localhost:5173";
/** 100ms: fine enough to place the speak-start inside a tenth of a second, coarse enough that
 *  getStats() itself does not become the thing being measured. */
const SAMPLE_MS = Number(process.env.SPEAK_SAMPLE_MS ?? 100);

interface Tick {
  t: number;
  samples: number;
  energy: number;
  frames: number;
  /** Instantaneous level (0..1) from inbound-rtp audio, when the browser exposes it. Unlike the
   *  cumulative energy counter this can be compared against an idle floor directly. */
  level: number | null;
}

test.describe("Avatar speak-start latency (real Azure)", () => {
  test.skip(!LIVE, "opt-in: set LIVE_VOICE=1");

  test("measures read-ack → audible voice, the hop the WS probe cannot see", async ({ page }) => {
    test.setTimeout(300_000);

    // WS markers. Timestamps come from the same clock as the samplers below (Date.now in the test process)
    // so the subtractions are meaningful; Playwright delivers frame events on the test side.
    const marks: { name: string; t: number }[] = [];
    const mark = (name: string) => marks.push({ name, t: Date.now() });

    page.on("websocket", (ws) => {
      if (!/voice-live\/ws/.test(ws.url())) return;
      mark("ws_opened");
      ws.on("framesent", (f) => {
        const data = typeof f.payload === "string" ? f.payload : "";
        if (!data) return;
        try {
          const msg = JSON.parse(data) as Record<string, unknown>;
          if (msg.type === "response.create") mark("read_sent");
          if (msg.type === "session.avatar.connect") mark("avatar_connect_sent");
          if (msg.type === "session.update") mark("session_update_sent");
        } catch {
          /* binary audio frame */
        }
      });
      ws.on("framereceived", (f) => {
        const data = typeof f.payload === "string" ? f.payload : "";
        if (!data) return;
        try {
          const msg = JSON.parse(data) as Record<string, unknown>;
          const type = msg.type as string | undefined;
          if (type === "response.created") mark("read_created");
          if (type === "response.done") mark("read_done");
          if (type === "session.avatar.connecting") mark("avatar_answer");
          if (type === "proxy.connected") mark("proxy_connected");
          if (type === "session.updated") mark("session_updated");
        } catch {
          /* binary */
        }
      });
    });

    // Hook the PeerConnection to learn WHEN the avatar was actually ready, not just when we asked it to
    // speak. The wait between Azure accepting the avatar and the page requesting the read is only
    // justified if the avatar was not ready yet; any slack beyond that is dead time in front of the
    // candidate, and the two cannot be told apart without these timestamps.
    await page.addInitScript(() => {
      const w = window as unknown as {
        __pcs: RTCPeerConnection[];
        __pcMarks: { name: string; t: number }[];
        __cands: { t: number; type: string; proto: string }[];
      };
      w.__pcs = [];
      w.__pcMarks = [];
      w.__cands = [];
      const note = (name: string) => {
        if (!w.__pcMarks.some((m) => m.name === name)) w.__pcMarks.push({ name, t: Date.now() });
      };
      const OrigPC = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends OrigPC {
        constructor(...args: unknown[]) {
          // @ts-expect-error passthrough
          super(...args);
          w.__pcs.push(this);
          this.addEventListener("iceconnectionstatechange", () => {
            if (this.iceConnectionState === "connected" || this.iceConnectionState === "completed") {
              note("pc_ice_connected");
            }
          });
          this.addEventListener("connectionstatechange", () => {
            if (this.connectionState === "connected") note("pc_connected");
          });
          this.addEventListener("track", (e) => {
            const ev = e as RTCTrackEvent;
            note(`pc_track_${ev.track.kind}`);
          });
          // Every gathered candidate, with its arrival time and type. The handshake waits for the first
          // usable (relay/srflx) one and then holds a fixed settle window before sending the offer; that
          // window is only worth its cost if a candidate arriving INSIDE it can end up winning. Recording
          // arrivals here, and reading the nominated pair afterwards, answers that with evidence.
          const cands = (w as unknown as { __cands: { t: number; type: string; proto: string }[] }).__cands;
          this.addEventListener("icecandidate", (e) => {
            const c = (e as RTCPeerConnectionIceEvent).candidate;
            if (!c) {
              note("ice_gathering_null_candidate");
              return;
            }
            cands.push({ t: Date.now(), type: c.type ?? "?", proto: c.protocol ?? "?" });
          });
        }
      } as unknown as typeof RTCPeerConnection;
    });

    const tick = async (): Promise<Omit<Tick, "t">> =>
      page.evaluate(async () => {
        const w = window as unknown as { __pcs: RTCPeerConnection[] };
        const acc = { samples: 0, energy: 0, frames: 0, level: null as number | null };
        for (const pc of w.__pcs ?? []) {
          if (pc.connectionState !== "connected") continue;
          const report = await pc.getStats();
          report.forEach((s) => {
            const row = s as unknown as Record<string, unknown>;
            if (row.type !== "inbound-rtp") return;
            if (row.kind === "audio") {
              if (typeof row.totalSamplesReceived === "number") acc.samples += row.totalSamplesReceived;
              // The audible signal. Comfort noise advances samples but not energy.
              if (typeof row.totalAudioEnergy === "number") acc.energy += row.totalAudioEnergy;
              if (typeof row.audioLevel === "number") acc.level = Math.max(acc.level ?? 0, row.audioLevel);
            }
            if (row.kind === "video" && typeof row.framesDecoded === "number") acc.frames += row.framesDecoded;
          });
        }
        return acc;
      });

    const ticks: Tick[] = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        try {
          const a = await tick();
          ticks.push({ t: Date.now(), ...a });
        } catch {
          /* page navigating; skip this tick */
        }
        await new Promise((r) => setTimeout(r, SAMPLE_MS));
      }
    })();

    // The external-brain persona puts a third-party gateway (measured elsewhere at ~3.9s median) inside
    // the very segments being timed here. Owner directive: performance work runs on the built-in bank.
    // Asserted, not assumed — the default persona has been external-brain at times in this project's
    // history, and a silent switch would corrupt every number below without failing anything.
    let engine: string | null = null;
    page.on("response", (r) => {
      if (/\/candidate\/interview\/start$/.test(r.url()) && r.ok()) {
        void r
          .json()
          .then((j: Record<string, unknown>) => {
            engine = (j.engine as string) ?? (j.external_engine ? "external" : "bank");
          })
          .catch(() => undefined);
      }
    });

    await primeCandidateLogin(page);
    await page.goto(`${BASE}/interview`);
    mark("page_ready");

    // Timestamped handshake logs: the hook already logs each step, so the sub-breakdown of our own
    // segments comes free — no extra instrumentation in production code.
    const logs: { t: number; text: string }[] = [];
    page.on("console", (m) => {
      const text = m.text();
      if (/avatar-stream|voice/.test(text)) logs.push({ t: Date.now(), text: text.slice(0, 120) });
    });

    await page.getByRole("button", { name: /开始面试|start interview/i }).click();
    await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
    mark("ready_clicked");
    // getUserMedia is the one local step that can block for a long time and leaves no WS trace. Time it
    // from inside the page so it is not invisible in the breakdown.
    await page.evaluate(() => {
      const w = window as unknown as { __gumMs?: number };
      const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (c?: MediaStreamConstraints) => {
        const t0 = performance.now();
        try {
          return await orig(c);
        } finally {
          w.__gumMs = Math.round(performance.now() - t0);
        }
      };
    });

    // Wait for the read to finish, so the whole first-question speak cycle is inside the samples.
    await expect
      .poll(() => marks.some((m) => m.name === "read_done"), { timeout: 180_000, intervals: [500] })
      .toBe(true);
    // Let the tail of the audio land before stopping the sampler.
    await page.waitForTimeout(2_000);
    sampling = false;
    await sampler;

    const at = (name: string) => marks.find((m) => m.name === name)?.t ?? null;

    /** First growth of a counter AFTER an anchor event, baselined on the last tick at or before it.
     *
     *  Anchoring on the first tick instead produced a run reporting 82ms from read request to audible
     *  voice — not a fast read, but a void measurement: energy was already rising when sampling began, so
     *  "first growth" landed on tick 1. The read request is the only correct baseline for "when did it
     *  start speaking", because everything before it is the idle stream. */
    const firstGrowthAfter = (anchor: number | null, pick: (k: Tick) => number): number | null => {
      if (anchor === null || ticks.length < 2) return null;
      let base: number | null = null;
      for (const k of ticks) {
        if (k.t <= anchor) base = pick(k);
      }
      if (base === null) return null;
      for (const k of ticks) {
        if (k.t > anchor && pick(k) > base) return k.t;
      }
      return null;
    };

    /** Speech start, detected on the INSTANTANEOUS level crossing an idle floor.
     *
     *  Measured (SPEAK_DUMP=1, 100ms ticks): through the ~1s of stream that precedes the voice, audioLevel
     *  sits at 0.0000-0.0010 and totalAudioEnergy stays at exactly 0.00000; when the voice starts, level
     *  jumps to 0.09-0.47 and energy climbs. Two decades of separation, so the floor is not delicate.
     *
     *  Cumulative energy was the first thing tried, and on a COLD session it works. On a warm one it does
     *  not: a previous utterance has already left energy non-zero, so "first growth after the read" fires
     *  on the next tick and reports ~130ms — faster than the 265ms round trip that has to happen first,
     *  which is what exposed it as void rather than fast. An instantaneous level needs no such baseline. */
    const SPEECH_LEVEL_FLOOR = Number(process.env.SPEAK_LEVEL_FLOOR ?? 0.05);
    const firstSpeechAfter = (anchor: number | null): { t: number | null; via: string } => {
      if (anchor === null) return { t: null, via: "no read anchor" };
      const after = ticks.filter((k) => k.t > anchor);
      const withLevel = after.filter((k) => k.level !== null);
      if (withLevel.length > 0) {
        const hit = withLevel.find((k) => (k.level as number) > SPEECH_LEVEL_FLOOR);
        return { t: hit?.t ?? null, via: `audioLevel > ${SPEECH_LEVEL_FLOOR}` };
      }
      // No audioLevel in this browser: fall back to cumulative energy, which is only trustworthy when it
      // was still exactly zero at the anchor (a cold session).
      const baseline = ticks.filter((k) => k.t <= anchor).pop()?.energy ?? 0;
      if (baseline > 0) return { t: null, via: "energy already non-zero at the read — cannot time (void)" };
      const hit = after.find((k) => k.energy > 0);
      return { t: hit?.t ?? null, via: "totalAudioEnergy > 0 (cold session fallback)" };
    };

    const readSentAt = at("read_sent");
    const readCreatedAt = at("read_created");
    const speech = firstSpeechAfter(readSentAt);
    const tSamples = firstGrowthAfter(readSentAt, (k) => k.samples);
    const tEnergy = speech.t;
    const tFrames = firstGrowthAfter(readSentAt, (k) => k.frames);
    const voided = tEnergy === null;

    const readSent = readSentAt;
    const readCreated = readCreatedAt;
    const readDone = at("read_done");
    const gap = (a: number | null, b: number | null) => (a !== null && b !== null ? `${b - a}ms` : "—");
    const span = (from: string, to: string): number | null => {
      const a = at(from);
      const b = at(to);
      return a !== null && b !== null ? b - a : null;
    };

    // Marker timeline with deltas: the breakdown is only trustworthy if you can see WHERE the time went,
    // and a single summary line hides a maxed-out fallback timeout inside an innocent-looking total.
    const gumMs = await page.evaluate(() => (window as unknown as { __gumMs?: number }).__gumMs ?? null);
    const pcMarks = await page.evaluate(
      () => (window as unknown as { __pcMarks?: { name: string; t: number }[] }).__pcMarks ?? [],
    );
    pcMarks.forEach((m) => marks.push(m));
    marks.sort((a, b) => a.t - b.t);
    if (process.env.SPEAK_DUMP === "1") {
      const anchor = marks.find((m) => m.name === "read_sent")?.t ?? 0;
      console.log("\n===== RAW TICKS AROUND THE READ (ms relative to read_sent) =====");
      ticks
        .filter((k) => k.t > anchor - 1500 && k.t < anchor + 3000)
        .forEach((k, i, arr) => {
          const prev = i > 0 ? arr[i - 1] : null;
          const dE = prev ? (k.energy - prev.energy).toFixed(6) : "—";
          console.log(
            `  ${String(k.t - anchor).padStart(6)}ms  energy=${k.energy.toFixed(5)}  dE=${String(dE).padStart(10)}  level=${k.level === null ? "n/a" : k.level.toFixed(4)}  samples=${k.samples}`,
          );
        });
    }

    // Which candidate actually won, and when did each arrive?
    const cands = await page.evaluate(
      () => (window as unknown as { __cands?: { t: number; type: string; proto: string }[] }).__cands ?? [],
    );
    const winner = await page.evaluate(async () => {
      const w = window as unknown as { __pcs: RTCPeerConnection[] };
      for (const pc of w.__pcs) {
        if (pc.connectionState !== "connected") continue;
        const report = await pc.getStats();
        let pair: Record<string, unknown> | null = null;
        const locals = new Map<string, Record<string, unknown>>();
        report.forEach((st) => {
          const row = st as unknown as Record<string, unknown>;
          if (row.type === "local-candidate") locals.set(row.id as string, row);
          if (row.type === "candidate-pair" && (row.nominated === true || row.state === "succeeded")) pair = row;
        });
        if (pair) {
          const l = locals.get((pair as Record<string, unknown>).localCandidateId as string);
          return { type: (l?.candidateType as string) ?? "?", proto: (l?.protocol as string) ?? "?" };
        }
      }
      return null;
    });

    const gatherStart = logs.find((l) => /gathering ICE for offer/.test(l.text))?.t ?? null;
    const offerReady = logs.find((l) => /offer ready, sending/.test(l.text))?.t ?? null;
    console.log("\n===== ICE CANDIDATES: is the settle window buying anything? =====");
    console.log(`  winning local candidate: ${winner ? `${winner.type}/${winner.proto}` : "not resolved"}`);
    if (gatherStart !== null) {
      cands.forEach((c) => {
        const rel = c.t - gatherStart;
        const usable = c.type === "relay" || c.type === "srflx";
        console.log(
          `  +${String(rel).padStart(5)}ms  ${c.type}/${c.proto}${usable ? "  ← usable" : ""}${winner && c.type === winner.type && c.proto === winner.proto ? "  ← same type as the winner" : ""}`,
        );
      });
      const firstUsable = cands.find((c) => c.type === "relay" || c.type === "srflx");
      if (firstUsable && offerReady !== null) {
        console.log(`  first usable at +${firstUsable.t - gatherStart}ms; offer sent at +${offerReady - gatherStart}ms`);
        console.log(`  → held ${offerReady - firstUsable.t}ms after it (the settle window)`);
        const during = cands.filter((c) => c.t > firstUsable.t && c.t <= offerReady);
        console.log(`  → candidates that arrived during the hold: ${during.length}${during.length ? ` (${during.map((c) => c.type).join(", ")})` : " — the hold added nothing this run"}`);
      }
    }

    const sessionUpdated = marks.find((m) => m.name === "session_updated")?.t ?? null;
    const avatarSent = marks.find((m) => m.name === "avatar_connect_sent")?.t ?? null;
    if (sessionUpdated !== null && avatarSent !== null) {
      console.log("\n===== INSIDE OUR OWN SEGMENT: session.updated → avatar.connect =====");
      const inRange = logs.filter((l) => l.t >= sessionUpdated - 150 && l.t <= avatarSent + 150);
      inRange.forEach((l, i) => {
        const d = i === 0 ? 0 : l.t - inRange[i - 1].t;
        console.log(`  +${String(l.t - sessionUpdated).padStart(5)}ms  (+${String(d).padStart(4)}ms)  ${l.text}`);
      });
      if (inRange.length === 0) console.log("  (no handshake logs in range)");
    }

    console.log("\n===== MARKER TIMELINE =====");
    marks.forEach((m, i) => {
      const d = i === 0 ? 0 : m.t - marks[i - 1].t;
      console.log(`  +${String(m.t - marks[0].t).padStart(6)}ms  (+${String(d).padStart(5)}ms)  ${m.name}`);
    });

    console.log(`  getUserMedia took: ${gumMs === null ? "not observed (hook installed after the call)" : gumMs + "ms"}`);

    console.log("\n===== SPEAK-START LATENCY (real Azure, avatar mode) =====");
    console.log(`  samples: ${ticks.length} ticks @ ${SAMPLE_MS}ms`);
    console.log(`  markers seen: ${marks.map((m) => m.name).join(" → ")}`);
    console.log("");
    console.log("  --- the segment the WS-level probe measured (series 03 §6) ---");
    console.log(`  response.create → response.created        ${gap(readSent, readCreated)}`);
    console.log("");
    console.log("  --- the segment it could not see: media over WebRTC ---");
    // Samples and frames are ALREADY advancing before the read: the avatar streams comfort noise and idle
    // video from the moment it connects. Their "first growth" therefore times the stream starting, not the
    // speech starting, and subtracting response.created from it yields a negative number that means
    // "this counter cannot answer this question" — not a negative latency. Only energy is flat while idle.
    const preExisting = (t: number | null) =>
      t === null ? " (no growth after the read request)" : "";
    console.log(`  response.created → first audio SAMPLES    ${gap(readCreated, tSamples)}${preExisting(tSamples)}`);
    console.log(`  response.created → VOICE AUDIBLE          ${gap(readCreated, tEnergy)}   ← candidate hears it`);
    console.log(`  response.created → first video FRAME      ${gap(readCreated, tFrames)}${preExisting(tFrames)}`);
    console.log(`  stream start → voice (silence on the wire) ${gap(tSamples, tEnergy)}`);
    console.log("");
    console.log(`  engine: ${engine ?? "unknown"}`);
    console.log(`  speech detected via: ${speech.via}`);
    if (voided) {
      console.log("  *** VOID: no speech onset could be timed for this run. ***");
    }
    console.log("  --- what the candidate experiences ---");
    console.log(`  "I'm ready" click → audible voice         ${gap(at("ready_clicked"), tEnergy)}`);
    console.log(`  read request → audible voice              ${gap(readSent, tEnergy)}`);
    console.log(`  whole read (create → done)                ${gap(readSent, readDone)}`);
    console.log("=========================================================\n");

    // Append to a JSONL file so several runs can be aggregated into a median. One sample is an anecdote;
    // the latency series reports medians over multiple runs and this probe should meet the same bar.
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const record = {
      ts: new Date().toISOString(),
      voided,
      segments: {
        click_to_proxy_connected: span("ready_clicked", "proxy_connected"),
        proxy_connected_to_session_updated: span("proxy_connected", "session_updated"),
        session_updated_to_avatar_connect: span("session_updated", "avatar_connect_sent"),
        avatar_connect_to_answer: span("avatar_connect_sent", "avatar_answer"),
        answer_to_pc_connected: span("avatar_answer", "pc_connected"),
        pc_connected_to_read_sent: span("pc_connected", "read_sent"),
        read_sent_to_created: span("read_sent", "read_created"),
        created_to_audible: readCreated !== null && tEnergy !== null ? tEnergy - readCreated : null,
      },
      totals: {
        click_to_audible: at("ready_clicked") !== null && tEnergy !== null ? tEnergy - at("ready_clicked")! : null,
        read_sent_to_audible: readSent !== null && tEnergy !== null ? tEnergy - readSent : null,
      },
      marks,
    };
    fs.appendFileSync(path.join(OUT_DIR, "speak-start.jsonl"), `${JSON.stringify(record)}\n`);
    console.log(`  (appended to e2e/output/speak-start.jsonl)\n`);

    // The probe is only worth reading if audible audio actually happened. Assert that, and nothing about
    // the durations themselves — this is a measurement, and a threshold here would just invent one.
    expect(engine, "performance runs must use the built-in bank, not the external gateway").not.toBe(
      "external",
    );
    expect(
      tEnergy,
      voided
        ? "audio was already playing when the read was requested — re-run against a quiet session"
        : "no audible audio energy followed the read request — the measurement is void",
    ).not.toBeNull();
  });
});

/**
 * Line B: the audio-only timeline.
 *
 * videoPreference always starts at "auto", so an audio-only session cannot be reached cold — the real
 * route is the downgrade, which is also how a candidate on a weak link gets there. This times the two
 * segments that differ from Line A: what the session rebuild costs, and what a read costs once no video
 * is negotiated (no transceiver to carry it, no first frame to wait for).
 *
 * Needs FAKE_AUDIO to supply a spoken answer, because the read being timed is the NEXT question's.
 */
test.describe("Audio-only speak-start (real Azure, after a deliberate downgrade)", () => {
  test.skip(!LIVE, "opt-in: set LIVE_VOICE=1");
  test.skip(!process.env.FAKE_AUDIO, "needs FAKE_AUDIO: the next question's read requires an answer");

  test("times the rebuild and the read once the picture is gone", async ({ page }) => {
    test.setTimeout(420_000);
    const marks: { name: string; t: number }[] = [];
    const mark = (name: string) => {
      if (!marks.some((m) => m.name === name)) marks.push({ name, t: Date.now() });
    };
    /** The WAV carries 45s of leading silence, so the button being ENABLED does not mean anything was
     *  said yet — submitting then sends an empty answer, no next question is read, and the read being
     *  timed never happens. Wait for a real transcript instead. */
    let heardAnswer = "";

    page.on("websocket", (ws) => {
      if (!/voice-live\/ws/.test(ws.url())) return;
      ws.on("framesent", (f) => {
        const d = typeof f.payload === "string" ? f.payload : "";
        if (!d) return;
        try {
          const m = JSON.parse(d) as Record<string, unknown>;
          if (m.type === "session.avatar.connect") mark(`avatar_connect_${marks.filter((x) => x.name.startsWith("avatar_connect")).length + 1}`);
          if (m.type === "response.create") mark(`read_sent_${marks.filter((x) => x.name.startsWith("read_sent")).length + 1}`);
        } catch {
          /* binary */
        }
      });
      ws.on("framereceived", (f) => {
        const d = typeof f.payload === "string" ? f.payload : "";
        if (!d) return;
        try {
          const m = JSON.parse(d) as Record<string, unknown>;
          if (m.type === "session.avatar.connecting") mark(`avatar_answer_${marks.filter((x) => x.name.startsWith("avatar_answer")).length + 1}`);
          if (m.type === "response.created") mark(`read_created_${marks.filter((x) => x.name.startsWith("read_created")).length + 1}`);
          if (m.type === "conversation.item.input_audio_transcription.completed") {
            heardAnswer = String((m as { transcript?: string }).transcript ?? "");
          }
        } catch {
          /* binary */
        }
      });
    });

    await page.addInitScript(() => {
      const w = window as unknown as { __pcs: RTCPeerConnection[] };
      w.__pcs = [];
      const O = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends O {
        constructor(...a: unknown[]) {
          // @ts-expect-error passthrough
          super(...a);
          w.__pcs.push(this);
        }
      } as unknown as typeof RTCPeerConnection;
    });

    const level = async (): Promise<number> =>
      page.evaluate(async () => {
        const w = window as unknown as { __pcs: RTCPeerConnection[] };
        let best = 0;
        for (const pc of w.__pcs) {
          if (pc.connectionState !== "connected") continue;
          const r = await pc.getStats();
          r.forEach((st) => {
            const row = st as unknown as Record<string, unknown>;
            if (row.type === "inbound-rtp" && row.kind === "audio" && typeof row.audioLevel === "number") {
              best = Math.max(best, row.audioLevel as number);
            }
          });
        }
        return best;
      });

    /** Wait for an audible voice, same 0.05 floor and same reasoning as Line A. */
    const waitForVoice = async (budgetMs: number): Promise<number | null> => {
      const until = Date.now() + budgetMs;
      while (Date.now() < until) {
        if ((await level()) > 0.05) return Date.now();
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    };

    await primeCandidateLogin(page);
    await page.goto(`${BASE}/interview`);
    await page.getByRole("button", { name: /开始面试|start interview/i }).click();
    await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
    await waitForInterviewStage(page);
    await enterVoiceChannel(page);

    const view = page.locator('[data-testid="avatar-view"]');
    await expect(view).toHaveAttribute("data-avatar-connected", "true", { timeout: 90_000 });
    // Let the first (video) read finish so the downgrade does not land mid-utterance.
    await page.waitForTimeout(8_000);

    mark("toggle_clicked");
    await page.getByTestId("voice-video-toggle").click();
    await expect(view).toHaveAttribute("data-media-mode", "audio-only", { timeout: 60_000 });
    mark("mode_is_audio_only");
    // "Audio is back" = samples flowing again on the rebuilt connection. Polling the level instead would
    // only report silence until the avatar happens to speak, which is a different question.
    const samples = async (): Promise<number> =>
      page.evaluate(async () => {
        const w = window as unknown as { __pcs: RTCPeerConnection[] };
        let n = 0;
        for (const pc of w.__pcs) {
          if (pc.connectionState !== "connected") continue;
          const r = await pc.getStats();
          r.forEach((st) => {
            const row = st as unknown as Record<string, unknown>;
            if (row.type === "inbound-rtp" && row.kind === "audio" && typeof row.totalSamplesReceived === "number") {
              n = Math.max(n, row.totalSamplesReceived as number);
            }
          });
        }
        return n;
      });
    const base = await samples();
    await expect.poll(async () => await samples(), { timeout: 90_000, intervals: [250] }).toBeGreaterThan(base);
    mark("audio_ready_after_rebuild");

    // Answer so the next question gets read, and time THAT read with no video in the session.
    const doneBtn = page.getByRole("button", { name: /我说完了|i'm done answering/i });
    await expect
      .poll(() => heardAnswer.length, { timeout: 180_000, intervals: [1000] })
      .toBeGreaterThan(10);
    console.log(`  [line B] answer heard: ${JSON.stringify(heardAnswer.slice(0, 70))}`);
    await expect(doneBtn).toBeEnabled({ timeout: 60_000 });
    mark("answer_submittable");
    await doneBtn.click();
    mark("answer_submitted");
    const voiceAt = await waitForVoice(90_000);
    if (voiceAt !== null) marks.push({ name: "voice_audible", t: voiceAt });

    const at = (n: string) => marks.find((m) => m.name === n)?.t ?? null;
    const gap = (a: string, b: string) => {
      const x = at(a);
      const y = at(b);
      return x !== null && y !== null ? `${y - x}ms` : "—";
    };

    console.log("\n===== AUDIO-ONLY TIMELINE (real Azure) =====");
    marks
      .slice()
      .sort((a, b) => a.t - b.t)
      .forEach((m, i, arr) => {
        const d = i === 0 ? 0 : m.t - arr[i - 1].t;
        console.log(`  +${String(m.t - arr[0].t).padStart(6)}ms  (+${String(d).padStart(5)}ms)  ${m.name}`);
      });
    console.log("");
    console.log(`  rebuild: toggle → audio-only mode          ${gap("toggle_clicked", "mode_is_audio_only")}`);
    console.log(`  rebuild: toggle → audio flowing again      ${gap("toggle_clicked", "audio_ready_after_rebuild")}`);
    console.log(`  read (no video): submit → voice audible    ${gap("answer_submitted", "voice_audible")}`);
    console.log("============================================\n");

    expect(at("voice_audible"), "no audible voice after the audio-only read").not.toBeNull();
  });
});
