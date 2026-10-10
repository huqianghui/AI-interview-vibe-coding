/**
 * Mic capture + assistant-audio playback for the Voice Live WS-proxy transport (SPEC F9).
 *
 * Ported from the reference Avatar layer's `use-audio-handler.ts` + `use-audio-player.ts`, merged
 * into one hook (this project has no separate `voice-logger`/`voice-utils` modules, so logging is
 * plain `console.debug` and the base64 PCM encode/decode lives here rather than a shared lib).
 *
 * Mic side: `getUserMedia` → `AudioContext(MIC_SAMPLE_RATE)` → `AudioWorkletNode` (see
 * `public/audio-processor.js`) → `startRecording(onFrame)` delivers each captured frame as a
 * base64-encoded PCM16 string, ready to send verbatim as `input_audio_buffer.append`'s `audio`
 * field over the Voice Live WS.
 *
 * Playback side: `playAudio(base64Audio)` decodes a `response.audio.delta` chunk (base64 PCM16
 * mono @24kHz) and schedules it gaplessly via `AudioContext.createBufferSource()` — each chunk
 * starts exactly when the previous one ends (`nextPlayTimeRef`), so back-to-back deltas stream
 * without clicks/gaps.
 */
import { useCallback, useEffect, useRef } from "react";
import { voiceMetrics } from "../telemetry/voiceTimeline";

/**
 * Mic capture rate, in Hz. MUST equal the backend's `input_audio_sampling_rate`
 * (`Settings.voice_live_input_sampling_rate`) — Azure interprets the raw PCM byte stream at whatever
 * the session declared, so a mismatch makes the interviewer hear a pitch-shifted, time-warped
 * candidate and transcription collapses. `useInterviewVoice` cross-checks this against the rate the
 * backend echoes in `proxy.connected` and screams if they ever drift.
 *
 * 16 kHz, not Voice Live's 24 kHz default, because we run a CASCADED model (`gpt-5-mini` = "audio
 * input through Azure speech to text"), and Azure's recogniser is a 16 kHz pipeline — it downsamples
 * our 24 kHz and throws the 8–12 kHz band away. That band carries no phonemic information (consonant
 * cues live below 8 kHz), so this costs nothing in accuracy and saves a third of the uplink: measured
 * 540–680 kbps at 24 kHz, which on a narrow office uplink starved our own `session.avatar.connect`
 * signalling until the avatar handshake timed out (`docs/avatar-weaknet-probe.md` §3.8, finding 5).
 * Background and the protocol-inheritance reason for Azure's 24 kHz default:
 * `docs/voice-live-control-notes.md` §4. REVISIT if the voice model ever becomes a native-audio one
 * (`gpt-realtime`): those are trained at 24 kHz and downsampling could genuinely cost accuracy.
 */
export const MIC_SAMPLE_RATE = 16_000;

/** Azure's PCM16 output rate for `response.audio.delta`. Independent of the mic rate — do not fold
 * these two constants together. */
const PLAYBACK_SAMPLE_RATE = 24_000;

/** Voice Live's own default for `input_audio_sampling_rate` when a session does not declare one
 * (inherited from the Realtime wire format, where `pcm16` IS 24 kHz). Used by the drift guard to
 * interpret a `proxy.connected` frame that carries no rate: that means a backend older than this
 * contract, which leaves Azure on this default. */
export const AZURE_DEFAULT_INPUT_SAMPLE_RATE = 24_000;

/** What the playback worklet reports back about its own queue.
 *
 * `underruns` counts GAPS, not silent samples — one per time the queue ran dry mid-speech, which is
 * exactly the number the perf review asked for as the measure of whether the buffer works. */
export interface PlaybackStats {
  underruns: number;
  bufferedMs: number;
  /** How long the most recent counted gap lasted. Reported separately from `bufferedMs` because the
   * buffer depth when the warning is POSTED says nothing about the gap — the audio that ended it has
   * already arrived by then (measured live: "buffer 757ms" about a gap that happened at depth 0). */
  lastGapMs: number;
  state: "filling" | "playing" | "ramping-out";
}

/** Chunk size for the base64 encode. `String.fromCharCode.apply` is far faster than appending one
 * character at a time, but it spreads the chunk onto the call stack, so the chunk must stay well
 * under the engine's argument limit (~65k in V8) — 8 KB is comfortable and still only a handful
 * of calls for a 40 ms batch. */
