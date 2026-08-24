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
// Upper bound on how long `commitAnswer()` waits for the STT round-trip after "I'm done": the
// user transcript only arrives asynchronously via `conversation.item.input_audio_transcription
// .completed`, on a server round-trip AFTER the commit. If it never lands (WS hiccup, no speech),
// fail closed to "" so the UI never hangs — the caller rejects an empty answer and lets the user
// retry.
const COMMIT_TRANSCRIPT_TIMEOUT_MS = 8_000;

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
  // True once THIS WS session reached `session.updated`. Used to classify Azure `error` events:
  // in-band errors on a live session are per-request rejections (e.g. `response.create` colliding
  // with a server-VAD auto-response) — the session itself is fine; a dead session closes the WS.
  const sessionLiveRef = useRef(false);
  // Mirrors isMuted for handleMessage's mic-frame callback, which is created once per
  // `session.updated` and must read the LATEST mute state without resubscribing.
  const isMutedRef = useRef(false);
  // True while Azure has a response in flight (between `response.created` and `response.done`).
  // Under server-VAD (create_response=True, our production config) Azure AUTO-creates a response
  // the moment the user stops speaking, so at the instant the page wants to speak the next
  // question (or nudge a reply) there is usually ALREADY an active response. Firing our manual
  // `response.create` then collides and Azure rejects it with
  // `conversation_already_has_active_response` — which is exactly why the backend-authoritative
  // next question was never spoken (the "数字人不说话" bug): the agent kept improvising its
  // auto-response and our verbatim question read was dropped. This ref lets speakQuestion cancel
  // the in-flight response and defer the real question until it ends.
  const activeResponseRef = useRef(false);
  // A question text queued by speakQuestion while a response was active. Flushed (as an assistant
  // item + response.create) once `response.done` clears the active response. Latest-wins: a newer
  // question supersedes an older queued one (the backend only ever advances forward).
  const pendingSpeakTextRef = useRef<string | null>(null);
  // The question text of the most recent speakQuestion attempt, kept so a collision rejection
  // (`conversation_already_has_active_response`) can re-queue exactly that text for retry.
  const lastSpokenAttemptRef = useRef<string | null>(null);
  // The question text most recently handed to a real `response.create` for reading. This is the
  // per-text idempotency guard for the verbatim path (the "读三遍" fix): the cancel/queue/flush and
  // collision-retry machinery below has SEVERAL routes into `emitSpeak` (the idle path, the
  // `response.done` flush, the collision re-queue), and every `response.done` fires the flush — so
  // without this guard the same backend question was re-emitted on successive done events and Azure
  // read it 2–3 times as separate responses (each a separate transcript bubble). emitSpeak refuses
  // to re-read a text equal to this ref; a collision rejection clears it so exactly ONE retry of a
  // genuinely-rejected attempt is still allowed.
  const spokenTextRef = useRef<string | null>(null);
  // Holds the in-flight `initMic()` promise for THIS connect. The mic is initialized CONCURRENTLY
  // with the WS open (they're independent — mic frames don't start until `session.updated`), so the
  // few-hundred-ms getUserMedia + worklet load overlaps the multi-second WS/Azure handshake instead
  // of blocking it serially. The `session.updated` handler awaits this before `startRecording`, and
  // `connect()` awaits it after the WS is up so a mic denial still rejects as a MicAccessError.
  const micReadyRef = useRef<Promise<void> | null>(null);
  // Bridges the async STT round-trip back to `commitAnswer()`'s awaiter. When "I'm done" is
  // clicked, `commitAnswer` arms this ref (with a timeout) and returns a Promise; the transcription
  // `.completed` handler pushes the final text, cancels the timer, and resolves it. This is what
  // guarantees a voice answer is submitted with the ACTUAL transcript of THIS turn, not the empty
  // (or stale previous-turn) value that a synchronous read would capture before the round-trip.
  const pendingCommitRef = useRef<{
    resolve: (text: string) => void;
    parts: string[];
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  // Buffers user transcripts that land BETWEEN commits. Under server-VAD (azure_semantic_vad +
  // end-of-utterance detection, our production config) Azure auto-segments speech and emits the
  // `input_audio_transcription.completed` event as soon as the user stops talking — i.e. BEFORE
  // they click "I'm done". Those pre-click transcripts have no armed pending to land in, so without
  // this buffer they reached only the transcript panel and were lost to `commitAnswer()`, which
  // then timed out to "" → the false "我们没有听到你的回答" error even though the answer was on screen.
  // `commitAnswer` drains this first; it's cleared on drain and on teardown so nothing leaks across
  // turns or sessions.
  const userSegmentsSinceCommitRef = useRef<string[]>([]);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // Forward ref so handleMessage's `response.done` case can flush a queued question without
  // depending on speakQuestion (declared below). Set once speakQuestion is defined.
  const flushPendingSpeakRef = useRef<(() => void) | null>(null);

  // Settle any armed commit with whatever transcript has accumulated so far (usually ""). Called
  // from the transcription handler (with the just-arrived text already pushed) and from teardown
  // paths (disconnect / reconnect / unmount) so `await commitAnswer()` can never hang past the WS.
  const settlePendingCommit = useCallback(() => {
    const pending = pendingCommitRef.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingCommitRef.current = null;
    pending.resolve(pending.parts.join(" ").trim());
  }, []);

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
    sessionLiveRef.current = false;
    // Reset turn-response bookkeeping so a reconnect starts idle (no stale "active response" that
    // would make the first speakQuestion needlessly cancel, and no queued question from a dead
    // session leaking into the new one).
    activeResponseRef.current = false;
    pendingSpeakTextRef.current = null;
    lastSpokenAttemptRef.current = null;
    spokenTextRef.current = null;
    // Drop any buffered user transcript — a new session starts a fresh turn; carrying stale
    // segments across a disconnect/reconnect would mis-attribute them to the next answer.
    userSegmentsSinceCommitRef.current = [];
    // Settle a commit still waiting on a transcript that will never arrive now that the WS is
    // going away — otherwise `await commitAnswer()` hangs forever on disconnect/reconnect/unmount.
    settlePendingCommit();
  }, [audio, avatarStream, settlePendingCommit]);

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

          sessionLiveRef.current = true;
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

          // The mic was initialized concurrently with the WS open — make sure it's ready before we
          // start streaming frames (it almost always resolved during the handshake). If it rejected
          // (denied/no hardware), skip recording; the connect()-side await surfaces the error.
          void (micReadyRef.current ?? Promise.resolve())
            .then(() => {
              audio.startRecording((base64Audio) => {
                if (isMutedRef.current) return;
                send({ type: "input_audio_buffer.append", audio: base64Audio });
              });
            })
            .catch(() => undefined);
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
        case "conversation.item.input_audio_transcription.completed": {
          const transcript = (msg.transcript as string | undefined) ?? "";
          // Always feed the transcript panel first, so by the time commitAnswer()'s promise
          // resolves the answer bubble is already on screen ("fully shown before submit").
          if (transcript)
            emit("user", transcript, true, `user-${++transcriptIdCounter.current}`);
          const pending = pendingCommitRef.current;
          if (pending) {
            // "I'm done" was clicked and is waiting: this completed event is (part of) THIS turn's
            // final transcript — record it and resolve the awaiter (manual-VAD / click-before-STT
            // ordering).
            if (transcript) pending.parts.push(transcript);
            settlePendingCommit();
          } else if (transcript) {
            // No commit armed yet — under server-VAD this transcript arrived BEFORE the click.
            // Buffer it so the next commitAnswer() can drain it instead of hanging on a completed
            // event that already fired. (This was the empty-answer bug: the panel showed the bubble
            // but commitAnswer never saw the text.)
            userSegmentsSinceCommitRef.current.push(transcript);
          }
          break;
        }

        case "response.created":
          activeResponseRef.current = true;
          // A response is now genuinely in flight, so any prior speak attempt was ACCEPTED (not
          // rejected). Clear the retry slot so a later, unrelated collision error can't re-queue an
          // already-read question — that clear-then-retry cycle was a duplicate-read path feeding
          // the "读三遍" symptom. Only a collision `error` re-arms a retry.
          lastSpokenAttemptRef.current = null;
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
          activeResponseRef.current = false;
          setAudio("idle");
          optionsRef.current.onResponseDone?.();
          // A question queued while a response was in flight can now be spoken: the conversation is
          // idle, so the assistant-item + response.create won't collide. This is what makes the
          // NEXT question actually get read aloud after the server-VAD auto-response ends.
          flushPendingSpeakRef.current?.();
          break;

        case "error": {
          const errInfo = msg.error as Record<string, unknown> | undefined;
          const error = new Error((errInfo?.message as string) || "Voice Live error");
          // An in-band `error` on an already-live session is a PER-REQUEST rejection, not a dead
          // session — e.g. our manual `response.create` (speakQuestion / commitAnswer) colliding
          // with a server-VAD auto-response ("conversation already has an active response"). The
          // WS is still open, audio/avatar still stream. Treating it as fatal set conn="error",
          // which made the interview page fall back to text and hide the digital human mid-session
          // (the "数字人有时候不出现" bug). Log and keep the session; only a pre-connect error is
          // fatal (the connect() promise must reject so callers can fall back).
          if (sessionLiveRef.current) {
            console.warn("[voice] non-fatal Voice Live error event (session stays up):", error.message);
            // A collision rejection (`conversation_already_has_active_response`) means a response is
            // in fact still active even though our optimistic `activeResponseRef` said otherwise
            // (e.g. a server-VAD auto-response started between our check and send). Mark it active
            // and re-queue the just-attempted question so it retries on the next `response.done`,
            // instead of being silently dropped (the bug: the next question never got spoken).
            const code = errInfo?.code as string | undefined;
            if (code === "conversation_already_has_active_response") {
              activeResponseRef.current = true;
              if (lastSpokenAttemptRef.current) {
                pendingSpeakTextRef.current = lastSpokenAttemptRef.current;
                // This attempt was REJECTED — it was never actually read, so clear the per-text
                // idempotency guard for it. That lets the single re-queued retry through emitSpeak
                // (the guard only blocks re-reading a text that a live response.create accepted).
                if (spokenTextRef.current === lastSpokenAttemptRef.current) {
                  spokenTextRef.current = null;
                }
                lastSpokenAttemptRef.current = null;
              }
            }
            break;
          }
          // During a BACKGROUND reconnect attempt, a pre-connect error is transient: the reconnect
          // loop will retry (and only reports to the page after all attempts fail). Surfacing it
          // here flipped the page to "语音不可用" even when the very next retry succeeded — the
          // "face visible but voice-unavailable notice" contradiction. Reject the attempt (so the
          // loop advances) but don't call onError.
          if (reconnectAttemptRef.current > 0) {
            console.warn("[voice] error during reconnect attempt (will retry):", error.message);
            onFatalError(error);
            break;
          }
          setConn("error");
          optionsRef.current.onError?.(error);
          onFatalError(error);
          break;
        }
      }
    },
    [audio, avatarStream, send, setAudio, setConn, settlePendingCommit],
  );

  const connect = useCallback(
    async (locale?: string, isReconnect = false): Promise<void> => {
      const effectiveLocale = locale ?? optionsRef.current.locale ?? "en-US";
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

      // Step 2: microphone — kicked off CONCURRENTLY with the WS open (Step 3), not awaited here.
      // getUserMedia + worklet load takes a few hundred ms; the WS/Azure handshake takes seconds and
      // doesn't need the mic until `session.updated` fires `startRecording`. Running them in parallel
      // shaves that mic time off the critical path. We stash the promise: the `session.updated`
      // handler awaits it before recording, and the connect() flow awaits it after the WS is up so a
      // mic denial still rejects as a MicAccessError. A `.catch` here keeps it from being an
      // unhandled rejection while it's in flight.
      const micReady = Promise.resolve(audio.initMic());
      micReadyRef.current = micReady;
      micReady.catch(() => undefined);

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
            // Reset the per-session guards so the NEW session's `session.updated` re-fires the
            // avatar handshake — without this the guard stayed true across reconnects and the
            // digital human never came back (orb forever after any WS drop).
            avatarStartedRef.current = false;
            sessionLiveRef.current = false;
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

      // The WS is up. Now surface a mic failure (started in Step 2, likely already resolved): a
      // denial/no-hardware becomes a MicAccessError so the caller can distinguish it from a service
      // error — same contract as when initMic was awaited serially, just no longer on the WS's path.
      try {
        await micReady;
      } catch (err) {
        cleanup();
        setConn("error");
        const error = new MicAccessError(
          err instanceof Error ? err.message : "Microphone access denied",
          { cause: err },
        );
        optionsRef.current.onError?.(error);
        throw error;
      }
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

  /** Signal end-of-answer to Voice Live and RESOLVE with THIS turn's final user transcript (P13).
   *
   * Paired with the manual "I'm done" control. Because STT is asynchronous — the user transcript
   * only arrives later via `conversation.item.input_audio_transcription.completed`, on a server
   * round-trip AFTER the commit — the caller must submit the resolved value, NOT read `segments`
   * synchronously (which would capture the empty/previous-turn state and mis-attribute every
   * answer). Resolves with the joined transcript, or "" if none arrives within
   * `COMMIT_TRANSCRIPT_TIMEOUT_MS` or the connection tears down first (fail-closed, never hangs).
   */
  const commitAnswer = useCallback((): Promise<string> => {
    // Defensively settle any prior armed commit (e.g. a double-click) before arming a fresh one.
    settlePendingCommit();

    // Drain any user transcript(s) that already arrived this turn. Under server-VAD (our production
    // config) the `input_audio_transcription.completed` event fires when the user STOPS speaking —
    // typically BEFORE they click "I'm done" — so the answer is usually already buffered here. If
    // so, resolve immediately with it; no need to wait for (or time out on) a completed event that
    // has already fired. This is the fix for the empty-answer bug.
    const buffered = userSegmentsSinceCommitRef.current;
    if (buffered.length > 0) {
      const text = buffered.join(" ").trim();
      userSegmentsSinceCommitRef.current = [];
      // Nudge the agent's turn along ONLY if nothing is already responding. Under server-VAD
      // (production) Azure has usually auto-created the response already, so an unconditional
      // response.create here just collides (`conversation_already_has_active_response`) — it's the
      // extra rejection this fix removes. On manual-VAD (no auto-response) the nudge is still needed
      // to advance the turn, hence the guard rather than dropping it outright.
      if (!activeResponseRef.current) send({ type: "response.create" });
      return Promise.resolve(text);
    }

    // Nothing buffered yet — the click beat the STT round-trip (fast speaker, or manual-VAD). Arm a
    // pending commit and wait for the next completed event, failing closed to "" after the timeout.
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        const pending = pendingCommitRef.current;
        if (!pending) return;
        pendingCommitRef.current = null;
        resolve(pending.parts.join(" ").trim());
      }, COMMIT_TRANSCRIPT_TIMEOUT_MS);
      pendingCommitRef.current = { resolve, parts: [], timer };
      if (!activeResponseRef.current) send({ type: "response.create" });
    });
  }, [send, settlePendingCommit]);

  // Emit the assistant-item + response.create pair that makes Voice Live read `text` verbatim.
  // Assumes no response is currently active (checked by the callers). Records the attempt so a
  // collision rejection can re-queue it.
  //
  // IDEMPOTENT per text (the "读三遍" fix): if `text` was already handed to a real response.create
  // and not since rejected, we do NOT emit it again — the several routes into emitSpeak (idle
  // speak, the response.done flush, the collision re-queue) would otherwise re-read the same
  // backend question on successive `response.done` events, so Azure spoke it 2–3 times. The flush
  // path clears its own queue entry regardless, so a redundant flush of an already-spoken question
  // becomes a genuine no-op instead of a duplicate read.
  const emitSpeak = useCallback(
    (text: string) => {
      if (spokenTextRef.current === text) return;
      lastSpokenAttemptRef.current = text;
      spokenTextRef.current = text;
      send({
        type: "conversation.item.create",
        item: { type: "message", role: "assistant", content: [{ type: "text", text }] },
      });
      // Optimistically mark active so a rapid second speakQuestion (or a commit nudge) defers
      // instead of colliding; the real `response.created` confirms it, `response.done` clears it.
      activeResponseRef.current = true;
      send({ type: "response.create" });
    },
    [send],
  );

  /** Speak the backend-provided question text verbatim (SPEC Phase 4 voice→turn sub-design).
   *
   * The backend keeps the question pointer authoritative, so voice must SPEAK its text, not let
   * the agent generate its own. We inject the question as an assistant conversation item and ask
   * Voice Live to read it exactly, rather than firing a bare `response.create` (which would make
   * the agent autonomously produce whatever its generic instructions yield). Agent mode rejects
   * overriding `instructions` in `response.create` ("Overriding instructions in response.create is
   * not supported", live-verified), so the verbatim text rides as the assistant item and a bare
   * `response.create` follows — same pattern as the old data-channel transport, now over the WS.
   *
   * CANCEL-THEN-SPEAK (the "数字人不说话" fix): under server-VAD (create_response=True, production)
   * Azure AUTO-creates a response when the user stops speaking, so at the moment the page wants to
   * read the next question there is usually already an active response. Firing our
   * conversation.item.create + response.create then collides — Azure rejects with
   * `conversation_already_has_active_response` and the verbatim question is silently dropped (the
   * agent's own improvised auto-reply plays instead, diverging from the question card, then goes
   * quiet). So when a response is active we CANCEL it and QUEUE the question; the `response.done`
   * that follows the cancel flushes the queued text onto an idle conversation, where it can't
   * collide. Returns true if the request was sent OR queued (the caller latches "spoken" either
   * way — the queue guarantees it's read once the conversation frees up).
   */
  const speakQuestion = useCallback(
    (text: string): boolean => {
      const ws = wsRef.current;
      if (!text || ws?.readyState !== WebSocket.OPEN) return false;
      if (activeResponseRef.current) {
        // A response (usually the server-VAD auto-response) is in flight — cancel it and queue this
        // question to be spoken when the resulting `response.done` lands. Latest-wins.
        pendingSpeakTextRef.current = text;
        send({ type: "response.cancel" });
        return true;
      }
      emitSpeak(text);
      return true;
    },
    [emitSpeak, send],
  );

  // Flush a queued question once the conversation goes idle (`response.done`). Held in a ref so
  // handleMessage's `response.done` case can call it without a declaration-order cycle.
  flushPendingSpeakRef.current = () => {
    const text = pendingSpeakTextRef.current;
    if (!text) return;
    pendingSpeakTextRef.current = null;
    emitSpeak(text);
  };

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
