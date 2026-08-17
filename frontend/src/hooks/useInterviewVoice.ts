/**
 * Interview voice hook (SPEC F9 avatar-video path) — backend-WS-proxy transport.
 *
 * REPLACES the direct-to-Azure WebRTC transport this hook used to implement. That transport
 * couldn't render avatar video: on `/voice-live/realtime/calls` (browser→Azure direct), Azure
 * accepts the avatar modality but never hands back `avatar.ice_servers` or starts the avatar video
 * pipeline (live-verified: track opens, 0 frames). Real avatar video needs Azure's avatar SDP
 * handshake (`session.avatar.connect`/`session.avatar.connecting`) to ride the SAME connection
 * that sent `session.update` — a short-lived STS credential handed to a fresh browser WebRTC
 * connection can't reuse that context. So the backend now holds the one Azure Voice Live SDK
 * connection and relays everything over a single WebSocket at `/api/voice-live/ws`
 * (`app/api/voice_live_ws.py` + `app/services/voice_live_proxy.py`):
 *
 *   - mic PCM goes UP as `input_audio_buffer.append` base64 frames (see `useVoiceAudio`).
 *   - assistant audio (base64 PCM16 24kHz, `response.audio.delta`) + transcript events come DOWN.
 *   - avatar VIDEO is a SEPARATE recvonly `RTCPeerConnection` (`useAvatarStream`) whose ICE servers
 *     arrive in `session.updated` (`session.avatar.ice_servers`) and whose SDP offer/answer is
 *     relayed over this same WS as `session.avatar.connect` (client) / `session.avatar.connecting`
 *     (server).
 *
 * The backend already auto-configures the Voice Live session server-side (from the resolved
 * persona + `locale` query param) before relaying anything to the browser — unlike the reference
 * Avatar layer this was ported from, this hook does NOT send a client-initiated `session.update`
 * bootstrap on open.
 *
 * Auth: browsers can't set WS headers, so the token rides as a `?token=` query param. The
 * candidate interview path defaults to the anon session token (`api/client.ts`); the admin editor
 * Playground passes its own `tokenProvider` (`getAdminToken` from `api/admin.ts`) + `personaId` so
 * the WS pins the persona under test instead of resolving the default enabled one.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { _internal as clientInternal, type VoiceSession } from "../api/client";
import { useVoiceAudio } from "./useVoiceAudio";
import { useAvatarStream } from "./useAvatarStream";
import type { AudioState, TranscriptSegment, VoiceConnectionState } from "../types/voice";

/** Thrown ONLY when `getUserMedia` fails (mic denied / no hardware) — never for service errors. */
export class MicAccessError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MicAccessError";
  }
}

export interface UseInterviewVoiceOptions {
  locale?: string;
  onTranscript?: (segment: TranscriptSegment) => void;
  onConnectionStateChange?: (state: VoiceConnectionState) => void;
  onAudioStateChange?: (state: AudioState) => void;
  onResponseDone?: () => void;
  onError?: (error: Error) => void;
  /** Attached to the avatar's video track via `ontrack` once Voice Live's avatar handshake
   * completes and real frames arrive (see `useAvatarStream`). */
  videoRef?: RefObject<HTMLVideoElement | null>;
  /**
   * Kept for compile-compatibility with the old broker-based `VoiceSession` fetch pattern (the
   * admin editor Playground still passes one). UNUSED by the WS-proxy transport — there is no
   * separately-brokered session to fetch anymore, the WS itself IS the session. Retained only so
   * existing callers keep type-checking until they're migrated to `tokenProvider`/`personaId`.
   */
  sessionFetcher?: (locale: string) => Promise<VoiceSession>;
  /** Returns the bearer token for the `/voice-live/ws?token=` query param. Defaults to the
   * candidate anon session token (`api/client.ts`). The admin editor Playground should pass
   * `getAdminToken` (`api/admin.ts`) here instead. */
  tokenProvider?: () => string | null;
  /** Pins the WS to a specific persona (editor Playground). Omitted for the candidate interview
   * path, which lets the backend resolve the default enabled persona. */
  personaId?: string;
}

