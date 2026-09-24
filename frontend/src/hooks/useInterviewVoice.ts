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
import type {
  AudioState,
  TranscriptSegment,
  VoiceConnectionState,
} from "../types/voice";

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
  /**
   * LINEAR TURNS — the model gets NO generative turn of its own between questions, so it can only
   * utter text the backend hands it verbatim. The page derives it from the candidate API's
   * `voice_linear_turns` (see InterviewPage), which the backend computes from the same persona
   * field that sets Azure's `create_response` (`voice_live_proxy.py`) — both halves must agree,
   * since either one alone still leaves the model a way to speak.
   *
   * true for EXTERNAL-brain sessions always (Phase 2): the external workflow supplies the brain, the
   * digital human is a pure "mouth". true for BANK sessions by default since v0.38.2.0
   * (`bank_turn_mode: "linear"`): the model turn used to say "Thank you." once per PAUSE, not once
   * per answer — `create_response` is a single boolean, so the acknowledgment turn and the follow-up
   * turn are the same turn, and agent mode rejects overriding `instructions` per `response.create`
   * (see the emitSpeak branch below), so it cannot be made selective by prompt. When true,
   * `commitAnswer` skips its turn-advancing bare `response.create` (in agent mode that makes the
   * Foundry agent autonomously produce an off-script turn) and the page reads follow-ups verbatim.
   *
   * false when an admin opts a bank persona into `bank_turn_mode: "model"`: the model keeps its turn
   * and the PROMPT governs what it says in it — all reaction between questions, at the price of a
   * possible reaction per pause. */
  linearTurns?: boolean;
  /**
   * Silence auto-submit window in ms (admin-controlled per persona; the page derives it from the
   * backend's `voice_auto_submit_seconds`). When > 0, after the candidate finishes an utterance and
   * stays silent this long (any new speech resets the timer) the hook calls `onSilenceAutoCommit`.
   * `undefined` / `null` / `0` ⇒ OFF (the default): silence alone never advances the turn — it
   * advances only on the "I'm done" click. Applies to bank AND external sessions alike.
   */
  silenceAutoCommitMs?: number | null;
  /**
   * Called when the candidate has stopped speaking and stayed silent for `silenceAutoCommitMs`.
   * Lets the page auto-submit the buffered answer so the interview advances hands-free — the
   * "I'm done" button remains as an immediate override. The page wires this to the SAME
   * commit-and-advance path the button uses. Never called while `silenceAutoCommitMs` is unset/0.
   */
  onSilenceAutoCommit?: () => void;
  /**
   * JUDGED sessions (issue #114): a SECOND silence window, armed on every completed utterance and
   * cleared by new speech / commit / disconnect exactly like the auto-submit one (a deliberate
   * parallel copy — review D8). When it elapses the hook calls `onSilenceJudge`; the page then asks
   * the backend judge with `peekDraft()`. `undefined` / `null` / `0` ⇒ never.
   */
  judgeSilenceMs?: number | null;
  onSilenceJudge?: () => void;
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
// Watchdog for the verbatim question read (speakQuestion): if the read hasn't actually STARTED
// (no `response.created` for our injected item) within this window, re-attempt. The queue/cancel/
// flush machinery has several routes that can silently drop a queued question (teardown clears the
// queue, a flush colliding with a fresh server-VAD auto-response whose retry chain breaks, a
// response.done that never arrives) — and the page latches "spoken" as soon as the request is
// queued, so a single silent drop used to mean the question was NEVER read (the "换题没读题" bug).
// 12s comfortably exceeds a normal cancel→done round-trip but still recovers mid-interview; capped
// retries so a genuinely dead session can't loop forever.
const SPEAK_CONFIRM_TIMEOUT_MS = 12_000;
const SPEAK_MAX_ATTEMPTS = 4;
// When the avatar is enabled, the assistant's spoken audio rides the avatar's OWN WebRTC track,
// which only starts flowing once its SDP handshake completes and the first video frames paint.
// A question read fired the instant the WS reaches `connected` plays its opening words into a media
// pipeline that isn't up yet, so they're clipped — the "第一句话前面的词被吃掉" symptom (only on the
// FIRST read, while the avatar is still loading). So we hold the FIRST read until the avatar reports
// connected, or this bound elapses (handshake stalled / avatar disabled server-side despite the flag
// — never leave the candidate in silence). Voice-only sessions don't gate (audio plays over the WS
// AudioContext, ready at `session.updated`).
const FIRST_READ_AVATAR_GATE_MS = 6_000;
// Silence auto-submit (see `silenceAutoCommitMs` / `onSilenceAutoCommit`): server-VAD emits an
// end-of-utterance transcript on ANY mid-thought pause, so a naive "submit on every completed" would
// fragment one answer into several submissions; the grace window (re-armed on every new segment,
// cleared when the candidate speaks again) waits for a real end-of-answer instead. The window used to
// be a hardcoded 3s for external sessions; it fired while candidates were still THINKING, so it is
// now OFF unless an admin enables it on the persona and picks the seconds (owner directive
// 2026-09-23). Sanitized here so a malformed value can never arm a zero-delay timer.
function silenceAutoCommitDelay(ms: number | null | undefined): number | null {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : null;
}

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

