/**
 * Interview voice hook (SPEC F9) — ported from the reference Avatar layer's
 * `use-anonymous-voice-live.ts`, adapted to the interview backend.
 *
 * The candidate's browser connects DIRECTLY to Azure Voice Live over WebRTC; the backend only
 * brokers the signaling URL + a short-lived bearer (see `fetchVoiceSession`). This hook owns the
 * WebRTC/RTCPeerConnection bootstrap: SDP offer/answer over a signaling WebSocket, a
 * `voice-live-events` data channel for transcripts/VAD, and a **3-attempt reconnect with
 * 1s/2s/4s backoff**. `MicAccessError` is thrown ONLY when `getUserMedia` fails, so the caller can
 * distinguish "grant mic access" from service-side failures (backend 409/503, signaling errors).
 *
 * Deviation from the reference: session issuance calls the interview endpoint
 * (`fetchVoiceSession(interviewId, locale)`) instead of the anonymous-avatar broker; a
 * `VoiceSessionError` with status 409/503 propagates so the page can fall back to text (P6b).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchVoiceSession, type VoiceSession } from "../api/client";
import type { AudioState, TranscriptSegment, VoiceConnectionState } from "../types/voice";

/** Thrown ONLY when `getUserMedia` fails (mic denied / no hardware) — never for service errors. */
export class MicAccessError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MicAccessError";
  }
}

import type { RefObject } from "react";

export interface UseInterviewVoiceOptions {
  locale?: string;
  onTranscript?: (segment: TranscriptSegment) => void;
  onConnectionStateChange?: (state: VoiceConnectionState) => void;
  onAudioStateChange?: (state: AudioState) => void;
  onResponseDone?: () => void;
  onError?: (error: Error) => void;
  /** Attached via `ontrack` when Voice Live sends a digital-human avatar video track. When set,
   * the hook negotiates a recvonly video transceiver so the avatar face isn't silently dropped. */
  videoRef?: RefObject<HTMLVideoElement | null>;
}

const MAX_RECONNECT = 3;
const RECONNECT_DELAYS = [1000, 2000, 4000];
const CONNECT_TIMEOUT_MS = 30_000;
const ICE_GATHERING_TIMEOUT_MS = 5_000;

