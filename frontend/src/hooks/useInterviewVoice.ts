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
 * Playground passes its own `tokenProvider` (`getAdminToken` from `api/auth.ts`) + `personaId` so
 * the WS pins the persona under test instead of resolving the default enabled one.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { useAnswerDraft } from "./useAnswerDraft";
import { useFirstReadGate } from "./useFirstReadGate";
import { useQuestionReadWatch } from "./useQuestionReadWatch";
import { useConnectionPolicy } from "./useConnectionPolicy";
import { useSpeakQueue } from "./useSpeakQueue";
import type { RefObject } from "react";
import { _internal as clientInternal } from "../api/client";
import {
  AZURE_DEFAULT_INPUT_SAMPLE_RATE,
  MIC_SAMPLE_RATE,
  encodePcmToBase64,
  useVoiceAudio,
} from "./useVoiceAudio";
import { useAvatarStream } from "./useAvatarStream";
import { voiceMetrics } from "../telemetry/voiceTimeline";
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
  /** Returns the bearer token for the `/voice-live/ws?token=` query param. Defaults to the
   * candidate anon session token (`api/client.ts`). The admin editor Playground should pass
   * `getAdminToken` (`api/auth.ts`) here instead. */
  tokenProvider?: () => string | null;
  /** Pins the WS to a specific persona (editor Playground). Omitted for the candidate interview
   * path, which lets the backend resolve the default enabled persona. */
  personaId?: string;
  /** 6-hex RGB (no `#`) Azure should paint BEHIND the digital human — the photo avatar's own
   * thumbnail backdrop (`AvatarCharacter.backdrop`), so the live video matches the editor preview
   * exactly. Undefined ⇒ Azure's default backdrop (video avatars / unknown character). */
  avatarBackground?: string;
  /**
   * LINEAR TURNS — the model gets NO generative turn of its own between questions, so it can only
   * utter text the backend hands it verbatim. The page derives it from the candidate API's
   * `voice_linear_turns` (see InterviewPage), which the backend computes from the same persona
   * field that sets Azure's `create_response` (`voice_live_proxy.py`) — both halves must agree,
   * since either one alone still leaves the model a way to speak.
   *
   * true for every candidate session since v0.39.0.0: EXTERNAL-brain sessions (the external
   * workflow supplies the brain, the digital human is a pure "mouth") and both BANK modes —
   * `bank_turn_mode: "linear"` (silent between questions) and `"judged"` (a backend judge nudges
   * off-WebSocket, still read verbatim). The retired `"model"` turn said "Thank you." once per
   * PAUSE, not once per answer — `create_response` is a single boolean, so the acknowledgment turn
   * and the follow-up turn are the same turn, and agent mode rejects overriding `instructions` per
   * `response.create` (see the emitSpeak branch below), so it could not be made selective by
   * prompt; it was dropped. When true, `commitAnswer` skips its turn-advancing bare
   * `response.create` (in agent mode that makes the Foundry agent autonomously produce an off-script
   * turn) and the page reads follow-ups verbatim.
   *
   * false only in the editor Playground, where a bank persona keeps a model turn to converse with
   * its synced agent — never on the candidate page. */
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
  /**
   * Fired the moment a candidate utterance is transcribed (end of utterance), BEFORE any silence
   * window. The page uses it to prefetch the judge's verdict (dry run) so the LLM round-trip
   * overlaps the silence window instead of following it (D17).
   */
  onUtteranceComplete?: () => void;
}

/** Options for `connect`. Named rather than positional because there are now three independent flags,
 * and `connect(locale, false, true, true)` is how a caller silently gets one of them wrong. */
export interface ConnectOptions {
  /** A background retry after an unexpected close. Leaves the retry budget accounting alone. */
  isReconnect?: boolean;
  /** Keep the candidate's in-progress answer across the rebuild. Orthogonal to `isReconnect`: a
   * media-mode rebuild wants the budget reset AND the draft kept. */
  keepDraft?: boolean;
  /** This call deliberately REPLACES whatever connect is in flight — the caller has already torn the
   * old socket down. Without it, a concurrent second connect joins the first instead of opening a
   * rival session. Only the two internal re-entrant paths set this. */
  replaceInFlight?: boolean;
}

const MAX_RECONNECT = 3;
const RECONNECT_DELAYS = [1000, 2000, 4000];
/** Ceiling on connect attempts that never produced a live session, counted ACROSS mode switches.
 * `MAX_RECONNECT` is a per-drop budget and a media-mode rebuild resets it on purpose (a policy switch
 * is not a failure, and must not spend the retries a real drop needs). The inverse of that, raised by
 * the v0.40.0.0 review: on a link bad enough to force switch after switch, each switch hands the socket
 * a fresh budget, so a connection that is ALSO failing for unrelated reasons may never reach the
 * terminal "voice unavailable" state the candidate has to see. This counter is the one thing a switch
 * does not reset. Sized above a full per-drop exhaustion (1 + MAX_RECONNECT) plus a couple of
 * legitimate switches, so no honest flow trips it. */
const MAX_CONNECTS_WITHOUT_LIVE = 6;
const CONNECT_TIMEOUT_MS = 30_000;
// Upper bound on how long `commitAnswer()` waits for the STT round-trip after "I'm done": the
// user transcript only arrives asynchronously via `conversation.item.input_audio_transcription
// .completed`, on a server round-trip AFTER the commit. If it never lands (WS hiccup, no speech),
// fail closed to "" so the UI never hangs — the caller rejects an empty answer and lets the user
// retry.
const COMMIT_TRANSCRIPT_TIMEOUT_MS = 8_000;
/**
 * Whether what the interviewer SAID is the text it was asked to read, ignoring case, punctuation
 * and whitespace. The mouth-mode read is server-side TTS of the exact text, so any mismatch here is
 * a delivery regression worth a loud console warning (and a failed live spec) — the 2026-09-28
 * card/voice mismatch was invisible precisely because delivery was confirmed by response id only.
 * Exported for the unit test.
 */