function buildWsUrl(
  token: string,
  personaId: string | undefined,
  locale: string,
): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({ token, locale });
  if (personaId) params.set("persona_id", personaId);
  return `${protocol}//${window.location.host}/api/voice-live/ws?${params.toString()}`;
}

export function useInterviewVoice(
  interviewId: string,
  options: UseInterviewVoiceOptions = {},
) {
  const [connectionState, setConnectionState] =
    useState<VoiceConnectionState>("disconnected");
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
  // Set when a PRE-CONNECT Azure `error` frame (e.g. `invalid_model` — the configured Voice Live
  // model isn't supported in this region) rejects the initial connect. Such a session never went
  // live, so retrying is futile: Azure will reject the same model every time. Without this flag the
  // reject sets the promise `resolved`, which `ws.onclose` reads as "was connected" → it enters the
  // 3-attempt reconnect loop, and the terminal "failed after 3 attempts" error OVERWRITES the real
  // Azure message the page already surfaced. Checked in onclose to skip reconnect and preserve the
  // verbatim error.
  const fatalErrorRef = useRef(false);
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
  // The silence-auto-commit timer (see `silenceAutoCommitMs` / silenceAutoCommitDelay
  // and `onSilenceAutoCommit`). Armed/re-armed each time a user utterance segment is buffered,
  // cleared when the candidate resumes speaking, when a commit runs (button or auto), and on
  // teardown. Held in a ref so the message handler can (re)arm it without re-subscribing.
  const silenceAutoCommitTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const clearSilenceAutoCommit = useCallback(() => {
    if (silenceAutoCommitTimerRef.current) {
      clearTimeout(silenceAutoCommitTimerRef.current);
      silenceAutoCommitTimerRef.current = null;
    }
  }, []);
  // Judge silence timer (issue #114) — parallel to the auto-submit one, same arm/clear points.
  const judgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearJudgeTimer = useCallback(() => {
    if (judgeTimerRef.current) {
      clearTimeout(judgeTimerRef.current);
      judgeTimerRef.current = null;
    }
  }, []);
  // Live (partial) user-transcript accumulator, keyed by the Azure conversation item id. The
  // `input_audio_transcription.delta` events carry INCREMENTAL text for the utterance the user is
  // still speaking; we accumulate per item and emit the running text as a non-final segment under
  // a stable id, so the panel shows the words as they're spoken instead of one bubble appearing
  // only after the utterance ends. The `.completed` event finalizes the SAME id (replacing the live
  // bubble in place) and remains the only text that feeds commitAnswer — partials are display-only.
  const userLiveTranscriptRef = useRef<Map<string, string>>(new Map());
  // Same accumulator for the ASSISTANT's `response.audio_transcript.delta`. Each delta frame
  // carries only the incremental fragment, but every onTranscript consumer REPLACES the segment
  // with the same id — so emitting the bare fragment made the interviewer's bubble show only the
  // latest word until `.done` swapped in the full text. Accumulate here and emit the running text.
  const assistantLiveTranscriptRef = useRef<Map<string, string>>(new Map());
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // Forward ref so handleMessage's `response.done` case can flush a queued question without
  // depending on speakQuestion (declared below). Set once speakQuestion is defined.
  const flushPendingSpeakRef = useRef<(() => void) | null>(null);
  // Delivery watchdog for the CURRENT question read (see SPEAK_CONFIRM_TIMEOUT_MS). Confirmation
  // = the assistant transcript of a response matches the watched text (the verbatim read literally
  // speaks the injected text, so its `audio_transcript` IS the question — whereas `response.created`
  // also fires for server-VAD auto-responses and would false-confirm). If the timer fires first,
  // the question was silently dropped somewhere in the queue/cancel/flush machinery — retry from
  // the top. Single latest-wins watch: the backend only moves forward, so a newer question always
  // supersedes the watch on an older one.
  const speakWatchRef = useRef<{
    text: string;
    attempts: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  // Forward ref so the watchdog timer can re-enter speakQuestion (declared below).
  const speakQuestionRef = useRef<((text: string) => boolean) | null>(null);
  // Tracks the response born from OUR read attempt: emitSpeak arms `awaiting`, the next
  // `response.created` claims its id. Any transcript arriving under that id proves the attempt
  // produced a PLAYING response — the strongest delivery confirmation, immune to the agent
  // paraphrasing (or outright ignoring) the injected text. Without this, the text-match check
  // below false-negatived on paraphrases and the watchdog re-read questions that had played
  // (the "读两遍" regression, live-observed twice).
  const awaitingReadResponseRef = useRef(false);
  const readResponseIdRef = useRef<string | null>(null);
  // EXTERNAL (MODEL) mode only: the per-turn read-directive template from `proxy.connected` (the
  // admin-configurable reader prompt + a `{text}` placeholder). Present ⟺ MOUTH mode (external, or
  // linear-turns bank since v0.38.3.1 — see is_mouth_persona in voice_live_proxy.py); emitSpeak
  // fills `{text}` and sends it as `response.instructions` (the only delivery gpt-4o reads verbatim
  // as a dumb "mouth"). Null in bank MODEL-turn (agent) mode → emitSpeak keeps the assistant-item
  // delivery, which only the agent's own turn contract tolerates (live 2026-09-24: under linear
  // turns the agent turned that read into "Thank you." — hence mouth mode for linear bank too).
  const readDirectiveRef = useRef<string | null>(null);
  // A question read that was still UNCONFIRMED when the session tore down (reconnect): re-spoken
  // once the next session reaches `session.updated`. Without this, a drop-during-reconnect is
  // unrecoverable — the page latched "spoken" and never asks again.
  const resumeSpeakTextRef = useRef<string | null>(null);
  // First-read avatar gate (see FIRST_READ_AVATAR_GATE_MS). `firstReadDone` flips true once the
  // opening question has actually been emitted; until then, when the avatar is enabled but not yet
  // painting frames, the read is held in `firstReadGate` (text + a fallback timer) so its opening
  // words aren't clipped by the still-loading avatar media pipeline. Latest-wins: a newer question
  // supersedes a held one. `avatarConnected` mirrors avatarStream.isConnected for the callback.
  const firstReadDoneRef = useRef(false);
  const firstReadGateRef = useRef<{
    text: string;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const avatarConnectedRef = useRef(false);

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
    // Stop the question-read watchdog — its retry would hit a closed/next WS with stale state.
    // Stash the unconfirmed text so the next session's `session.updated` re-speaks it (the page
    // has already latched it as "spoken" and won't ask again).
    if (speakWatchRef.current) {
      clearTimeout(speakWatchRef.current.timer);
      resumeSpeakTextRef.current = speakWatchRef.current.text;
      speakWatchRef.current = null;
    }
    awaitingReadResponseRef.current = false;
    readResponseIdRef.current = null;
    // Cancel a held first-read gate — its timer would fire a read at a closed/next WS. Stash its
    // text (unless the watchdog above already stashed a later one) so the next session re-speaks it,
    // and reset firstReadDone so that next session re-gates the opening read behind its avatar.
    if (firstReadGateRef.current) {
      clearTimeout(firstReadGateRef.current.timer);
      if (!resumeSpeakTextRef.current)
        resumeSpeakTextRef.current = firstReadGateRef.current.text;
      firstReadGateRef.current = null;
    }
    firstReadDoneRef.current = false;
    avatarConnectedRef.current = false;
    // Drop any buffered user transcript — a new session starts a fresh turn; carrying stale
    // segments across a disconnect/reconnect would mis-attribute them to the next answer.
    userSegmentsSinceCommitRef.current = [];
    // Disarm the silence-auto-commit timer — its fire would target a dead session's turn.
    clearSilenceAutoCommit();
    clearJudgeTimer();
    // Drop live partial accumulators too — their item ids belong to the dead Azure session.
    userLiveTranscriptRef.current.clear();
    assistantLiveTranscriptRef.current.clear();
    // Settle a commit still waiting on a transcript that will never arrive now that the WS is
    // going away — otherwise `await commitAnswer()` hangs forever on disconnect/reconnect/unmount.
    settlePendingCommit();
  }, [audio, avatarStream, settlePendingCommit, clearSilenceAutoCommit, clearJudgeTimer]);

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

      const emit = (
        role: "user" | "assistant",
        content: string,
        isFinal: boolean,
        id: string,
      ) =>
        optionsRef.current.onTranscript?.({
          id,
          role,
          content,
          isFinal,
          timestamp: Date.now(),
        });

      // Question-read delivery confirmation. Fast path: transcript prefix matches the watched
      // question (a true verbatim read). Fallback: word-overlap similarity — the agent OFTEN
      // PARAPHRASES the injected text ("Please introduce your relevant experience…" came out as
      // "Could you tell me about your relevant experience…", live-observed), and a prefix-only
      // check then never confirms, so the watchdog "retried" a read that had actually played and
      // the question was spoken twice (the "读两遍" regression). A paraphrase shares most of the
      // question's content words; an unrelated server-VAD auto-response does not — so ≥60% of the
      // question's words appearing in the spoken text confirms delivery without false-confirming
      // on auto-responses.
      const confirmSpeakWatch = (assistantText: string) => {
        const watch = speakWatchRef.current;
        if (!watch || !assistantText) return;
        const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
        const spoken = norm(assistantText);
        const wanted = norm(watch.text);
        const probe = spoken.slice(0, Math.min(24, wanted.length));
        let delivered = Boolean(probe) && wanted.startsWith(probe);
        if (!delivered) {
          const words = (s: string) =>
            s
              .replace(/[^\p{L}\p{N}\s]/gu, " ")
              .split(/\s+/)
              .filter((w) => w.length >= 3);
          const wantedWords = [...new Set(words(wanted))];
          if (wantedWords.length >= 3) {
            const spokenWords = new Set(words(spoken));
            const hit = wantedWords.filter((w) => spokenWords.has(w)).length;
            delivered = hit / wantedWords.length >= 0.6;
          }
        }
        if (delivered) {
          clearTimeout(watch.timer);
          speakWatchRef.current = null;
        }
      };

      switch (msg.type as string | undefined) {
        case "proxy.connected":
          avatarEnabledRef.current = Boolean(msg.avatar_enabled);
          // EXTERNAL mode sends a non-empty read-directive template; bank/agent mode sends "" (or
          // omits it) → null, so emitSpeak keeps the assistant-item delivery there.
          readDirectiveRef.current =
            typeof msg.read_directive === "string" && msg.read_directive
              ? msg.read_directive
              : null;
          console.info(
            "[voice] proxy.connected — mode:",
            msg.mode,
            "avatar_enabled:",
            msg.avatar_enabled,
            "read_directive:",
            readDirectiveRef.current ? "yes" : "no",
          );
          break;

        case "session.updated": {
          const session = msg.session as Record<string, unknown> | undefined;
          const avatarConf = session?.avatar as
            Record<string, unknown> | undefined;
          const iceServers = toRtcIceServers(avatarConf?.ice_servers);

          sessionLiveRef.current = true;
          setConn("connected");
          setAudioState("idle");
          onConnected();

          // A question read left unconfirmed by the PREVIOUS session (dropped during a reconnect):
          // re-speak it on this fresh session. The page latched it as "spoken", so nobody else will.
          if (resumeSpeakTextRef.current) {
            const resumeText = resumeSpeakTextRef.current;
            resumeSpeakTextRef.current = null;
            speakQuestionRef.current?.(resumeText);
          }

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
          if (
            avatarConf &&
            iceServers.length > 0 &&
            !avatarStartedRef.current
          ) {
            avatarStartedRef.current = true;
            console.info(
              "[voice] session.updated has avatar ice_servers → starting handshake",
            );
            void avatarStream
              .connect(iceServers, (clientSdp) => {
                send({ type: "session.avatar.connect", client_sdp: clientSdp });
              })
              .catch((err: unknown) => {
                avatarStartedRef.current = false;
                // Non-fatal: avatar video failed to negotiate, keep the voice-only session alive
                // (AvatarView's fallback orb covers this — see useAvatarStream's frame gate).
                console.warn(
                  "[voice] avatar handshake failed; continuing voice-only",
                  err,
                );
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
          const serverSdp = (msg.server_sdp ?? msg.serverSdp) as
            string | undefined;
          if (serverSdp) avatarStream.handleServerSdp(serverSdp);
          break;
        }

        case "input_audio_buffer.speech_started":
          setAudio("listening");
          // The candidate resumed speaking — they haven't finished the answer yet, so cancel any
          // pending silence-auto-commit (and the judge window). Both re-arm when the next
          // utterance completes.
          clearSilenceAutoCommit();
          clearJudgeTimer();
          break;
        case "input_audio_buffer.speech_stopped":
          setAudio("idle");
          break;
        case "conversation.item.input_audio_transcription.delta": {
          // Live partial of the utterance still being spoken (the "说了多少就展示多少" feature):
          // accumulate per conversation item and re-emit the RUNNING text as a non-final segment
          // under a stable per-item id, so the panel updates one growing bubble in place. Display
          // only — commitAnswer never reads partials; the `.completed` event below finalizes the
          // same bubble and remains the single source of the submitted answer text.
          const itemId = msg.item_id as string | undefined;
          const delta = (msg.delta as string | undefined) ?? "";
          if (itemId && delta) {
            const running =
              (userLiveTranscriptRef.current.get(itemId) ?? "") + delta;
            userLiveTranscriptRef.current.set(itemId, running);
            emit("user", running, false, `user-${itemId}`);
          }
          break;
        }
        case "conversation.item.input_audio_transcription.completed": {
          const transcript = (msg.transcript as string | undefined) ?? "";
          // Finalize under the SAME per-item id the deltas streamed into, so the live bubble is
          // replaced in place (no duplicate). Items that never streamed a delta (delta events off
          // or absent, e.g. plain azure-speech configs) fall back to the counter id as before.
          const itemId = msg.item_id as string | undefined;
          const hadLive = Boolean(
            itemId && userLiveTranscriptRef.current.has(itemId),
          );
          if (itemId) userLiveTranscriptRef.current.delete(itemId);
          // Always feed the transcript panel first, so by the time commitAnswer()'s promise
          // resolves the answer bubble is already on screen ("fully shown before submit").
          if (transcript)
            emit(
              "user",
              transcript,
              true,
              hadLive
                ? `user-${itemId}`
                : `user-${++transcriptIdCounter.current}`,
            );
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
            // Arm/re-arm the silence-auto-commit timer when the admin enabled it on the persona.
            // This segment is an end-of-utterance; if the candidate stays silent for the configured
            // window (no new speech re-arms it, see the speech_started case), auto-submit the
            // buffered answer to advance the interview hands-free. OFF (the default) never arms —
            // the turn advances only on the "I'm done" click, so a thinking pause can't submit.
            const delay = silenceAutoCommitDelay(optionsRef.current.silenceAutoCommitMs);
            if (delay !== null) {
              clearSilenceAutoCommit();
              silenceAutoCommitTimerRef.current = setTimeout(() => {
                silenceAutoCommitTimerRef.current = null;
                optionsRef.current.onSilenceAutoCommit?.();
              }, delay);
            }
            // Judged sessions: the same end-of-utterance arms the judge window (issue #114).
            const judgeDelay = silenceAutoCommitDelay(optionsRef.current.judgeSilenceMs);
            if (judgeDelay !== null) {
              clearJudgeTimer();
              judgeTimerRef.current = setTimeout(() => {
                judgeTimerRef.current = null;
                optionsRef.current.onSilenceJudge?.();
              }, judgeDelay);
            }
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
          // Claim this response for the read attempt that is waiting for one — its transcripts
          // then confirm delivery BY ID (immune to paraphrasing). If this `created` actually
          // belongs to a colliding auto-response, the collision `error` that follows resets the
          // claim and re-queues the read.
          if (awaitingReadResponseRef.current) {
            awaitingReadResponseRef.current = false;
            readResponseIdRef.current =
              ((msg.response as Record<string, unknown> | undefined)?.id as
                string | undefined) ?? null;
          }
          setAudio("speaking");
          break;
        case "response.audio.delta":
          if (msg.delta) audio.playAudio(msg.delta as string);
          break;
        case "response.audio_transcript.delta": {
          // Accumulate — consumers replace same-id segments, so a bare fragment would leave only
          // the newest word on screen. Emit the RUNNING text so the bubble grows as the
          // interviewer speaks.
          const key = `assistant-${msg.response_id}-${msg.item_id}`;
          const delta = (msg.delta as string | undefined) ?? "";
          if (delta) {
            const running =
              (assistantLiveTranscriptRef.current.get(key) ?? "") + delta;
            assistantLiveTranscriptRef.current.set(key, running);
            emit("assistant", running, false, key);
            // A transcript under the response OUR read attempt created = delivery confirmed by
            // id, regardless of wording. Text similarity is the fallback for id-less paths.
            if (
              msg.response_id &&
              msg.response_id === readResponseIdRef.current
            ) {
              const watch = speakWatchRef.current;
              if (watch) {
                clearTimeout(watch.timer);
                speakWatchRef.current = null;
              }
            } else {
              confirmSpeakWatch(running);
            }
          }
          break;
        }
        case "response.audio_transcript.done": {
          const key = `assistant-${msg.response_id}-${msg.item_id}`;
          assistantLiveTranscriptRef.current.delete(key);
          if (msg.transcript) {
            emit("assistant", msg.transcript as string, true, key);
            if (
              msg.response_id &&
              msg.response_id === readResponseIdRef.current
            ) {
              const watch = speakWatchRef.current;
              if (watch) {
                clearTimeout(watch.timer);
                speakWatchRef.current = null;
              }
            } else {
              confirmSpeakWatch(msg.transcript as string);
            }
          }
          break;
        }
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
          const error = new Error(
            (errInfo?.message as string) || "Voice Live error",
          );
          // An in-band `error` on an already-live session is a PER-REQUEST rejection, not a dead
          // session — e.g. our manual `response.create` (speakQuestion / commitAnswer) colliding
          // with a server-VAD auto-response ("conversation already has an active response"). The
          // WS is still open, audio/avatar still stream. Treating it as fatal set conn="error",
          // which made the interview page fall back to text and hide the digital human mid-session
          // (the "数字人有时候不出现" bug). Log and keep the session; only a pre-connect error is
          // fatal (the connect() promise must reject so callers can fall back).
          if (sessionLiveRef.current) {
            console.warn(
              "[voice] non-fatal Voice Live error event (session stays up):",
              error.message,
            );
            // A collision rejection (`conversation_already_has_active_response`) means a response is
            // in fact still active even though our optimistic `activeResponseRef` said otherwise
            // (e.g. a server-VAD auto-response started between our check and send). Mark it active
            // and re-queue the just-attempted question so it retries on the next `response.done`,
            // instead of being silently dropped (the bug: the next question never got spoken).
            const code = errInfo?.code as string | undefined;
            if (code === "conversation_already_has_active_response") {
              activeResponseRef.current = true;
              // Our response.create was REJECTED, so any response id claimed since emitSpeak
              // belongs to the colliding auto-response, not our read — revoke the delivery proof.
              awaitingReadResponseRef.current = false;
              readResponseIdRef.current = null;
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
            console.warn(
              "[voice] error during reconnect attempt (will retry):",
              error.message,
            );
            onFatalError(error);
            break;
          }
          // Pre-connect fatal (never went live): mark it so onclose does NOT reconnect. Retrying an
          // invalid_model / unsupported-region rejection is futile and its terminal generic error
          // would overwrite this verbatim Azure message on the page.
          fatalErrorRef.current = true;
          setConn("error");
          optionsRef.current.onError?.(error);
          onFatalError(error);
          break;
        }
      }
    },
    [
      audio,
      avatarStream,
      send,
      setAudio,
      setConn,
      settlePendingCommit,
      clearSilenceAutoCommit,
      clearJudgeTimer,
    ],
  );

  const connect = useCallback(
    async (locale?: string, isReconnect = false): Promise<void> => {
      const effectiveLocale = locale ?? optionsRef.current.locale ?? "en-US";
      lastLocaleRef.current = effectiveLocale;
      if (!isReconnect) {
        reconnectAttemptRef.current = 0;
        fatalErrorRef.current = false;
      }
      intentionalCloseRef.current = false;
      setConn("connecting");

      // Step 0: unlock autoplay for the assistant-audio AudioContext inside this user gesture,
      // before any async WS event tries to call playAudio() (Chrome autoplay policy).
      await audio.prepareAudioContext();

      // Step 1: resolve the WS auth token (anon session token by default; admin editor Playground
      // passes its own tokenProvider). Not a network broker call anymore — the WS itself is the
      // session.
      const tokenProvider =
        optionsRef.current.tokenProvider ?? (() => clientInternal.getToken());
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
      const wsUrl = buildWsUrl(
        token,
        optionsRef.current.personaId,
        effectiveLocale,
      );
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
            rejectOnce(
              new Error("Voice Live WebSocket closed before connecting"),
            );
            return;
          }
          if (intentionalCloseRef.current) return;
          // A pre-connect fatal error (invalid_model / unsupported region) already surfaced the real
          // Azure message and rejected the connect. The reject set `resolved` (hence wasConnected),
          // but the session never actually went live — do NOT reconnect: retrying is futile and the
          // terminal "failed after 3 attempts" would overwrite the verbatim error on the page.
          if (fatalErrorRef.current) return;
          // Reconnect on unexpected close: 3 attempts, 1s/2s/4s backoff.
          if (reconnectAttemptRef.current < MAX_RECONNECT) {
            reconnectAttemptRef.current++;
            const delay =
              RECONNECT_DELAYS[reconnectAttemptRef.current - 1] ?? 4000;
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
            optionsRef.current.onError?.(
              new Error("Voice connection failed after 3 attempts"),
            );
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

  // Deterministically set the mute state (idempotent), as opposed to toggleMute's flip. Used by the
  // external-brain flow to pause the mic while the interviewer is thinking (awaiting) and unpause
  // when the next turn is ready — the candidate must not "answer" into a turn that isn't open yet.
  const setMuted = useCallback(
    (muted: boolean) => {
      setIsMuted((prev) => {
        if (prev === muted) return prev;
        isMutedRef.current = muted;
        audio.setMicEnabled(!muted);
        setAudio(muted ? "muted" : "idle");
        return muted;
      });
    },
    [audio, setAudio],
  );

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
    // This turn is being committed (via the "I'm done" button OR the silence auto-commit),
    // so disarm the silence timer — it must not fire a second commit for a turn already submitted.
    clearSilenceAutoCommit();
    clearJudgeTimer(); // a submit ends the pause — no judge check may fire for the old answer
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
      // (bank production) Azure has usually auto-created the response already, so an unconditional
      // response.create here just collides (`conversation_already_has_active_response`) — it's the
      // extra rejection this fix removes. On manual-VAD (no auto-response) the nudge is still needed
      // to advance the turn, hence the guard rather than dropping it outright. Under LINEAR TURNS we
      // NEVER nudge: this bare response.create is the model's only remaining way to produce a turn
      // of its own, and it would improvise an off-script follow-up (see `linearTurns` in
      // UseInterviewVoiceOptions); those sessions advance via the backend + speakQuestion verbatim
      // read, so the model must stay silent here.
      //
      // NOT to be confused with the OTHER response.create in this file — the one paired with an
      // assistant item in the emitSpeak branch below. That one is the verbatim READ TRIGGER: it keys
      // off `readDirectiveRef`, never off `linearTurns`, and it MUST keep firing under linear turns
      // or the question is never spoken at all.
      if (!activeResponseRef.current && !optionsRef.current.linearTurns)
        send({ type: "response.create" });
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
      // Same linear-turns guard as the buffered branch: never fire a bare response.create when the
      // model has no turn of its own (it would improvise an off-script follow-up).
      if (!activeResponseRef.current && !optionsRef.current.linearTurns)
        send({ type: "response.create" });
    });
  }, [send, settlePendingCommit, clearSilenceAutoCommit, clearJudgeTimer]);

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
      // The next `response.created` belongs to THIS attempt — its id becomes the delivery proof
      // for the watchdog (see readResponseIdRef).
      awaitingReadResponseRef.current = true;
      readResponseIdRef.current = null;
      // Optimistically mark active so a rapid second speakQuestion (or a commit nudge) defers
      // instead of colliding; the real `response.created` confirms it, `response.done` clears it.
      activeResponseRef.current = true;
      const directive = readDirectiveRef.current;
      if (directive) {
        // EXTERNAL (MODEL) mode: the persona is a dumb "mouth". Carrying the text as an assistant
        // item makes gpt-4o treat it as already-said and reply with an acknowledgment
        // ("Understood.") or fabricate a different question; a user item makes it ANSWER the text
        // as if the candidate asked. Only carrying the text inside `response.instructions` (the
        // admin-configurable reader prompt with `{text}` filled here) makes it read the text
        // verbatim (live-verified on gpt-4o). Function replacement so a `$`-sequence in the text
        // (`$&`, `$1`) is inserted literally, not treated as a replacement pattern.
        send({
          type: "response.create",
          response: { instructions: directive.replace("{text}", () => text) },
        });
      } else {
        // BANK (AGENT) mode: Azure rejects overriding `instructions` in `response.create`
        // ("Overriding instructions in response.create is not supported", live-verified), so the
        // verbatim text rides as an assistant item and a bare `response.create` reads it.
        send({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "text", text }],
          },
        });
        send({ type: "response.create" });
      }
    },
    [send],
  );

  /**
   * Speak a short interviewer aside (a judge nudge) verbatim, right now. Unlike `speakQuestion` it
   * is NOT deduplicated per text (the same "please go on" may legitimately recur) and it is DROPPED
   * when the interviewer is already speaking (never talk over a question read). Returns whether it
   * was emitted. Judge follow-ups/redirects do NOT use this: they arrive as the new current question
   * (header switch) and go through the normal verbatim question read.
   */
  const speakAside = useCallback(
    (text: string): boolean => {
      if (!text.trim() || activeResponseRef.current) return false;
      spokenTextRef.current = null;
      emitSpeak(text);
      return true;
    },
    [emitSpeak],
  );

  /** The candidate's buffered, not-yet-committed transcript (what the judge reads). */
  const peekDraft = useCallback(() => userSegmentsSinceCommitRef.current.join(" ").trim(), []);

  /** Speak the backend-provided question text verbatim (SPEC Phase 4 voice→turn sub-design).
   *
   * The backend keeps the question pointer authoritative, so voice must SPEAK its text, not let
   * the model/agent generate its own. HOW the text is delivered differs by mode (see emitSpeak):
   * BANK (AGENT) mode rides the text as an assistant conversation item + a bare `response.create`
   * (agent mode rejects overriding `instructions` in `response.create` — "Overriding instructions
   * in response.create is not supported", live-verified). EXTERNAL (MODEL) mode instead carries the
   * text inside `response.instructions` (built from the configurable reader prompt): as a dumb
   * "mouth", gpt-4o treats an assistant item as already-said (acknowledges — "Understood." — or
   * fabricates a question) and a user item as the candidate speaking (answers it); only the
   * instructions form makes it read verbatim (live-verified on gpt-4o).
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

      // FIRST-READ AVATAR GATE (the "第一句话前面的词被吃掉" fix): the opening question's audio is
      // clipped when it's read before the avatar's media pipeline is up (assistant TTS rides the
      // avatar's WebRTC track, live only once frames paint). So hold the FIRST read until the avatar
      // is connected — or a short bound elapses (handshake stalled / avatar off despite the flag),
      // so we never leave the candidate in silence. Only gates the first read of a session, and only
      // when the avatar is enabled but not yet painting; every later question reads immediately.
      if (
        !firstReadDoneRef.current &&
        avatarEnabledRef.current &&
        !avatarConnectedRef.current
      ) {
        if (firstReadGateRef.current)
          clearTimeout(firstReadGateRef.current.timer);
        console.info(
          "[voice] holding first question read until avatar is ready",
        );
        firstReadGateRef.current = {
          text,
          timer: setTimeout(() => {
            firstReadGateRef.current = null;
            console.warn(
              "[voice] avatar-ready gate elapsed; reading first question anyway",
            );
            firstReadDoneRef.current = true;
            speakQuestionRef.current?.(text);
          }, FIRST_READ_AVATAR_GATE_MS),
        };
        return true; // held — the page latches "spoken"; the gate guarantees it's read.
      }
      // Past the gate (or not gated): this read is (or supersedes) the first read.
      firstReadDoneRef.current = true;
      if (firstReadGateRef.current) {
        clearTimeout(firstReadGateRef.current.timer);
        firstReadGateRef.current = null;
      }

      // Arm (or re-arm) the delivery watchdog BEFORE attempting: the page latches "spoken" on a
      // true return, so from here on WE own making the read actually happen. Confirmed by the
      // assistant transcript matching (confirmSpeakWatch); on timeout, retry the whole attempt —
      // clearing the per-text idempotency guard, which by then can only be blocking a read that
      // never played (a REAL read would have confirmed and disarmed this watch within the window).
      const prior = speakWatchRef.current;
      if (prior) clearTimeout(prior.timer);
      const attempts = prior?.text === text ? prior.attempts + 1 : 1;
      if (attempts > SPEAK_MAX_ATTEMPTS) {
        // Retries exhausted — stop; the question card remains the fallback.
        speakWatchRef.current = null;
        console.warn(
          "[voice] question read retries exhausted; giving up on voice read",
        );
        return true;
      }
      speakWatchRef.current = {
        text,
        attempts,
        timer: setTimeout(() => {
          // Leave the watch in place — the re-entry below reads it as `prior` to carry the
          // attempt count forward (its timer has already fired; re-clearing it is a no-op).
          console.warn(
            `[voice] question read unconfirmed after ${SPEAK_CONFIRM_TIMEOUT_MS}ms — retrying (attempt ${attempts + 1})`,
          );
          if (spokenTextRef.current === text) spokenTextRef.current = null;
          if (pendingSpeakTextRef.current === text)
            pendingSpeakTextRef.current = null;
          speakQuestionRef.current?.(text);
        }, SPEAK_CONFIRM_TIMEOUT_MS),
      };

      // Watchdog retries (attempts > 1) EMIT DIRECTLY instead of queueing on the active-response
      // flag: a silently-dropped read leaves that flag stale-true forever (its response.done never
      // comes), so the queue path would deadlock — exactly the bug being fixed. If a response IS
      // genuinely active, the direct emit collides and the existing collision handler re-queues it
      // onto the flush path; either way the watch stays armed until a transcript confirms.
      if (activeResponseRef.current && attempts === 1) {
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
  speakQuestionRef.current = speakQuestion;

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
    if (interviewId)
      console.debug(
        "[voice] useInterviewVoice bound to interview",
        interviewId,
      );
  }, [interviewId]);

  // Mirror avatar connectivity into a ref (for speakQuestion's gate) and RELEASE a held first read
  // the moment the avatar starts painting frames — so the opening question is read as soon as its
  // audio can actually be heard, without waiting out the full gate timeout.
  useEffect(() => {
    avatarConnectedRef.current = avatarStream.isConnected;
    if (avatarStream.isConnected && firstReadGateRef.current) {
      const { text, timer } = firstReadGateRef.current;
      clearTimeout(timer);
      firstReadGateRef.current = null;
      console.info("[voice] avatar ready → releasing held first question read");
      speakQuestionRef.current?.(text);
    }
  }, [avatarStream.isConnected]);

  return {
    connect,
    disconnect,
    toggleMute,
    setMuted,
    commitAnswer,
    speakQuestion,
    speakAside,
    peekDraft,
    isMuted,
    connectionState,
    audioState,
    isAvatarConnected: avatarStream.isConnected,
  };
}