const B64_CHUNK_BYTES = 8192;

/** Base64-encode already-Int16 PCM bytes — the inverse of playAudio's decode.
 *
 * The Float32 → Int16 conversion used to happen here, on the main thread, once per 8 ms render
 * quantum. It now happens in the worklet (see public/audio-processor.js), which both moves the
 * work off the thread that renders React and decodes the avatar's video, and lets the buffer be
 * TRANSFERRED here instead of copied. This keeps the one step that genuinely cannot move: `btoa`
 * does not exist in AudioWorkletGlobalScope.
 *
 * Still exported, and still used: the binary uplink is NEGOTIATED, so a page talking to a backend
 * that predates it falls back to this. See `useInterviewVoice`'s `binaryAudioRef`. */
export function encodePcmToBase64(pcm: ArrayBuffer): string {
  const bytes = new Uint8Array(pcm);
  let binary = "";
  for (let i = 0; i < bytes.length; i += B64_CHUNK_BYTES) {
    const chunk = bytes.subarray(i, i + B64_CHUNK_BYTES) as unknown as number[];
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

export function useVoiceAudio() {
  // ── Mic capture ──────────────────────────────────────────────────────────
  const micContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  // ── Playback ─────────────────────────────────────────────────────────────
  const playbackContextRef = useRef<AudioContext | null>(null);
  const playbackNodeRef = useRef<AudioWorkletNode | null>(null);
  /** In flight while the playback worklet module loads. `playAudio` can be called before it
   * resolves (the first `response.audio.delta` races the module fetch), so chunks that arrive
   * meanwhile wait in `pendingPlaybackRef` instead of being dropped. */
  const playbackReadyRef = useRef<Promise<void> | null>(null);
  const pendingPlaybackRef = useRef<ArrayBuffer[]>([]);
  /** Last stats frame from the worklet: how deep the buffer is and how many gaps it has had. Read
   * by `getPlaybackStats` — the only way the main thread can see inside the worklet's queue, and
   * what makes the jitter buffer measurable rather than merely plausible. */
  const playbackStatsRef = useRef<PlaybackStats>({
    underruns: 0,
    bufferedMs: 0,
    lastGapMs: 0,
    state: "filling",
  });

  /** Request mic access and load the recorder worklet. Throws on getUserMedia denial (the caller
   * distinguishes that as MicAccessError) or on worklet-module load failure. */
  const initMic = useCallback(async (): Promise<void> => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: MIC_SAMPLE_RATE,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    micStreamRef.current = stream;

    // The AudioContext rate is the load-bearing one: the getUserMedia constraint is advisory (Chrome
    // often hands back the device's native rate anyway), and `createMediaStreamSource` resamples into
    // the context's rate, which is what the worklet — and therefore Azure — actually sees.
    const ctx = new AudioContext({ sampleRate: MIC_SAMPLE_RATE });
    await ctx.audioWorklet.addModule("/audio-processor.js");
    micContextRef.current = ctx;

    const source = ctx.createMediaStreamSource(stream);
    const workletNode = new AudioWorkletNode(ctx, "audio-recorder-processor");
    source.connect(workletNode);
    // Not connected to ctx.destination: we don't want to hear our own mic locally.
    workletNodeRef.current = workletNode;
  }, []);

  /** Start streaming mic frames; `onFrame` receives each batch as raw Int16 PCM.
   *
   * One call per BATCH, not per render quantum — the worklet aggregates 40 ms before posting, so
   * this fires ~25 times a second rather than 125 (measured; the worklet's header has the
   * arithmetic).
   *
   * Hands over the RAW buffer rather than base64: whether the wire wants base64 is a protocol
   * question, answered by the transport (`useInterviewVoice`, from the backend's `binary_audio`
   * capability) rather than guessed here. `encodePcmToBase64` is exported for that fallback. */
  const startRecording = useCallback((onFrame: (pcm: ArrayBuffer) => void) => {
    const node = workletNodeRef.current;
    if (!node) {
      console.debug("[voice-audio] startRecording: worklet not initialized");
      return;
    }
    node.port.postMessage({ command: "START_RECORDING" });
    node.port.onmessage = (e: MessageEvent) => {
      const msg = e.data as { eventType?: string; pcm?: ArrayBuffer };
      if (msg.eventType === "audio" && msg.pcm) {
        onFrame(msg.pcm);
      }
    };
  }, []);

  const stopRecording = useCallback(() => {
    workletNodeRef.current?.port.postMessage({ command: "STOP_RECORDING" });
  }, []);

  /** Enable/disable the raw mic hardware track (used for mute — stops capture at the source). */
  const setMicEnabled = useCallback((enabled: boolean) => {
    micStreamRef.current?.getTracks().forEach((t) => {
      t.enabled = enabled;
    });
  }, []);

  const cleanupMic = useCallback(() => {
    stopRecording();
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    void micContextRef.current?.close().catch(() => undefined);
    micContextRef.current = null;
    workletNodeRef.current = null;
  }, [stopRecording]);

  /** Lazily create the playback AudioContext (matches Voice Live's PCM16 OUTPUT rate, which is
   * unaffected by the mic rate above). */
  /** Create the playback context and start loading the jitter-buffer worklet into it.
   *
   * The module load is async and `playAudio` is not, so the promise is kept rather than awaited:
   * callers get a usable context immediately and audio that arrives early is queued on the main
   * thread until the node exists. A failed load leaves `playbackNodeRef` null — see `playAudio`. */
  const ensurePlaybackContext = useCallback((): AudioContext => {
    if (!playbackContextRef.current) {
      playbackContextRef.current = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
    }
    const ctx = playbackContextRef.current;
    if (!playbackReadyRef.current) {
      playbackReadyRef.current = ctx.audioWorklet
        .addModule("/audio-playback-processor.js")
        .then(() => {
          const node = new AudioWorkletNode(ctx, "audio-playback-processor", {
            numberOfInputs: 0,
            outputChannelCount: [1],
          });
          node.port.onmessage = (e: MessageEvent) => {
            const msg = e.data as PlaybackStats & { eventType?: string };
            if (msg.eventType === "started") {
              // The worklet just began rendering a response's audio: the candidate hears it now.
              voiceMetrics.turn("first_audible");
              return;
            }
            if (msg.eventType !== "stats") return;
            // Log each new gap rather than only the total. This is the one symptom a candidate
            // reports as "the interviewer kept cutting out", and without it the only evidence is
            // their word — the counter lives in the worklet and nothing else can see it. Also what
            // the live probe reads to verify the buffer at all (`bufferedMs` says how close the
            // cushion came to empty, which is what decides whether 150 ms is the right depth).
            if (msg.state === "playing" && playbackStatsRef.current.state !== "playing") {
              // Once per session: the moment the candidate first hears the interviewer on this path.
              console.debug(
                `[voice-audio] playback started (buffer ${msg.bufferedMs.toFixed(0)}ms)`,
              );
            }
            // Warn when a gap ENDS, not when the counter ticks: the length is only known once the
            // buffer has refilled, so warning on the increment printed "0ms" (measured — the first
            // version of this log did exactly that).
            if (msg.lastGapMs > 0 && msg.lastGapMs !== playbackStatsRef.current.lastGapMs) {
              // Counted on the turn the candidate heard it in (voiceTimeline, `voice.turn`).
              voiceMetrics.count("playback_gaps");
              voiceMetrics.count("playback_gap_ms_total", Math.round(msg.lastGapMs));
              console.warn(
                `[voice-audio] playback underrun #${String(msg.underruns)} — the interviewer's ` +
                  `voice had a gap of ${msg.lastGapMs.toFixed(0)}ms`,
              );
            }
            playbackStatsRef.current = {
              underruns: msg.underruns,
              bufferedMs: msg.bufferedMs,
              lastGapMs: msg.lastGapMs,
              state: msg.state,
            };
          };
          node.connect(ctx.destination);
          playbackNodeRef.current = node;
          // Hand over whatever arrived while the module was loading, in order.
          for (const pcm of pendingPlaybackRef.current) node.port.postMessage({ pcm }, [pcm]);
          pendingPlaybackRef.current = [];
        })
        .catch((err: unknown) => {
          // Audio is the whole product here, so a load failure has to be loud rather than silent.
          console.error(
            "[voice-audio] playback worklet failed to load — the interviewer will be inaudible",
            err,
          );
        });
    }
    return ctx;
  }, []);

  /** Decode a base64 PCM16 chunk (`response.audio.delta`) and hand it to the jitter buffer.
   *
   * No scheduling happens here any more: the worklet owns timing, so this is only a decode and a
   * transfer. See public/audio-playback-processor.js for why the buffer exists. */
  const playAudio = useCallback(
    (base64Audio: string) => {
      const ctx = ensurePlaybackContext();
      if (ctx.state === "suspended") void ctx.resume();

      const binaryStr = atob(base64Audio);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      // The worklet converts Int16 → float itself, so the bytes go across untouched and the
      // buffer is TRANSFERRED rather than copied (same reasoning as the capture side).
      const node = playbackNodeRef.current;
      if (node) node.port.postMessage({ pcm: bytes.buffer }, [bytes.buffer]);
      else pendingPlaybackRef.current.push(bytes.buffer);
    },
    [ensurePlaybackContext],
  );

  /** Drop every queued sample immediately, keeping the context and the node alive.
   *
   * Deliberately does NOT close the AudioContext, which is what the old `stopAudio` did. Closing it
   * means the next session constructs a fresh one and has to clear the browser's autoplay gate
   * again from whatever call stack happens to be running.
   *
   * DELIBERATELY NOT WIRED TO BARGE-IN — a settled decision (owner, 2026-10-03), not a loose end.
   * Nothing drops queued audio when the candidate starts talking, so the interviewer plays over them
   * for whatever Azure had already sent: measured, up to about 4 seconds.
   *
   * The measurement that settled it is in the perf review §4.4 ⑤. Azure cannot help — it delivered
   * 4275 ms of audio in 783 ms and marked the response `completed` 10 ms BEFORE the candidate opened
   * their mouth, then emitted nothing at all for the 5 s they spoke. "The interviewer is speaking"
   * exists only in this queue, so `interrupt_response: True` is inert here. Cutting would therefore
   * be entirely our choice, and the owner chose not to: the candidate hearing two voices for a few
   * seconds is better than their missing the back half of the question. Transcription is unaffected
   * either way — the uplink is their own microphone, echo-cancelled at both ends.
   *
   * So this is used by teardown only. Do not wire it to `speech_started` without reopening that
   * decision. */
  const flushPlayback = useCallback(() => {
    playbackNodeRef.current?.port.postMessage({ command: "flush" });
    pendingPlaybackRef.current = [];
    playbackStatsRef.current = { underruns: 0, bufferedMs: 0, lastGapMs: 0, state: "filling" };
  }, []);

  /** Tell the jitter buffer that Azure has finished sending this response's audio.
   *
   * Required for the underrun counter to mean anything: the worklet cannot tell a finished sentence
   * from a stalled network — both just empty the queue — so without this every utterance would log
   * an underrun. Wired to `response.audio.done`. Harmless if it never arrives: the next chunk clears
   * the flag, so the only cost of a missed marker is one over-counted gap. */
  const endPlaybackStream = useCallback(() => {
    playbackNodeRef.current?.port.postMessage({ command: "end" });
  }, []);

  const stopAudio = useCallback(() => {
    flushPlayback();
  }, [flushPlayback]);

  /** Latest buffer depth + underrun count from the worklet (see PlaybackStats). */
  const getPlaybackStats = useCallback((): PlaybackStats => playbackStatsRef.current, []);

  /** Resume the playback AudioContext inside a user-gesture handler (Chrome autoplay policy) —
   * call this synchronously in the click handler that starts the session, before any async WS
   * event tries to call `playAudio`. */
  const prepareAudioContext = useCallback(async (): Promise<void> => {
    const ctx = ensurePlaybackContext();
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch (err) {
        console.debug("[voice-audio] AudioContext resume() failed", err);
      }
    }
  }, [ensurePlaybackContext]);

  useEffect(() => {
    return () => {
      cleanupMic();
      stopAudio();
    };
  }, [cleanupMic, stopAudio]);

  return {
    initMic,
    startRecording,
    stopRecording,
    setMicEnabled,
    cleanupMic,
    playAudio,
    stopAudio,
    flushPlayback,
    endPlaybackStream,
    getPlaybackStats,
    prepareAudioContext,
  };
}