export function speechMatchesText(spoken: string, wanted: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  return norm(spoken) === norm(wanted);
}

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
  avatarBackground?: string,
): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({ token, locale });
  if (personaId) params.set("persona_id", personaId);
  const bg = avatarBackground?.replace(/^#/, "");
  if (bg && /^[0-9a-fA-F]{6}$/.test(bg)) params.set("avatar_bg", bg.toLowerCase());
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
  // Turning the digital human's picture on/off needs a whole new Voice Live session: Azure honours
  // `session.avatar.connect` once per session and has no renegotiate/disconnect event (it answers a
  // second offer with "WebRTC connection is in connected state" — measured 2026-09-30). The media hook
  // decides WHEN, this hook owns HOW, via a ref because `restartForMediaMode` is defined below `connect`.
  const restartForMediaModeRef = useRef<((next: "video" | "audio-only") => void) | null>(null);
  const avatarStream = useAvatarStream(options.videoRef ?? fallbackVideoRef, {
    onModeSwitchRequest: (next) => restartForMediaModeRef.current?.(next),
  });

  const wsRef = useRef<WebSocket | null>(null);
  /** Who may open a session, how often a drop is retried, and when to stop and say the voice is gone.
   * Extracted to `useConnectionPolicy`: the per-drop budget, the attempts-since-live ceiling and the
   * in-flight guard were five refs whose DIFFERENCES carry the behaviour — each was separately a shipped
   * bug, and conflating any two of them reintroduces one. */
  const policy = useConnectionPolicy(MAX_RECONNECT, RECONNECT_DELAYS, MAX_CONNECTS_WITHOUT_LIVE);
  /** Forward reference to the guarded `connect`, so the two internal callers below (the onclose retry
   * and the media-mode rebuild) go through the same bookkeeping instead of around it. Same pattern the
   * rest of this hook uses to break the useCallback dependency cycle. */
  const connectRef = useRef<((locale?: string, opts?: ConnectOptions) => Promise<void>) | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set when a PRE-CONNECT Azure `error` frame (e.g. `invalid_model` — the configured Voice Live
  // model isn't supported in this region) rejects the initial connect. Such a session never went
  // live, so retrying is futile: Azure will reject the same model every time. Without this flag the
  // reject sets the promise `resolved`, which `ws.onclose` reads as "was connected" → it enters the
  // 3-attempt reconnect loop, and the terminal "failed after 3 attempts" error OVERWRITES the real
  // Azure message the page already surfaced. Checked in onclose to skip reconnect and preserve the
  // verbatim error.
  const lastLocaleRef = useRef<string | undefined>(undefined);
  const transcriptIdCounter = useRef(0);
  const avatarEnabledRef = useRef(false);
  /** Whether the connected backend unwraps binary mic frames (from `proxy.connected`). */
  const binaryAudioRef = useRef(false);
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
  /** Which question text may be sent to be read, which is queued behind an active response, and which
   * was last attempted. Extracted to `useSpeakQueue`: the per-text idempotency guard (the read-three-
   * times fix), the single retry a collision rejection is allowed, and latest-wins queueing were three
   * refs cross-referencing each other from five places. */
  const speakQueue = useSpeakQueue();
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
  /** The candidate's in-progress answer and everything that decides what "I'm done" submits: the
   * buffered segments, the streaming partials, an armed commit's promise, and the two end-of-utterance
   * timers. Extracted to `useAnswerDraft` because the keepDraft rule that caused a deterministic draft
   * loss in v0.40.0.0 was spread across two functions that could not see each other; it has one owner
   * and its own tests now. The handle is referentially stable, so it is safe in dependency arrays. */
  const draft = useAnswerDraft();
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
  /** Makes sure a question handed to the voice session actually got read, and retries when it did not.
   * Extracted to `useQuestionReadWatch`: delivery is confirmed by response id (immune to the agent
   * paraphrasing) with a text-similarity fallback, and getting that fallback wrong shipped the
   * "read twice" regression twice. The handle is referentially stable. */
  const readWatch = useQuestionReadWatch(SPEAK_CONFIRM_TIMEOUT_MS, SPEAK_MAX_ATTEMPTS);
  // Forward ref so the watchdog's retry can re-enter speakQuestion (declared below). Stays here rather
  // than in the watch module: the module decides WHEN to retry, the hook owns the read path itself.
  const speakQuestionRef = useRef<((text: string) => boolean) | null>(null);
  // MOUTH-mode marker from `proxy.connected`: the backend sends a non-empty read-directive template
  // (the admin-configurable reader prompt + a `{text}` placeholder) for every MOUTH session
  // (external, or linear/judged bank since v0.38.3.1 — see is_mouth_persona in
  // voice_live_proxy.py), "" / absent for the agent-driven Playground. Present ⟺ emitSpeak reads via
  // `pre_generated_assistant_message` (server-side TTS of the exact text, no model inference — see
  // emitSpeak). The directive TEXT itself is no longer sent per turn: filling it into
  // `response.instructions` was still a model turn ("read this verbatim") and gpt-5-mini drifted on
  // it mid-interview — on 2026-09-28 it paraphrased Q4 and fabricated Q7 outright while the card
  // showed the bank question. Null → agent mode → emitSpeak keeps the assistant-item delivery,
  // which only the agent's own turn contract tolerates (live 2026-09-24: under linear turns the
  // agent turned that read into "Thank you." — hence mouth mode for linear bank too).
  const readDirectiveRef = useRef<string | null>(null);
  // A question read that was still UNCONFIRMED when the session tore down (reconnect): re-spoken
  // once the next session reaches `session.updated`. Without this, a drop-during-reconnect is
  // unrecoverable — the page latched "spoken" and never asks again.
  const resumeSpeakTextRef = useRef<string | null>(null);
  /** Holds the FIRST question read until the digital human can actually be heard — the interviewer's
   * audio rides the avatar's WebRTC track, so reading before that track flows clipped the opening
   * words. Extracted to `useFirstReadGate`: the rule about which of its four pieces of state wins was
   * spread across `speakQuestion`, the readiness effect and the turn reset. */
  const firstReadGate = useFirstReadGate(FIRST_READ_AVATAR_GATE_MS);

  // Settle any armed commit with whatever transcript has accumulated so far (usually ""). Called from
  // the transcription handler (with the just-arrived text already recorded) and from teardown paths
  // (disconnect / reconnect / unmount) so `await commitAnswer()` can never hang past the WS. Kept as a
  // named local because several call sites read better this way than as `draft.settlePending()`.
  const settlePendingCommit = useCallback(() => {
    draft.settlePending();
  }, [draft]);

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

  /** Tell the backend a question starts: it keeps this marker (Azure never sees it) and records
   * the candidate's microphone for that question into its own file (recording_service). */
  const markQuestion = useCallback(
    (questionIndex: number) => send({ type: "x.recording.question", question_index: questionIndex }),
    [send],
  );

  /** Send raw mic PCM as a BINARY frame; the backend wraps it into `input_audio_buffer.append`.
   * Only used when the backend advertised `binary_audio` — see `binaryAudioRef`. */
  const sendPcm = useCallback((pcm: ArrayBuffer) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(pcm);
  }, []);

  // Everything a NEW Azure session must start without: the previous session's turn/read
  // bookkeeping, its watchdog timers, and its half-finished transcript state. Shared by `cleanup()`
  // (connect-timeout, mic failure, explicit disconnect) AND the automatic-reconnect branch of
  // `connect()`'s onclose — which used to reset only the avatar guards, so after an ordinary
  // network drop `activeResponseRef` could survive into the new session (every later speakQuestion
  // then cancelled-and-queued behind a phantom response: silence), the unconfirmed question was
  // never stashed for re-speaking (the resume path was dead on the most common trigger), and a
  // stale read watchdog could fire against a session that had not reached `session.updated`
  // (TODOS P2 from the v0.39.2.3 adversarial review). Mic/avatar continuity is deliberately NOT
  // here — each caller decides that.
  const resetTurnState = useCallback((opts?: { keepDraft?: boolean }) => {
    // Reset turn-response bookkeeping so a reconnect starts idle (no stale "active response" that
    // would make the first speakQuestion needlessly cancel, and no queued question from a dead
    // session leaking into the new one).
    activeResponseRef.current = false;
    speakQueue.reset();
    // Stop the question-read watchdog — its retry would hit a closed/next WS with stale state.
    // Stash the unconfirmed text so the next session's `session.updated` re-speaks it (the page
    // has already latched it as "spoken" and won't ask again).
    // A read still unconfirmed when the session tears down is stashed for the next one to re-speak:
    // the page latched it as spoken and will never ask again.
    const unconfirmedRead = readWatch.reset();
    if (unconfirmedRead) resumeSpeakTextRef.current = unconfirmedRead;
    // Cancel a held first-read gate — its timer would fire a read at a closed/next WS. Stash its
    // text (unless the watchdog above already stashed a later one) so the next session re-speaks it,
    // and reset firstReadDone so that next session re-gates the opening read behind its avatar.
    // A held read is stashed for the next session unless the watchdog above already stashed a later
    // one: the page latched it as spoken, so dropping it would lose the question outright.
    const heldFirstRead = firstReadGate.reset();
    if (heldFirstRead && !resumeSpeakTextRef.current) resumeSpeakTextRef.current = heldFirstRead;
    // The answer side of a turn reset — dropping or keeping the draft, folding partials under
    // keepDraft, disarming both silence timers, and settling an armed commit — belongs to
    // `useAnswerDraft` and lives there with its own tests.
    draft.reset(opts);
    // The INTERVIEWER's live transcript is not part of the candidate's answer, so it stays here: its
    // item ids belong to the dead Azure session either way.
    assistantLiveTranscriptRef.current.clear();
  }, [draft, firstReadGate, readWatch, speakQueue]);

  const cleanup = useCallback(() => {
    voiceMetrics.flush();
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    avatarStream.disconnect();
    audio.cleanupMic();
    avatarStartedRef.current = false;
    sessionLiveRef.current = false;
    resetTurnState();
  }, [audio, avatarStream, resetTurnState]);

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
      // Confirm a read by text similarity, for paths that carry no response id. The rule itself lives
      // in `readWasDelivered` (useQuestionReadWatch) where it is unit-tested — a prefix-only version
      // false-negatived on paraphrases and re-read questions that had played.
      const confirmSpeakWatch = (assistantText: string) => {
        readWatch.confirmByText(assistantText);
      };

      switch (msg.type as string | undefined) {
        case "proxy.connected":
          avatarEnabledRef.current = Boolean(msg.avatar_enabled);
          voiceMetrics.setContext({
            avatar: Boolean(msg.avatar_enabled),
            linear_turns: Boolean(msg.linear_turns),
            audio_path: msg.avatar_enabled ? "webrtc" : "ws",
          });
          voiceMetrics.setup("proxy_connected");
          // Uplink framing (perf review P0-1): with this flag the mic goes up as raw binary PCM
          // and the backend does the base64. Absent means an older backend whose relay would
          // reject a binary frame, so the page keeps the base64-JSON path.
          binaryAudioRef.current = Boolean(msg.binary_audio);
          // Mic-rate drift guard. The backend declares `input_audio_sampling_rate` on the session and
          // Azure decodes our raw PCM16 at exactly that rate, so if the two sides disagree the
          // interviewer hears a pitch- and speed-shifted candidate and every transcript is garbage —
          // with NO error frame from Azure. The candidate would be scored on nonsense and never know.
          //
          // A MISSING field is not "no information": it means a backend from before this contract
          // existed, and Azure's own default for pcm16 is 24 kHz. So treat absent as 24000 rather than
          // skipping the check — otherwise the guard goes quiet in exactly the version-skew case it
          // exists for (new page, rolled-back backend).
          {
            const declaredRate =
              typeof msg.input_audio_sampling_rate === "number"
                ? msg.input_audio_sampling_rate
                : AZURE_DEFAULT_INPUT_SAMPLE_RATE;
            if (declaredRate !== MIC_SAMPLE_RATE) {
              const detail =
                `mic rate mismatch: the server decodes audio at ${String(declaredRate)}Hz` +
                (typeof msg.input_audio_sampling_rate === "number" ? "" : " (field absent — assuming Azure's default)") +
                ` but this page records at ${MIC_SAMPLE_RATE}Hz`;
              console.error(
                `[voice] MIC RATE MISMATCH: ${detail}. Transcription would be garbage, so voice is being ` +
                  `refused. Keep useVoiceAudio.MIC_SAMPLE_RATE and Settings.voice_live_input_sampling_rate in sync.`,
              );
              // Refuse the session rather than record an un-transcribable interview. This repo's rule is
              // that the page must never silently degrade — surfacing it drops the candidate to the text
              // channel with the real reason, which is recoverable; a garbled voice interview is not.
              // Treated exactly like a pre-connect Azure fatal: mark it so `onclose` does not reconnect
              // (a retry would hit the same mismatch) and reject the in-flight connect, otherwise the
              // `session.updated` frame right behind this one flips the state back to "connected".
              const mismatch = new Error(detail);
              policy.latchFatal();
              // Azure is not the one at fault here, so it will never close this socket — WE have to,
              // or the `session.updated` frame right behind this one resolves the connect and flips
              // the state back to "connected" while the mic keeps streaming at the wrong rate.
              // Marking the close intentional keeps `onclose` from treating it as a drop worth retrying.
              policy.markIntentionalClose();
              const doomed = wsRef.current;
              wsRef.current = null;
              if (doomed) {
                doomed.onmessage = null;
                doomed.onerror = null;
                doomed.onclose = null;
                doomed.close();
              }
              audio.cleanupMic();
              setConn("error");
              optionsRef.current.onError?.(mismatch);
              onFatalError(mismatch);
              return;
            }
          }
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
          voiceMetrics.setup("session_updated");
          // A session that reached `session.updated` works, whatever it took to get here.
          policy.noteLive();
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
              audio.startRecording((pcm) => {
                if (isMutedRef.current) return;
                // Binary when the backend said it can unwrap it, base64 JSON otherwise. The
                // fallback is not dead code: frontend and backend are separate container apps
                // that roll out independently, so a page can genuinely meet a backend that
                // predates the binary path. Guessing wrong means a silently dead microphone.
                if (binaryAudioRef.current) sendPcm(pcm);
                else send({ type: "input_audio_buffer.append", audio: encodePcmToBase64(pcm) });
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
          voiceMetrics.turn("speech_started");
          setAudio("listening");
          // The candidate resumed speaking — they haven't finished the answer yet, so cancel any
          // pending silence-auto-commit (and the judge window). Both re-arm when the next
          // utterance completes.
          draft.clearSilenceAutoCommit();
          draft.clearJudge();
          break;
        case "input_audio_buffer.speech_stopped":
          voiceMetrics.turn("speech_stopped");
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
            const running = draft.notePartial(itemId, delta);
            emit("user", running, false, `user-${itemId}`);
          }
          break;
        }
        case "conversation.item.input_audio_transcription.completed": {
          voiceMetrics.turn("transcript");
          const transcript = (msg.transcript as string | undefined) ?? "";
          // Finalize under the SAME per-item id the deltas streamed into, so the live bubble is
          // replaced in place (no duplicate). Items that never streamed a delta (delta events off
          // or absent, e.g. plain azure-speech configs) fall back to the counter id as before.
          const itemId = msg.item_id as string | undefined;
          const hadLive = Boolean(itemId && draft.hasPartial(itemId));
          if (itemId) draft.dropPartial(itemId);
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
          // "I'm done" was clicked and is waiting: this completed event is (part of) THIS turn's final
          // transcript — record it and resolve the awaiter (manual-VAD / click-before-STT ordering).
          if (draft.landTranscript(transcript)) {
            settlePendingCommit();
          } else if (transcript) {
            // No commit armed yet — under server-VAD this transcript arrived BEFORE the click.
            // Buffer it so the next commitAnswer() can drain it instead of hanging on a completed
            // event that already fired. (This was the empty-answer bug: the panel showed the bubble
            // but commitAnswer never saw the text.)
            draft.pushSegment(transcript);
            // Arm/re-arm the silence-auto-commit timer when the admin enabled it on the persona.
            // This segment is an end-of-utterance; if the candidate stays silent for the configured
            // window (no new speech re-arms it, see the speech_started case), auto-submit the
            // buffered answer to advance the interview hands-free. OFF (the default) never arms —
            // the turn advances only on the "I'm done" click, so a thinking pause can't submit.
            const delay = silenceAutoCommitDelay(optionsRef.current.silenceAutoCommitMs);
            if (delay !== null) {
              draft.armSilenceAutoCommit(() => optionsRef.current.onSilenceAutoCommit?.(), delay);
            }
            // Judged sessions: the same end-of-utterance arms the judge window (issue #114) and,
            // first, lets the page prefetch the verdict so the LLM runs DURING the window (D17).
            const judgeDelay = silenceAutoCommitDelay(optionsRef.current.judgeSilenceMs);
            if (judgeDelay !== null) optionsRef.current.onUtteranceComplete?.();
            if (judgeDelay !== null) {
              draft.armJudge(() => optionsRef.current.onSilenceJudge?.(), judgeDelay);
            }
          }
          break;
        }

        case "response.created":
          voiceMetrics.turn("response_created");
          activeResponseRef.current = true;
          // A response is now genuinely in flight, so any prior speak attempt was ACCEPTED (not
          // rejected). Clear the retry slot so a later, unrelated collision error can't re-queue an
          // already-read question — that clear-then-retry cycle was a duplicate-read path feeding
          // the "读三遍" symptom. Only a collision `error` re-arms a retry.
          speakQueue.noteAccepted();
          // Claim this response for the read attempt that is waiting for one — its transcripts
          // then confirm delivery BY ID (immune to paraphrasing). If this `created` actually
          // belongs to a colliding auto-response, the collision `error` that follows resets the
          // claim and re-queues the read.
          readWatch.claimResponse(
            ((msg.response as Record<string, unknown> | undefined)?.id as string | undefined) ?? null,
          );
          setAudio("speaking");
          break;
        case "response.audio.delta":
          voiceMetrics.turn("first_audio_delta");
          if (msg.delta) audio.playAudio(msg.delta as string);
          break;
        case "response.audio.done":
          // The jitter buffer counts a dry queue as an underrun, and a finished sentence empties the
          // queue exactly like a stalled network does. This is the only signal that tells the two
          // apart, so without it the metric would fire once per utterance.
          audio.endPlaybackStream();
          break;
        case "response.audio_transcript.delta": {
          // Accumulate — consumers replace same-id segments, so a bare fragment would leave only
          // the newest word on screen. Emit the RUNNING text so the bubble grows as the
          // interviewer speaks.
          const key = `assistant-${msg.response_id}-${msg.item_id}`;
          const delta = (msg.delta as string | undefined) ?? "";
          if (delta) {
            voiceMetrics.turn("first_text");
            const running =
              (assistantLiveTranscriptRef.current.get(key) ?? "") + delta;
            assistantLiveTranscriptRef.current.set(key, running);
            emit("assistant", running, false, key);
            // A transcript under the response OUR read attempt created = delivery confirmed by
            // id, regardless of wording. Text similarity is the fallback for id-less paths.
            if (readWatch.ownsResponse(msg.response_id as string | undefined)) {
              readWatch.confirm();
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
            if (readWatch.ownsResponse(msg.response_id as string | undefined)) {
              readWatch.confirm();
              // Verbatim guard (MOUTH mode only): OUR read response finished — its transcript must
              // BE the text we handed to emitSpeak, since the read is server-side TTS of exactly that
              // text. Delivery is confirmed by id (above) so a drift never retried; this makes it
              // visible instead of silent (see speechMatchesText). Agent mode is exempt: there the
              // agent's own turn contract may paraphrase the assistant item and that is tolerated.
              const wanted = speakQueue.lastEmitted();
              if (
                readDirectiveRef.current &&
                wanted &&
                !speechMatchesText(msg.transcript as string, wanted)
              ) {
                console.warn(
                  "[voice] question read deviated from the question text",
                  { wanted, spoken: msg.transcript },
                );
              }
            } else {
              confirmSpeakWatch(msg.transcript as string);
            }
          }
          break;
        }
        case "response.done":
          voiceMetrics.turn("response_done");
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
              // The watch stays armed: it still owns the retry.
              readWatch.releaseClaim();
              // The attempt was REJECTED, so it was never read: re-queue exactly that text and clear
              // its idempotency guard, which is what lets the single retry through.
              speakQueue.requeueRejectedAttempt();
            } else if (readWatch.isExpectingResponse()) {
              // Any OTHER rejection of OUR read attempt (no `response.created` has claimed it yet —
              // e.g. an api-version that lacks `pre_generated_assistant_message`): nothing of ours
              // is in flight, so release the optimistic in-flight marks emitSpeak set. Otherwise
              // `activeResponseRef` stays true with no `response.done` ever coming, and the next
              // speakQuestion cancels-and-queues behind a phantom response (silent interview). The
              // read watchdog still owns the retry.
              readWatch.releaseClaim();
              activeResponseRef.current = false;
            }
            break;
          }
          // During a BACKGROUND reconnect attempt, a pre-connect error is transient: the reconnect
          // loop will retry (and only reports to the page after all attempts fail). Surfacing it
          // here flipped the page to "语音不可用" even when the very next retry succeeded — the
          // "face visible but voice-unavailable notice" contradiction. Reject the attempt (so the
          // loop advances) but don't call onError.
          if (policy.isRetrying()) {
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
          policy.latchFatal();
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
      sendPcm,
      setAudio,
      setConn,
      settlePendingCommit,
      draft,
      readWatch,
      speakQueue,
      policy,
    ],
  );

  /** Opens a Voice Live session. Not called directly from outside — `connect` below wraps this with the
   * re-entrancy guard, and every caller goes through that. */
  const openSession = useCallback(
    async (locale?: string, opts: ConnectOptions = {}): Promise<void> => {
      const { isReconnect = false, keepDraft = false } = opts;
      const effectiveLocale = locale ?? optionsRef.current.locale ?? "en-US";
      lastLocaleRef.current = effectiveLocale;
      // Counted before the branch below, because that branch is exactly what this survives: the
      // `!isReconnect` reset is what a media-mode rebuild uses to get its retries back.
      if (!policy.countAttempt()) {
        const error = new Error(
          `Voice connection failed after ${MAX_CONNECTS_WITHOUT_LIVE} attempts without a live session`,
        );
        // Latch it so a later `onclose` does not start the retry loop again on the way out.
        policy.latchFatal();
        setConn("error");
        optionsRef.current.onError?.(error);
        throw error;
      }
      if (!isReconnect) {
        policy.resetDropBudget();
        // A manual (re)connect starts from a clean slate: whatever the previous session left
        // (a draft, a phantom in-flight mark, a pending commit) belongs to a turn that is over.
        // Idempotent after cleanup(); protects the path where no cleanup ran.
        //
        // `keepDraft` exists because those two things are NOT the same decision. A media-mode rebuild
        // needs the budget reset (it is not a failure) but must NOT lose what the candidate has already
        // said — and it fires precisely when the network is bad, i.e. mid-answer. Without this the
        // draft `restartForMediaMode` carefully preserved was wiped three lines later, every time.
        resetTurnState(keepDraft ? { keepDraft: true } : undefined);
      }
      policy.clearIntentionalClose();
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
        optionsRef.current.avatarBackground,
      );
      console.info(
        "[voice] opening WS proxy; persona:",
        optionsRef.current.personaId ?? "(default)",
        "locale:",
        effectiveLocale,
      );

      await new Promise<void>((resolve, reject) => {
        voiceMetrics.startSetup();
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        ws.onopen = () => voiceMetrics.setup("ws_open");
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
          if (policy.wasIntentionalClose()) return;
          // A pre-connect fatal error (invalid_model / unsupported region) already surfaced the real
          // Azure message and rejected the connect. The reject set `resolved` (hence wasConnected),
          // but the session never actually went live — do NOT reconnect: retrying is futile and the
          // terminal "failed after 3 attempts" would overwrite the verbatim error on the page.
          if (policy.isFatal()) return;
          // Reconnect on unexpected close: a bounded number of attempts with backoff. Null means the
          // per-drop budget is spent, and the terminal branch below runs instead.
          const delay = policy.takeRetryDelay();
          if (delay !== null) {
            setConn("reconnecting");
            avatarStream.disconnect();
            // Release the mic fully: connect() re-acquires it (initMic — permission is already
            // granted, so no prompt; it runs in parallel with the WS handshake). Only stopping the
            // recorder left the old MediaStream + AudioContext orphaned on every reconnect (tracks
            // never .stop()ped → the browser kept the hardware captured) — adversarial review.
            audio.cleanupMic();
            // Reset the per-session guards so the NEW session's `session.updated` re-fires the
            // avatar handshake — without this the guard stayed true across reconnects and the
            // digital human never came back (orb forever after any WS drop).
            avatarStartedRef.current = false;
            sessionLiveRef.current = false;
            // …and the turn/read bookkeeping (see resetTurnState): drops the dead session's
            // in-flight marks and watchdog, stashes an unconfirmed question read so the new
            // session's `session.updated` re-speaks it. The answer transcribed so far is KEPT —
            // the candidate is still on the same question.
            resetTurnState({ keepDraft: true });
            reconnectTimerRef.current = setTimeout(() => {
              // replaceInFlight: this retry IS the supersession — `wsRef` was nulled above, and the
              // attempt that just died is the one being replaced.
              void connectRef.current
                ?.(lastLocaleRef.current, { isReconnect: true, replaceInFlight: true })
                .catch(() => undefined);
            }, delay);
          } else {
            // Terminal: release everything (mic, avatar, turn/read bookkeeping) exactly like an
            // explicit disconnect — otherwise the mic stayed captured and a stale draft rode into
            // whatever the candidate connected to next (adversarial review).
            cleanup();
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
    [audio, avatarStream, cleanup, handleMessage, policy, resetTurnState, setConn],
  );

  /**
   * Open a voice session, or join the attempt already running.
   *
   * The re-entrancy guard exists because the two affordances that reach here are deliberately never
   * disabled — the mic-permission dialog's Retry and the top-bar voice pill, whose comment says it must
   * stay retryable. Nothing adversarial is needed to double-enter: two clicks on a button designed to
   * stay clickable will do it, and the window is wide, because a connect does real async work (unlocking
   * autoplay, fetching a token, starting the mic) before it ever assigns `wsRef`. Checking for an
   * existing socket would therefore miss the race entirely, which is why the marker is set here,
   * synchronously, before the first await.
   *
   * What went wrong without it: each attempt overwrote `wsRef` and `micReadyRef`, orphaning the earlier
   * socket with its handlers still armed. The orphan could schedule its own reconnect, and if it still
   * received `session.updated` it ran the connected-state and avatar-handshake side effects through the
   * same shared refs while `send()` pointed at the other socket — two logically distinct sessions live
   * against one ref set, plus a second avatar offer against Azure's rate limit.
   *
   * Joining rather than superseding is the right answer for a double-click: the candidate wants voice,
   * not two sessions, and superseding would spend an extra avatar request for nothing. Callers that
   * genuinely need a NEW session say `replaceInFlight` and have already torn the old socket down.
   */
  const connect = useCallback(
    async (locale?: string, opts: ConnectOptions = {}): Promise<void> => {
      const joined = policy.inFlight(Boolean(opts.replaceInFlight));
      if (joined) {
        console.info("[voice] connect already in flight — joining it instead of opening a second session");
        return joined;
      }
      // `track` both records this attempt and frees the slot when it settles, so the two cannot drift
      // apart — and it frees the slot only if this attempt still owns it, since a replaceInFlight caller
      // may have started a newer one meanwhile.
      await policy.track(openSession(locale, opts));
    },
    [openSession, policy],
  );
  connectRef.current = connect;

  const disconnect = useCallback(async () => {
    policy.markIntentionalClose();
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
  }, [audio, cleanup, policy, setConn]);

  /**
   * Rebuild the Voice Live session because the avatar media mode changed (weak-network degrade, or the
   * candidate's manual toggle). Deliberately NOT the failure path:
   *   - it resets the WS reconnect budget (`connect(..., false)`), so two mode switches can't use up the
   *     three retries a real drop will need;
   *   - `keepDraft` preserves whatever the candidate has already said, and `resetTurnState` stashes the
   *     current question so the new session re-reads it instead of losing it.
   */
  const restartForMediaMode = useCallback(
    (next: "video" | "audio-only") => {
      console.info(`[voice] rebuilding the session for media mode ${next}`);
      policy.markIntentionalClose(); // our own close must not trip the auto-reconnect path
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        // Detach BEFORE closing: `onclose` fires on a later tick, by which time connect() below has
        // already cleared the intentional-close mark, so the old socket's handler would sail past the
        // intentional-close guard and fire a SECOND connect (observed live — two "opening WS proxy"
        // lines per switch, two avatar sessions, straight into Azure's avatar rate limit).
        wsRef.current.onclose = null;
        wsRef.current.onmessage = null;
        wsRef.current.onerror = null;
        wsRef.current.close();
        wsRef.current = null;
      }
      audio.cleanupMic();
      avatarStartedRef.current = false;
      sessionLiveRef.current = false;
      setConn("reconnecting");
      // Leaving isReconnect false resets the reconnect budget (this is a policy switch, not a failure);
      // keepDraft stops that same reset from wiping the candidate's in-progress answer, because connect()
      // runs the keepDraft-preserving reset itself and this function must NOT reset separately.
      // replaceInFlight says the supersession is deliberate: the old socket is already detached and
      // closed above, so this must open a new session rather than join an attempt in flight.
      void connectRef.current
        ?.(lastLocaleRef.current, { keepDraft: true, replaceInFlight: true })
        .catch((err: unknown) => {
          console.warn("[voice] media-mode session rebuild failed", err);
        });
    },
    // No resetTurnState here on purpose: connect() runs the keepDraft-preserving reset itself, so
    // listing it would claim a dependency this callback does not have. `connect` is reached through
    // `connectRef` rather than captured, which is what keeps this out of a dependency cycle with it.
    [audio, policy, setConn],
  );
  restartForMediaModeRef.current = restartForMediaMode;

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
    draft.clearSilenceAutoCommit();
    draft.clearJudge(); // a submit ends the pause — no judge check may fire for the old answer
    // Defensively settle any prior armed commit (e.g. a double-click) before arming a fresh one.
    settlePendingCommit();

    // Drain any user transcript(s) that already arrived this turn. Under server-VAD (our production
    // config) the `input_audio_transcription.completed` event fires when the user STOPS speaking —
    // typically BEFORE they click "I'm done" — so the answer is usually already buffered here. If
    // so, resolve immediately with it; no need to wait for (or time out on) a completed event that
    // has already fired. This is the fix for the empty-answer bug.
    const buffered = draft.drain();
    if (buffered) {
      const text = buffered;
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
      draft.armPending(resolve, COMMIT_TRANSCRIPT_TIMEOUT_MS);
      // Same linear-turns guard as the buffered branch: never fire a bare response.create when the
      // model has no turn of its own (it would improvise an off-script follow-up).
      if (!activeResponseRef.current && !optionsRef.current.linearTurns)
        send({ type: "response.create" });
    });
  }, [draft, send, settlePendingCommit]);

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
      // Refuses a text already handed to a live response — several routes reach here and every
      // `response.done` fires the flush, so without this the same question was read two or three times.
      if (!speakQueue.claimEmit(text)) return;
      voiceMetrics.turn("read_request");
      // The next `response.created` belongs to THIS attempt — its id becomes the delivery proof.
      readWatch.expectResponse();
      // Optimistically mark active so a rapid second speakQuestion (or a commit nudge) defers
      // instead of colliding; the real `response.created` confirms it, `response.done` clears it.
      activeResponseRef.current = true;
      if (readDirectiveRef.current) {
        // MOUTH (MODEL) mode: the persona is a dumb "mouth", so the read must not be a model turn at
        // all. Voice Live's `pre_generated_assistant_message` makes the server synthesize EXACTLY
        // this text ("bypassing model inference for text generation" — API ref, present in
        // 2026-01-01-preview) and adds it to the conversation as the assistant's message. Every
        // model-mediated delivery drifted: an assistant item is treated as already-said (acknowledged
        // or replaced by a fabricated question), a user item is answered, and `response.instructions`
        // ("say ONLY this, verbatim") — reliable on gpt-4o — still let gpt-5-mini continue the
        // interview on its own by Q4/Q7 of a 9-question bank (2026-09-28: the card showed the bank
        // question while the avatar asked a different one). TTS of the given text cannot deviate.
        send({
          type: "response.create",
          response: {
            pre_generated_assistant_message: {
              type: "message",
              role: "assistant",
              content: [{ type: "text", text }],
            },
          },
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
    [readWatch, send, speakQueue],
  );

  /**
   * Speak a short interviewer aside (a judge nudge) verbatim, right now. Unlike `speakQuestion` it
   * is NOT deduplicated per text (the same "please go on" may legitimately recur) and it is DROPPED
   * when the interviewer is already speaking (never talk over a question read). Returns whether it
   * was emitted. Since 2026-09-28 a nudge is the judge's ONLY utterance (follow-ups and redirects
   * are retired), and like every mouth-mode read it goes out as pre-generated TTS of the exact text.
   */
  const speakAside = useCallback(
    (text: string): boolean => {
      if (!text.trim() || activeResponseRef.current) return false;
      speakQueue.clearGuard();
      emitSpeak(text);
      return true;
    },
    [emitSpeak, speakQueue],
  );

  /** The candidate's buffered, not-yet-committed transcript (what the judge reads). */
  const peekDraft = useCallback(() => draft.peek(), [draft]);

  /** Speak the backend-provided question text verbatim (SPEC Phase 4 voice→turn sub-design).
   *
   * The backend keeps the question pointer authoritative, so voice must SPEAK its text, not let
   * the model/agent generate its own. HOW the text is delivered differs by mode (see emitSpeak):
   * MOUTH (MODEL) mode — external and linear/judged bank — sends `response.create` with a
   * `pre_generated_assistant_message`: server-side TTS of the exact text, no model inference, so the
   * spoken question can never differ from the card (the earlier `response.instructions` read was
   * still a model turn and gpt-5-mini drifted on it mid-interview). AGENT mode (editor Playground)
   * rides the text as an assistant conversation item + a bare `response.create` (agent mode rejects
   * overriding `instructions` in `response.create` — "Overriding instructions in response.create is
   * not supported", live-verified).
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
      // avatar's WebRTC track, live only once that track is flowing). So hold the FIRST read until the
      // media path is ready — painted frames, or a live audio track in an audio-only session — or a
      // short bound elapses (handshake stalled / avatar off despite the flag),
      // so we never leave the candidate in silence. Only gates the first read of a session, and only
      // when the avatar is enabled but not yet painting; every later question reads immediately.
      if (firstReadGate.shouldHold(avatarEnabledRef.current)) {
        console.info("[voice] holding first question read until avatar is ready");
        firstReadGate.hold(text, (held) => speakQuestionRef.current?.(held));
        return true; // held — the page latches "spoken"; the gate guarantees it's read.
      }
      // Past the gate (or not gated): this read is (or supersedes) the first read.
      firstReadGate.markRead();

      // Arm (or re-arm) the delivery watchdog BEFORE attempting: the page latches "spoken" on a
      // true return, so from here on WE own making the read actually happen. Confirmed by the
      // assistant transcript matching (confirmSpeakWatch); on timeout, retry the whole attempt —
      // clearing the per-text idempotency guard, which by then can only be blocking a read that
      // never played (a REAL read would have confirmed and disarmed this watch within the window).
      const attempts = readWatch.arm(text, (unread, nextAttempt) => {
        console.warn(
          `[voice] question read unconfirmed after ${SPEAK_CONFIRM_TIMEOUT_MS}ms — retrying (attempt ${nextAttempt})`,
        );
        // The retry must get PAST the per-text idempotency guard: by now that guard can only be
        // blocking a read that never played, since a real one would have confirmed and disarmed.
        speakQueue.allowRetry(unread);
        speakQuestionRef.current?.(unread);
      });
      if (attempts === null) {
        // Retries exhausted — stop; the question card remains the fallback. Also drop the optimistic
        // in-flight marks the failed attempts left behind: every attempt set `activeResponseRef`
        // before sending and nothing ever cleared it (no `response.created`, no `response.done`).
        // Left true, EVERY later speakQuestion would see a phantom active response, send
        // `response.cancel` and queue on a `response.done` that never comes — the rest of the
        // interview silent with no user-facing signal (adversarial review, v0.39.2.3). The watch
        // clears its own claim; `activeResponseRef` is the hook's and is cleared here.
        activeResponseRef.current = false;
        console.warn("[voice] question read retries exhausted; giving up on voice read");
        return true;
      }

      // Watchdog retries (attempts > 1) EMIT DIRECTLY instead of queueing on the active-response
      // flag: a silently-dropped read leaves that flag stale-true forever (its response.done never
      // comes), so the queue path would deadlock — exactly the bug being fixed. If a response IS
      // genuinely active, the direct emit collides and the existing collision handler re-queues it
      // onto the flush path; either way the watch stays armed until a transcript confirms.
      if (activeResponseRef.current && attempts === 1) {
        // A response (usually the server-VAD auto-response) is in flight — cancel it and queue this
        // question to be spoken when the resulting `response.done` lands. Latest-wins.
        speakQueue.queue(text);
        send({ type: "response.cancel" });
        return true;
      }
      emitSpeak(text);
      return true;
    },
    [emitSpeak, firstReadGate, readWatch, send, speakQueue],
  );
  speakQuestionRef.current = speakQuestion;

  // Flush a queued question once the conversation goes idle (`response.done`). Held in a ref so
  // handleMessage's `response.done` case can call it without a declaration-order cycle.
  flushPendingSpeakRef.current = () => {
    const text = speakQueue.takeQueued();
    if (!text) return;
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
      policy.markIntentionalClose();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      cleanupRef.current();
    };
    // Deliberately empty: this teardown must run ONLY on unmount. `policy` is left out rather than
    // added even though its handle is referentially stable, because relying on that here is the exact
    // shape that once tore the avatar connection down mid-handshake — an effect that re-ran because it
    // depended on something rebuilt per render. The omission is the safer statement of intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Every voice timing event carries the interview it belongs to ("playground" for the editor).
  useEffect(() => {
    voiceMetrics.setContext({ interview_id: interviewId || "playground" });
  }, [interviewId]);

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
    const release = firstReadGate.noteAvatarReady(avatarStream.isMediaReady);
    if (release) {
      console.info("[voice] avatar ready → releasing held first question read");
      speakQuestionRef.current?.(release);
    }
  }, [avatarStream.isMediaReady, firstReadGate]);

  return {
    markQuestion,
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
    /** `"audio-only"` once the picture has been given up to protect the voice on a weak link. */
    mediaMode: avatarStream.mediaMode,
    /** The candidate's manual override of the picture (`auto` = follow the link's health). */
    videoPreference: avatarStream.videoPreference,
    setVideoPreference: avatarStream.setVideoPreference,
    /** False while Azure's avatar rate-limit cooldown blocks turning the picture back on. */
    canEnableVideo: avatarStream.canEnableVideo,
    /** Epoch ms when that cooldown lifts (null when there is nothing to wait for). */
    videoEnableAtMs: avatarStream.videoEnableAtMs,
  };
}