export function useInterviewVoice(interviewId: string, options: UseInterviewVoiceOptions = {}) {
  const [connectionState, setConnectionState] = useState<VoiceConnectionState>("disconnected");
  const [audioState, setAudioState] = useState<AudioState>("idle");
  const [isMuted, setIsMuted] = useState(false);
  // True once a real avatar video track has arrived via ontrack; drives AvatarView video-vs-orb.
  const [isAvatarConnected, setIsAvatarConnected] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const signalingWsRef = useRef<WebSocket | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalCloseRef = useRef(false);
  const lastLocaleRef = useRef<string | undefined>(undefined);
  const transcriptIdCounter = useRef(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const setConn = useCallback((state: VoiceConnectionState) => {
    setConnectionState(state);
    optionsRef.current.onConnectionStateChange?.(state);
  }, []);

  const setAudio = useCallback((state: AudioState) => {
    setAudioState(state);
    optionsRef.current.onAudioStateChange?.(state);
  }, []);

  const cleanup = useCallback(() => {
    if (dataChannelRef.current) {
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (signalingWsRef.current) {
      signalingWsRef.current.close();
      signalingWsRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
      remoteAudioRef.current.remove();
      remoteAudioRef.current = null;
    }
  }, []);

  /** Data-channel messages: transcripts, VAD, response lifecycle. */
  const handleDataChannelMessage = useCallback((event: MessageEvent) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(event.data as string) as Record<string, unknown>;
    } catch {
      return;
    }
    const emit = (role: "user" | "assistant", content: string, isFinal: boolean, id: string) =>
      optionsRef.current.onTranscript?.({ id, role, content, isFinal, timestamp: Date.now() });

    switch (msg.type as string | undefined) {
      case "input_audio_buffer.speech_started":
        setAudio("listening");
        break;
      case "input_audio_buffer.speech_stopped":
        setAudio("idle");
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (msg.transcript) emit("user", msg.transcript as string, true, `user-${++transcriptIdCounter.current}`);
        break;
      case "response.created":
        setAudio("speaking");
        break;
      case "response.audio_transcript.delta":
        if (msg.delta)
          emit("assistant", msg.delta as string, false, `assistant-${msg.response_id}-${msg.item_id}`);
        break;
      case "response.audio_transcript.done":
        if (msg.transcript)
          emit("assistant", msg.transcript as string, true, `assistant-${msg.response_id}-${msg.item_id}`);
        break;
      case "response.done":
        setAudio("idle");
        optionsRef.current.onResponseDone?.();
        break;
      case "error":
        optionsRef.current.onError?.(
          new Error(((msg.error as Record<string, unknown>)?.message as string) || "Data channel error"),
        );
        break;
    }
  }, [setAudio]);

  const connect = useCallback(
    async (locale?: string, isReconnect = false): Promise<void> => {
      const effectiveLocale = locale ?? optionsRef.current.locale ?? "zh-CN";
      lastLocaleRef.current = effectiveLocale;
      // Only a user-initiated connect resets the attempt counter. The auto-reconnect path
      // below re-invokes connect() with isReconnect=true so the 3-attempt cap actually
      // accumulates across cycles — otherwise a down broker becomes an unbounded retry loop.
      if (!isReconnect) reconnectAttemptRef.current = 0;
      intentionalCloseRef.current = false;
      setConn("connecting");

      // Step 1: broker session (may throw VoiceSessionError 409/503 — propagate for text fallback).
      let session: VoiceSession;
      try {
        session = await fetchVoiceSession(interviewId, effectiveLocale);
      } catch (err) {
        setConn("error");
        const error = err instanceof Error ? err : new Error("Failed to broker voice session");
        optionsRef.current.onError?.(error);
        throw error;
      }

      // Step 2: microphone. A failure here is a MicAccessError (distinct from service errors).
      let micStream: MediaStream;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micStreamRef.current = micStream;
      } catch (err) {
        setConn("error");
        const error = new MicAccessError(
          err instanceof Error ? err.message : "Microphone access denied",
          { cause: err },
        );
        optionsRef.current.onError?.(error);
        throw error;
      }

      // Step 3: RTCPeerConnection (no ICE servers — Azure handles TURN).
      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      micStream.getTracks().forEach((track) => pc.addTrack(track, micStream));

      // Step 3b: negotiate a recvonly video transceiver so a digital-human avatar video track from
      // Voice Live (when the session requests the avatar modality) isn't silently dropped.
      pc.addTransceiver("video", { direction: "recvonly" });

      // Step 4: data channel BEFORE createOffer.
      const dc = pc.createDataChannel("voice-live-events");
      dataChannelRef.current = dc;
      dc.onmessage = handleDataChannelMessage;

      // Step 5: remote audio + avatar-video playback.
      pc.ontrack = (event) => {
        if (event.track.kind === "video") {
          const videoEl = optionsRef.current.videoRef?.current;
          if (videoEl) {
            videoEl.srcObject = event.streams[0] ?? null;
            videoEl.play().catch(() => undefined);
          }
          setIsAvatarConnected(true);
          return;
        }
        if (event.track.kind !== "audio") return;
        const audio = document.createElement("audio");
        audio.srcObject = event.streams[0] ?? null;
        audio.autoplay = true;
        audio.style.display = "none";
        document.body.appendChild(audio);
        audio.play().catch(() => undefined);
        remoteAudioRef.current = audio;
      };

      // Reconnect on connection failure: 3 attempts, 1s/2s/4s backoff.
      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if ((state === "disconnected" || state === "failed") && !intentionalCloseRef.current) {
          if (reconnectAttemptRef.current < MAX_RECONNECT) {
            reconnectAttemptRef.current++;
            const delay = RECONNECT_DELAYS[reconnectAttemptRef.current - 1] ?? 4000;
            setConn("reconnecting");
            cleanup();
            reconnectTimerRef.current = setTimeout(() => {
              void connect(lastLocaleRef.current, true).catch(() => undefined);
            }, delay);
          } else {
            setConn("error");
            optionsRef.current.onError?.(new Error("Voice connection failed after 3 attempts"));
          }
        }
      };

      // Step 6: SDP offer.
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Step 7: wait for ICE gathering (or 5s timeout).
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === "complete") return resolve();
        let resolved = false;
        const done = () => {
          if (!resolved) {
            resolved = true;
            pc.removeEventListener("icegatheringstatechange", onChange);
            resolve();
          }
        };
        const onChange = () => {
          if (pc.iceGatheringState === "complete") done();
        };
        pc.addEventListener("icegatheringstatechange", onChange);
        setTimeout(done, ICE_GATHERING_TIMEOUT_MS);
      });

      // Step 8: signaling WebSocket. Browsers can't set WS headers, so the bearer rides as a query
      // parameter. The verified-accepted form is `Authorization=Bearer <token>` (a bare `api-key`
      // or `access_token` query is rejected 401 on the GA endpoint).
      const sep = session.signaling_url.includes("?") ? "&" : "?";
      const signalingUrl = `${session.signaling_url}${sep}Authorization=${encodeURIComponent(`Bearer ${session.auth_token}`)}`;

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(signalingUrl);
        signalingWsRef.current = ws;
        let resolved = false;

        ws.onopen = () => {
          ws.send(JSON.stringify({ type: "rtc.call.sdp.create", sdp_offer: pc.localDescription?.sdp }));
        };

        ws.onmessage = (event: MessageEvent) => {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(event.data as string) as Record<string, unknown>;
          } catch {
            return;
          }
          if (msg.type === "rtc.call.sdp.created" && msg.sdp_answer) {
            pc.setRemoteDescription({ type: "answer", sdp: msg.sdp_answer as string })
              .then(() => {
                ws.send(JSON.stringify({ type: "session.update", session: session.session_config }));
                setConn("connected");
                setAudioState("idle");
                if (!resolved) {
                  resolved = true;
                  resolve();
                }
              })
              .catch((err: unknown) => {
                if (!resolved) {
                  resolved = true;
                  const error = err instanceof Error ? err : new Error("Failed to set remote SDP");
                  setConn("error");
                  optionsRef.current.onError?.(error);
                  reject(error);
                }
              });
          } else if (msg.type === "error" || msg.type === "rtc.call.error") {
            // The /voice-live/realtime/calls endpoint surfaces call-level failures as
            // `rtc.call.error` (e.g. a rejected agent/SDP); plain `error` is the session-level form.
            // Handle both so a rejection fails fast instead of hitting the 30s timeout.
            if (!resolved) {
              resolved = true;
              const error = new Error(
                ((msg.error as Record<string, unknown>)?.message as string) || "Signaling error",
              );
              setConn("error");
              optionsRef.current.onError?.(error);
              reject(error);
            }
          }
        };

        ws.onerror = () => {
          if (!resolved) {
            resolved = true;
            const error = new Error("Signaling WebSocket connection failed");
            setConn("error");
            optionsRef.current.onError?.(error);
            reject(error);
          }
        };

        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            cleanup();
            const error = new Error("Voice connection timeout (30s)");
            setConn("error");
            optionsRef.current.onError?.(error);
            reject(error);
          }
        }, CONNECT_TIMEOUT_MS);
      });
    },
    [cleanup, handleDataChannelMessage, interviewId, setConn],
  );

  const disconnect = useCallback(async () => {
    intentionalCloseRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    cleanup();
    setConn("disconnected");
    setAudioState("idle");
    setIsMuted(false);
    setIsAvatarConnected(false);
  }, [cleanup, setConn]);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const next = !prev;
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((t) => {
          t.enabled = !next;
        });
      }
      setAudio(next ? "muted" : "idle");
      return next;
    });
  }, [setAudio]);

  /** Signal end-of-answer to Voice Live (paired with the manual "I'm done" control, P13). */
  const commitAnswer = useCallback(() => {
    const ws = signalingWsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "response.create" }));
    }
  }, []);

  /** Speak the backend-provided question text verbatim (SPEC Phase 4 voice→turn sub-design).
   *
   * The backend keeps the question pointer authoritative, so voice must SPEAK its text, not let
   * the agent generate its own. We inject the question as an assistant conversation item and ask
   * Voice Live to read it exactly, rather than firing a bare `response.create` (which would make
   * the agent autonomously produce whatever its generic instructions yield). Returns true if the
   * request was sent (a live socket exists). Live-path behaviour is Layer-3 verified. */
  const speakQuestion = useCallback((text: string): boolean => {
    const ws = signalingWsRef.current;
    if (!text || ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: { type: "message", role: "assistant", content: [{ type: "text", text }] },
      }),
    );
    // Read the injected text verbatim — not an agent-generated turn.
    ws.send(
      JSON.stringify({
        type: "response.create",
        response: { instructions: `Read this question aloud verbatim, then stop:\n${text}` },
      }),
    );
    return true;
  }, []);

  useEffect(() => {
    return () => {
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      cleanup();
    };
  }, [cleanup]);

  return {
    connect,
    disconnect,
    toggleMute,
    commitAnswer,
    speakQuestion,
    isMuted,
    connectionState,
    audioState,
    isAvatarConnected,
  };
}