const MAX_RECONNECT = 3;
const RECONNECT_DELAYS = [1000, 2000, 4000];
const CONNECT_TIMEOUT_MS = 30_000;

/** Wire shape of one entry in `session.updated`'s `session.avatar.ice_servers` (matches the Azure
 * SDK's `IceServer.as_dict()`: each server carries its OWN username/credential). */
interface AvatarIceServerWire {
  urls?: string | string[];
  username?: string;
  credential?: string;
}

function toRtcIceServers(raw: unknown): RTCIceServer[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => entry as AvatarIceServerWire)
    .filter((entry) => !!entry.urls)
    .map((entry) => ({
      urls: entry.urls as string | string[],
      username: entry.username,
      credential: entry.credential,
    }));
}

function buildWsUrl(token: string, personaId: string | undefined, locale: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({ token, locale });
  if (personaId) params.set("persona_id", personaId);
  return `${protocol}//${window.location.host}/api/voice-live/ws?${params.toString()}`;
}

export function useInterviewVoice(interviewId: string, options: UseInterviewVoiceOptions = {}) {
  const [connectionState, setConnectionState] = useState<VoiceConnectionState>("disconnected");
  const [audioState, setAudioState] = useState<AudioState>("idle");
  const [isMuted, setIsMuted] = useState(false);

  const audio = useVoiceAudio();
  // Stable fallback ref (not re-created per render) for callers that don't pass a videoRef.
  const fallbackVideoRef = useRef<HTMLVideoElement | null>(null);
  const avatarStream = useAvatarStream(options.videoRef ?? fallbackVideoRef);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalCloseRef = useRef(false);
  const lastLocaleRef = useRef<string | undefined>(undefined);
  const transcriptIdCounter = useRef(0);
  const avatarEnabledRef = useRef(false);
  // Guards the one-shot avatar handshake (Azure sends two session.updated frames; only the second
  // carries ice_servers — fire the handshake once, on whichever frame has them).
  const avatarStartedRef = useRef(false);
  // Mirrors isMuted for handleMessage's mic-frame callback, which is created once per
  // `session.updated` and must read the LATEST mute state without resubscribing.
  const isMutedRef = useRef(false);
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

  const send = useCallback((data: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  }, []);

  const cleanup = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    avatarStream.disconnect();
    audio.cleanupMic();
    avatarStartedRef.current = false;
  }, [audio, avatarStream]);

  /** WS message handler — Azure Voice Live realtime events, relayed near-verbatim by the backend
   * proxy (plus its own `proxy.connected` bootstrap frame). */
  const handleMessage = useCallback(
    (
      event: MessageEvent,
      onConnected: () => void,
      onFatalError: (error: Error) => void,
    ) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.data as string) as Record<string, unknown>;
      } catch {
        return;
      }

      const emit = (role: "user" | "assistant", content: string, isFinal: boolean, id: string) =>
        optionsRef.current.onTranscript?.({ id, role, content, isFinal, timestamp: Date.now() });

      switch (msg.type as string | undefined) {
        case "proxy.connected":
          avatarEnabledRef.current = Boolean(msg.avatar_enabled);
          console.info(
            "[voice] proxy.connected — mode:",
            msg.mode,
            "avatar_enabled:",
            msg.avatar_enabled,
          );
          break;

        case "session.updated": {
          const session = msg.session as Record<string, unknown> | undefined;
          const avatarConf = session?.avatar as Record<string, unknown> | undefined;
          const iceServers = toRtcIceServers(avatarConf?.ice_servers);

          setConn("connected");
          setAudioState("idle");
          onConnected();

          // Azure sends TWO session.updated frames: the first has `avatar: null`, the SECOND
          // carries the avatar block with ice_servers. Trigger the handshake on the ACTUAL presence
          // of ice_servers in THIS frame (not a separate avatar_enabled flag, which races the two
          // frames), and only once (avatarStarted guard).
          console.info(
            "[voice] session.updated received; avatar block present:",
            !!avatarConf,
            "ice_servers:",
            iceServers.length,
          );
          if (avatarConf && iceServers.length > 0 && !avatarStartedRef.current) {
            avatarStartedRef.current = true;
            console.info("[voice] session.updated has avatar ice_servers → starting handshake");
            void avatarStream
              .connect(iceServers, (clientSdp) => {
                send({ type: "session.avatar.connect", client_sdp: clientSdp });
              })
              .catch((err: unknown) => {
                avatarStartedRef.current = false;
                // Non-fatal: avatar video failed to negotiate, keep the voice-only session alive
                // (AvatarView's fallback orb covers this — see useAvatarStream's frame gate).
                console.warn("[voice] avatar handshake failed; continuing voice-only", err);
              });
          }

          audio.startRecording((base64Audio) => {
            if (isMutedRef.current) return;
            send({ type: "input_audio_buffer.append", audio: base64Audio });
          });
          break;
        }

        case "session.avatar.connecting": {
          const serverSdp = (msg.server_sdp ?? msg.serverSdp) as string | undefined;
          if (serverSdp) avatarStream.handleServerSdp(serverSdp);
          break;
        }

        case "input_audio_buffer.speech_started":
          setAudio("listening");
          break;
        case "input_audio_buffer.speech_stopped":
          setAudio("idle");
          break;
        case "conversation.item.input_audio_transcription.completed":
          if (msg.transcript)
            emit("user", msg.transcript as string, true, `user-${++transcriptIdCounter.current}`);
          break;

        case "response.created":
          setAudio("speaking");
          break;
        case "response.audio.delta":
          if (msg.delta) audio.playAudio(msg.delta as string);
          break;
        case "response.audio_transcript.delta":
          if (msg.delta)
            emit("assistant", msg.delta as string, false, `assistant-${msg.response_id}-${msg.item_id}`);
          break;
        case "response.audio_transcript.done":
          if (msg.transcript)
            emit(
              "assistant",
              msg.transcript as string,
              true,
              `assistant-${msg.response_id}-${msg.item_id}`,
            );
          break;
        case "response.done":
          setAudio("idle");
          optionsRef.current.onResponseDone?.();
          break;

        case "error": {
          const errInfo = msg.error as Record<string, unknown> | undefined;
          const error = new Error((errInfo?.message as string) || "Voice Live error");
          setConn("error");
          optionsRef.current.onError?.(error);
          onFatalError(error);
          break;
        }
      }
    },
    [audio, avatarStream, send, setAudio, setConn],
  );

  const connect = useCallback(
    async (locale?: string, isReconnect = false): Promise<void> => {
      const effectiveLocale = locale ?? optionsRef.current.locale ?? "zh-CN";
      lastLocaleRef.current = effectiveLocale;
      if (!isReconnect) reconnectAttemptRef.current = 0;
      intentionalCloseRef.current = false;
      setConn("connecting");

      // Step 0: unlock autoplay for the assistant-audio AudioContext inside this user gesture,
      // before any async WS event tries to call playAudio() (Chrome autoplay policy).
      await audio.prepareAudioContext();

      // Step 1: resolve the WS auth token (anon session token by default; admin editor Playground
      // passes its own tokenProvider). Not a network broker call anymore — the WS itself is the
      // session.
      const tokenProvider = optionsRef.current.tokenProvider ?? (() => clientInternal.getToken());
      const token = tokenProvider();
      if (!token) {
        const error = new Error("No voice auth token available");
        setConn("error");
        optionsRef.current.onError?.(error);
        throw error;
      }

      // Step 2: microphone. A failure here is a MicAccessError (distinct from service errors).
      try {
        await audio.initMic();
      } catch (err) {
        setConn("error");
        const error = new MicAccessError(
          err instanceof Error ? err.message : "Microphone access denied",
          { cause: err },
        );
        optionsRef.current.onError?.(error);
        throw error;
      }

      // Step 3: open the Voice Live WS proxy and wait for `session.updated` (connected) or an
      // error/timeout.
      const wsUrl = buildWsUrl(token, optionsRef.current.personaId, effectiveLocale);
      console.info(
        "[voice] opening WS proxy; persona:",
        optionsRef.current.personaId ?? "(default)",
        "locale:",
        effectiveLocale,
      );

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        let resolved = false;

        const resolveOnce = () => {
          if (resolved) return;
          resolved = true;
          resolve();
        };
        const rejectOnce = (error: Error) => {
          if (resolved) return;
          resolved = true;
          reject(error);
        };

        ws.onmessage = (event) => handleMessage(event, resolveOnce, rejectOnce);

        ws.onerror = () => {
          rejectOnce(new Error("Voice Live WebSocket connection failed"));
        };

        ws.onclose = () => {
          const wasConnected = resolved;
          wsRef.current = null;
          if (!wasConnected) {
            rejectOnce(new Error("Voice Live WebSocket closed before connecting"));
            return;
          }
          if (intentionalCloseRef.current) return;
          // Reconnect on unexpected close: 3 attempts, 1s/2s/4s backoff.
          if (reconnectAttemptRef.current < MAX_RECONNECT) {
            reconnectAttemptRef.current++;
            const delay = RECONNECT_DELAYS[reconnectAttemptRef.current - 1] ?? 4000;
            setConn("reconnecting");
            avatarStream.disconnect();
            audio.stopRecording();
            reconnectTimerRef.current = setTimeout(() => {
              void connect(lastLocaleRef.current, true).catch(() => undefined);
            }, delay);
          } else {
            setConn("error");
            optionsRef.current.onError?.(new Error("Voice connection failed after 3 attempts"));
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
    [audio, avatarStream, cleanup, handleMessage, setConn],
  );

  const disconnect = useCallback(async () => {
    intentionalCloseRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    cleanup();
    audio.stopAudio();
    setConn("disconnected");
    setAudioState("idle");
    setIsMuted(false);
    isMutedRef.current = false;
  }, [audio, cleanup, setConn]);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const next = !prev;
      isMutedRef.current = next;
      audio.setMicEnabled(!next);
      setAudio(next ? "muted" : "idle");
      return next;
    });
  }, [audio, setAudio]);

  /** Signal end-of-answer to Voice Live (paired with the manual "I'm done" control, P13). */
  const commitAnswer = useCallback(() => {
    send({ type: "response.create" });
  }, [send]);

  /** Speak the backend-provided question text verbatim (SPEC Phase 4 voice→turn sub-design).
   *
   * The backend keeps the question pointer authoritative, so voice must SPEAK its text, not let
   * the agent generate its own. We inject the question as an assistant conversation item and ask
   * Voice Live to read it exactly, rather than firing a bare `response.create` (which would make
   * the agent autonomously produce whatever its generic instructions yield). Agent mode rejects
   * overriding `instructions` in `response.create` ("Overriding instructions in response.create is
   * not supported", live-verified), so the verbatim text rides as the assistant item and a bare
   * `response.create` follows — same pattern as the old data-channel transport, now over the WS.
   */
  const speakQuestion = useCallback(
    (text: string): boolean => {
      const ws = wsRef.current;
      if (!text || ws?.readyState !== WebSocket.OPEN) return false;
      send({
        type: "conversation.item.create",
        item: { type: "message", role: "assistant", content: [{ type: "text", text }] },
      });
      send({ type: "response.create" });
      return true;
    },
    [send],
  );

  // Teardown must run ONLY on unmount. `cleanup`'s identity changes every render (it closes over
  // `audio`/`avatarStream`, both fresh objects each render), so depending on `[cleanup]` here made
  // this effect re-run on EVERY render — and each re-run fired the previous render's teardown,
  // calling `avatarStream.disconnect()` → `pc.close()` and `ws.close()` mid-handshake. That closed
  // the PeerConnection while `createOffer()` was pending (which then never resolves) and closed the
  // WS before any mic/offer frame could be sent — the digital human never rendered. Hold the latest
  // cleanup in a ref and invoke it from an unmount-only effect so a re-render can never tear down a
  // live session.
  const cleanupRef = useRef(cleanup);
  cleanupRef.current = cleanup;
  useEffect(() => {
    return () => {
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      cleanupRef.current();
    };
  }, []);

  useEffect(() => {
    if (interviewId) console.debug("[voice] useInterviewVoice bound to interview", interviewId);
  }, [interviewId]);

  return {
    connect,
    disconnect,
    toggleMute,
    commitAnswer,
    speakQuestion,
    isMuted,
    connectionState,
    audioState,
    isAvatarConnected: avatarStream.isConnected,
  };
}
