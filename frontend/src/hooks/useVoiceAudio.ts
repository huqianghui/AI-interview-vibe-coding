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

/** Clip to [-1,1], scale to Int16, and base64-encode — the inverse of playAudio's decode. */
function encodePcmToBase64(audioData: Float32Array): string {
  const int16 = new Int16Array(audioData.length);
  for (let i = 0; i < audioData.length; i++) {
    const clamped = Math.max(-1, Math.min(1, audioData[i] ?? 0));
    int16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function useVoiceAudio() {
  // ── Mic capture ──────────────────────────────────────────────────────────
  const micContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  // ── Playback ─────────────────────────────────────────────────────────────
  const playbackContextRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef(0);

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

  /** Start streaming mic frames; `onFrame` receives each frame as base64 PCM16. */
  const startRecording = useCallback((onFrame: (base64Audio: string) => void) => {
    const node = workletNodeRef.current;
    if (!node) {
      console.debug("[voice-audio] startRecording: worklet not initialized");
      return;
    }
    node.port.postMessage({ command: "START_RECORDING" });
    node.port.onmessage = (e: MessageEvent) => {
      const msg = e.data as { eventType?: string; audioData?: Float32Array };
      if (msg.eventType === "audio" && msg.audioData) {
        onFrame(encodePcmToBase64(msg.audioData));
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
  const ensurePlaybackContext = useCallback((): AudioContext => {
    if (!playbackContextRef.current) {
      playbackContextRef.current = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
    }
    return playbackContextRef.current;
  }, []);

  /** Decode a base64 PCM16 chunk (`response.audio.delta`) and schedule it for gapless playback. */
  const playAudio = useCallback(
    (base64Audio: string) => {
      const ctx = ensurePlaybackContext();
      if (ctx.state === "suspended") void ctx.resume();

      const binaryStr = atob(base64Audio);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) float32[i] = (int16[i] ?? 0) / 32768;

      const buffer = ctx.createBuffer(1, float32.length, PLAYBACK_SAMPLE_RATE);
      buffer.getChannelData(0).set(float32);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);

      nextPlayTimeRef.current = Math.max(nextPlayTimeRef.current, ctx.currentTime);
      src.start(nextPlayTimeRef.current);
      nextPlayTimeRef.current += buffer.duration;
    },
    [ensurePlaybackContext],
  );

  const stopAudio = useCallback(() => {
    void playbackContextRef.current?.close().catch(() => undefined);
    playbackContextRef.current = null;
    nextPlayTimeRef.current = 0;
  }, []);

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
    prepareAudioContext,
  };
}
