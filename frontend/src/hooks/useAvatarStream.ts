/**
 * Avatar video/audio WebRTC stream (SPEC F9 avatar-video WS-proxy path).
 *
 * The avatar's video+audio ride a SEPARATE `recvonly` `RTCPeerConnection` from the main Voice Live
 * WS (which carries mic PCM up and assistant audio/transcripts down). This connection's SDP is
 * exchanged over that same WS though: the offer is sent as a base64-encoded JSON blob in a client
 * `session.avatar.connect` event, and Azure's answer comes back the same way in a server
 * `session.avatar.connecting` event (`server_sdp`). ICE servers for this connection are handed to
 * us out-of-band by the caller (extracted from `session.updated`'s `session.avatar.ice_servers`).
 *
 * Ported from the reference Avatar layer's `use-avatar-stream.ts`. Its getStats telemetry was trimmed
 * on the first pass (the core ask was a working handshake) and is now back for a concrete reason —
 * see WEAK-NETWORK ADAPTATION below.
 *
 * `isConnected` flips true only once the video track delivers real frames (`videoWidth>0`), not
 * merely once the RTCPeerConnection finishes negotiating — matches the existing frame-gate pattern
 * used by the direct-WebRTC `useInterviewVoice` so `AvatarView`'s fallback orb never shows a blank
 * connected-but-frameless box.
 *
 * MEDIA-LAYER SELF-HEAL (the "数字人掉成球且回不来" fix): the avatar media path is INDEPENDENT of
 * the main Voice Live WS, so `useInterviewVoice`'s WS-close reconnect does NOT cover an avatar-only
 * media drop (TURN relay churn, NAT rebind, Azure ending the avatar track between turns). Before,
 * `oniceconnectionstatechange` only logged and `track.onended` flipped straight to the orb with no
 * path back — one media blip meant orb for the rest of the session. Now this hook recovers on its
 * own: a transient ICE `disconnected` is given a short grace window (no orb flash if it self-heals);
 * a `failed` state or an ended track — or a grace window that expires still-down — triggers a bounded
 * re-handshake (rebuild the PC, re-send `session.avatar.connect`, await a fresh `server_sdp`) reusing
 * the last ICE servers + WS-send callback, up to MAX_RECOVERY_ATTEMPTS with backoff. The recovery
 * budget resets once real frames paint again, so a later independent drop gets a fresh set of tries.
 *
 * WEAK-NETWORK ADAPTATION (`docs/avatar-weaknet-probe.md` §3.8/§3.9, measured on real Azure): the
 * avatar's video and the interviewer's VOICE ride the SAME RTP transport, so on a lossy link the video
 * starves its own audio. At 3% loss the 1080p avatar decoded ZERO frames for 30+ s while still pulling
 * ~1 Mbps, and 31% of the interviewer's speech was invented by packet-loss concealment — the candidate
 * cannot hear the question. Re-offering the same connection with the video m-line `a=inactive` cut that
 * to 2.5% (and RTT 876 → 534 ms, because our own video was self-inflicting queuing delay). So this hook
 * samples `getStats()` and, when the picture is costing us the voice, gives up the picture and keeps the
 * voice — then takes it back when the link recovers, with hysteresis so it can't strobe. Lowering the
 * bitrate is deliberately NOT the lever: Azure already adapts on its own, and a mid-session
 * `session.update` of `avatar.video.bitrate` is accepted-then-ignored (§3.5). The policy itself lives in
 * `avatarHealth.ts` as pure functions; this file only owns the PeerConnection side effects.
 *
 * HOW the picture is switched, and why it isn't cheap: `session.avatar.connect` is honoured exactly
 * ONCE per Voice Live session, and the API has no disconnect/renegotiate event (the full client event
 * list is session.update, session.avatar.connect, input_audio_buffer.*, conversation.item.*,
 * response.create/cancel). Re-offering on a live session is refused with `error: "WebRTC connection is
 * in connected state"` — measured 2026-09-30. So this hook cannot flip the picture by itself: it tears
 * the media down and asks its consumer (`useInterviewVoice`) to rebuild the whole Voice Live session
 * via `onModeSwitchRequest`, and the mode it wants survives into the next `connect()`. That costs a
 * ~5 s reconnect, which is why the hysteresis in `avatarHealth.ts` is deliberately slow and capped.
 * The self-heal path above still re-offers directly, because there the old connection is already
 * broken — Azure accepts a fresh offer then.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import {
  HEALTH_THRESHOLDS,
  type DecisionState,
  type MediaMode,
  type VideoPreference,
  initialDecisionState,
  isVideoStalled,
  readHealth,
  reduceHealth,
  resetStreaks,
  type HealthSnapshot,
} from "./avatarHealth";
import {
  AvatarHandshakeMetrics,
  candidateType,
  selectedPair,
  voiceMetrics,
  watchAudibleOnsets,
} from "../telemetry/voiceTimeline";
import { MediaQualityWindow } from "../telemetry/mediaQuality";
import { flushForUnload } from "../telemetry/appInsights";

/** All candidates gathered within this window before falling back to sending whatever we have. */
const ICE_GATHERING_TIMEOUT_MS = 8000;
/** Settle window after the first usable (relay/srflx) candidate: give gathering a beat to add a
 * couple more candidates to the SDP, then send the offer — instead of stalling to the 8s cap on
 * networks that never signal gathering "complete" (VPN/mDNS interfaces). Azure's avatar path runs
 * over its TURN relay, so one relay candidate is enough to connect. */
const ICE_SETTLE_AFTER_CANDIDATE_MS = 300;
/** A connection that has ICE but paints no frame within this window is reported as `no_frame`. */
const NO_FRAME_LIMIT_MS = 20_000;
/** Azure's SDP answer (`session.avatar.connecting`) must arrive within this window. */
const SERVER_SDP_TIMEOUT_MS = 15000;
/** An ICE `disconnected` often self-heals (brief network blip). Wait this long before treating it
 * as a real drop and rebuilding — so a momentary blip never flashes the fallback orb. `failed` is
 * terminal and skips this grace (it won't recover without a full renegotiation). */
const DISCONNECTED_GRACE_MS = 3000;
/** Cap re-handshake attempts per drop so a persistently-broken media path can't loop forever (the
 * orb is the honest fallback once we give up). Budget resets when real frames paint again. */
const MAX_RECOVERY_ATTEMPTS = 3;
/** Backoff before each re-handshake attempt (index = attempt-1). Treated as a FLOOR, not the whole
 * story: the rate-limit ledger below can push an attempt later, because an offer Azure refuses is an
 * attempt spent for nothing. */
const RECOVERY_BACKOFF_MS = [500, 1500, 3000];
/** Azure rate-limits avatar SESSION CREATION, and every path that offers `session.avatar.connect`
 * spends from the same allowance: a self-heal re-handshake, a deliberate media-mode switch, and a
 * brand-new session all look identical to Azure. One shared ledger, consulted by every path, is the
 * only way they stop defeating each other — two independent budgets is what spent a self-heal attempt
 * on a request Azure would never honour.
 *
 * THE WINDOW IS THE DOCUMENTED ONE, and it used to be wrong. Azure publishes **2 new connections per
 * minute** for real-time text-to-speech avatar on S0, and says in the same place that "avatars used in
 * Voice Live follow the quotas and limits described in Real-time text-to-speech avatar" — so the
 * avatar rides the Speech quota, NOT Voice Live's much larger 30/minute. See
 * `docs/avatar-rate-limit.md`.
 *
 * This was 20_000, inferred from "a third request inside roughly 20 s was refused" (measured
 * 2026-09-30). That inference was invalid: three requests landing close together says nothing about
 * the window's length. At 2 per 20 s the ledger allowed SIX per minute and happily sent requests Azure
 * was certain to refuse — which is exactly what the owner hit in production on 2026-10-03, closing a
 * session and reconnecting after ~25 s.
 *
 * THE WINDOW IS NOW MEASURED, NOT JUST DOCUMENTED, and the ALLOWANCE turned out to be 3 rather than
 * the published 2. Five sessions were opened in separate browser contexts (separate ledgers, so our own
 * throttle could not interfere) and Azure's raw frames recorded:
 *
 *   #1  4681ms  offer -> connecting -> switch_to_speaking   accepted
 *   #2 11105ms  offer -> connecting -> switch_to_speaking   accepted
 *   #3 17665ms  offer -> connecting -> switch_to_speaking   accepted   <- the published 2 says no
 *   #4 24180ms  error  rate_limit_exceeded  "Retry after 40.0s."
 *   #5 31083ms  error  rate_limit_exceeded  "Retry after 34.0s."
 *
 * Both refusals point at the SAME absolute moment — 24180+40000 = 64180, 31083+34000 = 65083 — and #1
 * was at 4681, so #1 + 60_000 = 64681 sits within half a second of each. That is two independent
 * confirmations that the window is 60 s AND that `Retry after` means "until the oldest request ages
 * out". It also means three requests were in flight before one was refused.
 *
 * So the allowance here is the MEASURED 3, not the documented 2. Being conservative is not free: with
 * 2, a third connect is held by our own ledger for up to 60 s — and 60 s of silence is, to a candidate,
 * indistinguishable from failure — while Azure would have accepted it immediately. The published figure
 * is kept in `docs/avatar-rate-limit.md` as the conservative number, with this measurement beside it.
 *
 * Earlier readings fit too, given an uncounted connection: the 2026-09-30 note said "a third request
 * inside roughly 20 s was refused", which at an allowance of 3 means a fourth, i.e. the session before
 * it also counted. */
const AVATAR_REQUEST_WINDOW_MS = 60_000;
const AVATAR_REQUESTS_PER_WINDOW = 3;

export interface AvatarStreamOptions {
  /** Called when the media policy (or the candidate) wants the picture turned on/off. The consumer must
   * rebuild the Voice Live session — see HOW the picture is switched in the module header. The hook has
   * already torn its media down by the time this fires, and remembers the mode it wants. */
  onModeSwitchRequest?: (next: MediaMode) => void;
}

export function useAvatarStream(
  videoRef: RefObject<HTMLVideoElement | null>,
  options: AvatarStreamOptions = {},
) {
  // Held in a ref, never a dep: the options object is a fresh literal on every render of the consumer,
  // so depending on it would re-create every callback below each render.
  const onModeSwitchRequestRef = useRef(options.onModeSwitchRequest);
  onModeSwitchRequestRef.current = options.onModeSwitchRequest;
  const pcRef = useRef<RTCPeerConnection | null>(null);
  // Timing of each peer connection's handshake (`voice.avatar`), keyed by the connection so a
  // superseded one's late events land on its own record.
  const handshakesRef = useRef(new WeakMap<RTCPeerConnection, AvatarHandshakeMetrics>());
  const stopAudibleRef = useRef<(() => void) | null>(null);
  // `voice.media` quality windows over the current connection's stats (telemetry/mediaQuality.ts).
  const mediaWindowRef = useRef<MediaQualityWindow | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const sdpResolverRef = useRef<((sdp: string) => void) | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  // The avatar's video MediaStream, stashed so it can be (re)attached to the <video> element even if
  // `ontrack` fires while the element is momentarily unmounted (e.g. the editor Playground mounts the
  // <video> only while a voice session is live, racing the async handshake). Without this, a track
  // that arrives before the element exists is silently lost and the face never renders — the exact
  // failure AI-Coach avoids by always mounting its <video>. We instead re-attach defensively.
  const pendingStreamRef = useRef<MediaStream | null>(null);

  // --- self-heal state -----------------------------------------------------------------------
  // Last handshake inputs, stashed so a media-only drop can re-handshake without waiting for a new
  // `session.updated` (the WS is usually still open through an avatar media blip).
  const iceServersRef = useRef<RTCIceServer[]>([]);
  const sendOfferRef = useRef<((clientSdp: string) => Promise<void> | void) | null>(null);
  const recoveryAttemptsRef = useRef(0);
  /** Timestamps of avatar offers we have sent, pruned to AVATAR_REQUEST_WINDOW_MS. Lives on the hook,
   * not in a session, so it survives the full session rebuild a mode switch performs — which is the
   * whole point: Azure counts those requests across our session boundaries. */
  const avatarRequestsRef = useRef<number[]>([]);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveringRef = useRef(false);
  // Bumped by disconnect()/connect() so a stale in-flight recovery (or a dead PC's late event) can
  // detect it's been superseded and bail instead of clobbering the current connection.
  const genRef = useRef(0);

  // --- weak-network adaptation state ---------------------------------------------------------
  // What the NEXT handshake should offer for the video m-line: recvonly (want the face) vs inactive
  // (audio-only). Read by runHandshake, flipped by switchMediaMode / setVideoPreference.
  const wantVideoRef = useRef(true);
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** The 250 ms frame poller started inside `attachStream`. Before mode switching existed this only
   * had to survive until the final disconnect, so it was left to stop itself (its own `settled` flag
   * or a 15 s cap). Now every downgrade/restore runs teardown → attachStream again, so a switch
   * inside that 15 s window would leave the OLD poller running against the same <video> element
   * alongside the new one. Hold the handle so teardown can kill it outright. */
  const framePollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const snapshotRef = useRef<HealthSnapshot | null>(null);
  /** Sampling windows since this PC started, used only to throttle the audio-only diagnostic below. */
  const windowCountRef = useRef(0);
  const decisionRef = useRef<DecisionState>(initialDecisionState());
  /** Mirrors `decisionRef.current.mode` for render. */
  const [mediaMode, setMediaMode] = useState<MediaMode>("video");
  const [videoPreference, setVideoPreferenceState] = useState<VideoPreference>("auto");
  /** The avatar's AUDIO track is live. Only promoted to "ready" in audio-only mode — in video mode the
   * first-read gate must still wait for painted frames, or the opening words get clipped. */
  const [audioTrackLive, setAudioTrackLive] = useState(false);
  /** When the current avatar session was created. Azure rate-limits avatar requests, so switching back
   * INTO video is held off until enough time has passed (see VIDEO_SWITCH_MIN_INTERVAL_MS). */
  const avatarConnectedAtRef = useRef<number | null>(null);
  const [canEnableVideo, setCanEnableVideo] = useState(true);

  /** How long until one more avatar request would be inside Azure's allowance. 0 = go now. */
  const avatarRequestWaitMs = useCallback(() => {
    const now = Date.now();
    const recent = avatarRequestsRef.current.filter((t) => now - t < AVATAR_REQUEST_WINDOW_MS);
    avatarRequestsRef.current = recent;
    if (recent.length < AVATAR_REQUESTS_PER_WINDOW) return 0;
    // The request that has to age out is the one that would leave exactly (allowance - 1) behind. Written
    // generally rather than as `recent[0]` because a consumer-driven connect can push us over the
    // allowance without asking us first, and the wait must still be correct when it does.
    const blocking = recent[recent.length - AVATAR_REQUESTS_PER_WINDOW];
    return Math.max(0, AVATAR_REQUEST_WINDOW_MS - (now - blocking));
  }, []);

  /** Record that an avatar offer just went out. Called at the send, not at the decision, so a request
   * that never left (a handshake that failed earlier) does not consume the allowance. */
  const noteAvatarRequest = useCallback(() => {
    const now = Date.now();
    avatarRequestsRef.current = [
      ...avatarRequestsRef.current.filter((t) => now - t < AVATAR_REQUEST_WINDOW_MS),
      now,
    ];
  }, []);

  const stopSampling = useCallback(() => {
    if (statsTimerRef.current) {
      clearInterval(statsTimerRef.current);
      statsTimerRef.current = null;
    }
    snapshotRef.current = null;
  }, []);

  /** The current mode lives in three places that must never disagree: the policy state, the flag
   * `runHandshake` reads, and the React state the UI renders. Write them together, once. */
  const applyMode = useCallback((next: MediaMode) => {
    decisionRef.current = { ...decisionRef.current, mode: next };
    wantVideoRef.current = next === "video";
    setMediaMode(next);
  }, []);

  const stopFramePolling = useCallback(() => {
    if (framePollTimerRef.current) {
      clearInterval(framePollTimerRef.current);
      framePollTimerRef.current = null;
    }
  }, []);

  const clearTimers = useCallback(() => {
    if (recoveryTimerRef.current) {
      clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }
    stopSampling();
    stopFramePolling();
  }, [stopFramePolling, stopSampling]);

  /** Tear the avatar media down: close the PC, drop the elements' streams, stop sampling, and supersede
   * any in-flight recovery. Shared by the public `disconnect()` and the media-mode switch. Nulling
   * `sendOfferRef` is what stops `attemptRecovery` from fighting the teardown. */
  const teardownMedia = useCallback(() => {
    genRef.current++;
    clearTimers();
    recoveringRef.current = false;
    recoveryAttemptsRef.current = 0;
    sendOfferRef.current = null;
    iceServersRef.current = [];
    sdpResolverRef.current = null;
    pendingStreamRef.current = null;
    stopAudibleRef.current?.();
    stopAudibleRef.current = null;
    mediaWindowRef.current?.finish();
    mediaWindowRef.current = null;
    if (pcRef.current) {
      void handshakesRef.current.get(pcRef.current)?.finish("closed");
      pcRef.current.close();
      pcRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    if (audioElRef.current) {
      audioElRef.current.srcObject = null;
      audioElRef.current.remove();
      audioElRef.current = null;
    }
    setIsConnected(false);
    setAudioTrackLive(false);
  }, [clearTimers, videoRef]);

  /** Attach a video MediaStream to the <video> element + flip `isConnected` once it paints real
   * frames. Safe to call repeatedly; a no-op if the element isn't mounted yet (the stream stays in
   * `pendingStreamRef` and the ref-watching effect below re-attaches it once it mounts). */
  const attachStream = useCallback(
    (stream: MediaStream) => {
      pendingStreamRef.current = stream;
      const videoEl = videoRef.current;
      if (!videoEl) {
        console.info("[avatar-stream] video track arrived before <video> mounted; will re-attach");
        return;
      }
      videoEl.srcObject = stream;
      // Flip isConnected (which hides AvatarView's fallback orb) ONCE the video is actually producing
      // real frames — a track that connects but never paints (0x0) must leave the orb visible. The
      // FIRST decoded frame can lag `loadedmetadata`/`play()` by a beat, so a single check at those
      // moments can read 0x0 and wrongly stick on the orb (the "已连接 but still a ball" symptom).
      // Watch every event that signals a painted frame AND poll briefly, flipping true on the first
      // non-zero reading and then stopping — so the face appears the instant frames arrive.
      let settled = false;
      // Any poller from a previous attach (a mode switch re-attaches) must go before this one starts.
      stopFramePolling();
      const stopPolling = () => {
        if (framePollTimerRef.current) {
          clearInterval(framePollTimerRef.current);
          framePollTimerRef.current = null;
        }
      };
      const reflectDimensions = () => {
        const hasFrames = videoEl.videoWidth > 0 && videoEl.videoHeight > 0;
        if (hasFrames && !settled) {
          settled = true;
          stopPolling();
          const handshake = pcRef.current && handshakesRef.current.get(pcRef.current);
          if (handshake && !handshake.finished) {
            handshake.mark("first_frame");
            void handshake.finish("frame");
          }
          voiceMetrics.setup("first_video_frame");
          voiceMetrics.setup("media_ready");
          console.info(`[avatar-stream] video HAS frames: ${videoEl.videoWidth}x${videoEl.videoHeight}`);
          // Real frames are painting again → this drop (if any) is fully recovered; hand the next
          // independent drop a fresh recovery budget.
          recoveryAttemptsRef.current = 0;
          recoveringRef.current = false;
          setIsConnected(true);
        }
      };
      videoEl.onloadedmetadata = reflectDimensions;
      videoEl.onloadeddata = reflectDimensions;
      videoEl.onresize = reflectDimensions;
      videoEl.onplaying = reflectDimensions;
      videoEl.ontimeupdate = reflectDimensions;
      // Poll as a backstop for browsers/streams that don't fire a dimension event on the first frame.
      framePollTimerRef.current = setInterval(reflectDimensions, 250);
      setTimeout(stopPolling, 15_000);
      videoEl
        .play()
        .then(reflectDimensions)
        .catch((err: unknown) => {
          console.info("[avatar-stream] video play() rejected; retrying muted", err);
          // Autoplay can reject; the element is already muted, but re-assert and retry once.
          videoEl.muted = true;
          void videoEl.play().then(reflectDimensions).catch(() => undefined);
        });
    },
    [stopFramePolling, videoRef],
  );

  // Forward declaration so wirePc (used by both connect and recovery) can call the recovery routine.
  const attemptRecoveryRef = useRef<((reason: string) => void) | null>(null);
  // Same indirection for the mode switch: the stats sampler (wired inside wirePc) has to be able to
  // call it, but the switch itself is built on wirePc.
  const switchMediaModeRef = useRef<((next: MediaMode, reason: string) => void) | null>(null);

  /** Poll `getStats()` on a live PC and act on the media-health verdict (see `avatarHealth.ts`). */
  /** Put the policy back in the mode the MEDIA is actually in, after the actuator refused a switch.
   *
   * `reduceHealth` commits the transition the moment it decides one, but `switchMediaMode` holds a veto
   * (Azure's avatar cooldown and request allowance). Without this, a vetoed restore left the policy
   * believing it was in video while the media stayed audio-only — and from the video branch it evaluates
   * only the DOWNGRADE triggers, which an audio-only session can never satisfy, so it never asked again.
   * That was deterministic, not a race: the downgrade timestamp starts at the decision, the actuator's
   * cooldown starts ~5 s later when the rebuilt session connects, so the first restore attempt was
   * ALWAYS about five seconds early. Measured 2026-09-30: the picture never returned in 225 s.
   *
   * `healthySince` is carried forward rather than cleared, so the next window retries immediately
   * instead of waiting out another full hold — the veto is a "not yet", not a "no". */
  const reconcile = useCallback((before: DecisionState, now: number) => {
    decisionRef.current = { ...before, healthySince: before.healthySince ?? now };
    applyMode(before.mode);
  }, [applyMode]);

  const startSampling = useCallback(
    (pc: RTCPeerConnection) => {
      stopSampling();
      windowCountRef.current = 0;
      // A new connection's counters start from zero: close the previous one's window first.
      mediaWindowRef.current?.finish();
      mediaWindowRef.current = new MediaQualityWindow();
      const gen = genRef.current;
      statsTimerRef.current = setInterval(() => {
        if (gen !== genRef.current || pc !== pcRef.current) {
          stopSampling();
          return;
        }
        void pc
          .getStats()
          .then((report) => {
            if (gen !== genRef.current || pc !== pcRef.current) return;
            const now = Date.now();
            const { snapshot, health } = readHealth(snapshotRef.current, report, now);
            snapshotRef.current = snapshot;
            mediaWindowRef.current?.sample(report, performance.now(), decisionRef.current.mode);
            if (!health) return; // first sample: no window to judge yet.

            const before = decisionRef.current;

            // A PIN the actuator refused must be retried, not forgotten. `setVideoPreference` records the
            // preference and then asks `switchMediaMode`, which can veto (Azure's cooldown / request
            // allowance) — and `reduceHealth` short-circuits on any non-"auto" preference, so nothing
            // would ever ask again: the candidate's "turn the picture on" would be silently dropped for
            // the rest of the session. Same defect class as the vetoed restore above. The UI's own gate
            // usually stops a human reaching this, but that gate only knows about the 60 s cooldown while
            // the actuator also enforces the request allowance, so the two can disagree; retrying here
            // makes the pin eventually consistent instead of relying on them never disagreeing.
            const pinned: MediaMode | null =
              before.preference === "on" ? "video" : before.preference === "off" ? "audio-only" : null;
            if (pinned !== null && before.mode !== pinned) {
              switchMediaModeRef.current?.(pinned, `user-pinned-${before.preference}-retry`);
              return; // the pin is the whole decision for this window; the health policy is paused anyway.
            }

            const { state, action } = reduceHealth(before, health, now);
            decisionRef.current = state;

            // While waiting in audio-only, say why the picture has not come back yet. This is the only
            // window where the answer is non-obvious, and four live runs in a row failed to restore with
            // no way to tell whether the streak was resetting, the actuator was vetoing, or the sampler
            // was not running at all. Throttled to every fifth window (~10 s) and silent in video mode,
            // so a healthy session stays quiet.
            windowCountRef.current += 1;
            if (state.mode === "audio-only" && windowCountRef.current % 5 === 0) {
              const heldMs = state.healthySince === null ? 0 : now - state.healthySince;
              console.info(
                `[avatar-health] waiting to restore: audible=${(health.concealmentRatio * 100).toFixed(1)}% ` +
                  `(need <${(HEALTH_THRESHOLDS.CONCEAL_GOOD * 100).toFixed(0)}%), ` +
                  `healthy for ${(heldMs / 1000).toFixed(0)}s of ${(state.healthyHoldMs / 1000).toFixed(0)}s, ` +
                  `${state.lastDowngradeAt === null ? "no downgrade on record" : `${Math.max(0, Math.ceil((HEALTH_THRESHOLDS.MIN_AFTER_DOWNGRADE_MS - (now - state.lastDowngradeAt)) / 1000))}s left on the policy cooldown`}, ` +
                  `failedRestores=${state.failedRestores}, preference=${state.preference}`,
              );
            }

            // Honest UI: the probe measured a ~4 s gap between "video bytes hit zero" and ICE
            // reporting `disconnected`, during which the page still claimed a live avatar frozen on
            // its last frame. Don't wait for ICE to say it.
            if (isVideoStalled(state)) setIsConnected(false);

            if (action === "downgrade") {
              console.warn(
                `[avatar-stream] media health poor (audible conceal=${(health.concealmentRatio * 100).toFixed(1)}%, ` +
                  `raw=${(health.rawConcealmentRatio * 100).toFixed(1)}% incl. silence, ` +
                  `decoding=${health.videoDecoding} rtt=${health.rttMs ?? "?"}ms) → dropping the picture to save the voice`,
              );
              if (!switchMediaModeRef.current?.("audio-only", "health-downgrade")) reconcile(before, now);
            } else if (action === "restore") {
              console.info(
                `[avatar-stream] link healthy again (audible conceal=${(health.concealmentRatio * 100).toFixed(1)}%, ` +
                  `raw=${(health.rawConcealmentRatio * 100).toFixed(1)}% incl. silence) → restoring the picture`,
              );
              if (!switchMediaModeRef.current?.("video", "health-restore")) reconcile(before, now);
            }
          })
          .catch(() => undefined); // getStats can reject on a closing PC; the guards above cover it.
      }, HEALTH_THRESHOLDS.SAMPLE_INTERVAL_MS);
    },
    [reconcile, stopSampling],
  );

  /** Wire connection/track handlers on a freshly-built PC. Shared by the initial connect and every
   * recovery rebuild. Guards every state-triggered action on `pc === pcRef.current` so a superseded
   * (closed) PC's late-firing event can't touch the live connection. */
  const wirePc = useCallback(
    (pc: RTCPeerConnection) => {
      pc.onconnectionstatechange = () => {
        console.info("[avatar-stream] connectionState:", pc.connectionState);
        if (pc.connectionState !== "connected") return;
        const handshake = handshakesRef.current.get(pc);
        handshake?.mark("pc_connected");
        // An audio-only session has no frame to wait for: it is up once ICE and DTLS are.
        if (handshake && !wantVideoRef.current) {
          handshake.mark("audio_live");
          void handshake.finish("audio");
        }
      };
      pc.oniceconnectionstatechange = () => {
        if (pc !== pcRef.current) return;
        const state = pc.iceConnectionState;
        console.info("[avatar-stream] iceConnectionState:", state);
        const handshake = handshakesRef.current.get(pc);
        if (state === "checking") handshake?.mark("ice_checking");
        if ((state === "connected" || state === "completed") && handshake && !handshake.finished) {
          handshake.mark("ice_connected");
          // Which path won (host / srflx / relay over udp / tcp / tls) and its RTT. Held by the
          // handshake record, because the first frame can arrive before getStats answers.
          handshake.waitFor(
            pc.getStats().then((report) => {
              const pair = selectedPair(report);
              if (pair) handshake.set(pair);
            }),
          );
          // Connected but never painting is its own outcome, not a late "closed".
          if (wantVideoRef.current) {
            setTimeout(() => {
              if (!handshake.finished) void handshake.finish("no_frame");
            }, NO_FRAME_LIMIT_MS);
          }
        }
        if (state === "failed") void handshake?.finish("ice_failed");
        if (state === "connected" || state === "completed") {
          // Recovered (or never really lost) — cancel any pending grace/rebuild.
          if (graceTimerRef.current) {
            clearTimeout(graceTimerRef.current);
            graceTimerRef.current = null;
          }
          // Media is flowing: start watching whether it's actually doing us any good.
          startSampling(pc);
          return;
        }
        if (state === "failed") {
          stopSampling();
          // Terminal: won't self-heal without renegotiation → rebuild now.
          attemptRecoveryRef.current?.("ice-failed");
          return;
        }
        if (state === "disconnected") {
          // Often a transient blip. Give it a grace window to self-heal before rebuilding, so we
          // don't flash the orb or tear down a connection that's about to come back on its own.
          if (graceTimerRef.current) return;
          graceTimerRef.current = setTimeout(() => {
            graceTimerRef.current = null;
            if (pc !== pcRef.current) return;
            const s = pc.iceConnectionState;
            if (s === "disconnected" || s === "failed") {
              attemptRecoveryRef.current?.("ice-disconnected-grace-expired");
            }
          }, DISCONNECTED_GRACE_MS);
        }
      };

      pc.ontrack = (event) => {
        console.info("[avatar-stream] ontrack kind=", event.track.kind, "streams=", event.streams.length);
        handshakesRef.current.get(pc)?.mark("first_track");
        if (event.track.kind === "video") {
          const stream = event.streams[0] ?? new MediaStream([event.track]);
          event.track.onended = () => {
            // A video track ending is a strong drop signal — try to rebuild rather than fall to the
            // orb forever (the pre-fix behavior). Guarded so a stale PC's ended track is ignored.
            if (pc !== pcRef.current) return;
            console.warn("[avatar-stream] video track ended → attempting recovery");
            attemptRecoveryRef.current?.("track-ended");
          };
          attachStream(stream);
          return;
        }
        if (event.track.kind !== "audio") return;
        const audio = document.createElement("audio");
        audio.srcObject = event.streams[0] ?? null;
        audio.autoplay = true;
        audio.style.display = "none";
        document.body.appendChild(audio);
        audio.play().catch(() => undefined);
        // Replace any previous audio element (recovery builds a new track) to avoid orphans.
        if (audioElRef.current) {
          audioElRef.current.srcObject = null;
          audioElRef.current.remove();
        }
        audioElRef.current = audio;
        setAudioTrackLive(true);
        // The interviewer's voice rides this track, so this is where "the candidate hears it" is
        // timed for an avatar session (voiceTimeline.watchAudibleOnsets).
        stopAudibleRef.current?.();
        stopAudibleRef.current = watchAudibleOnsets(event.receiver, () =>
          voiceMetrics.turn("first_audible"),
        );
        if (!wantVideoRef.current) voiceMetrics.setup("media_ready");
        // Audio-only sessions never paint a frame, so `reflectDimensions` — which is where a normal
        // session clears the recovery bookkeeping and declares itself settled — never runs. The live
        // audio track is the equivalent milestone here: without this the recovery budget would stay
        // spent and the first-question read would wait out its full gate on every audio-only turn.
        if (!wantVideoRef.current) {
          recoveryAttemptsRef.current = 0;
          recoveringRef.current = false;
        }
      };
    },
    [attachStream, startSampling, stopSampling],
  );

  /** Build a PeerConnection from the stashed ICE servers and wire its handlers. One place, so a future
   * config change (ICE transport policy, a new field) cannot land on only one of the two call sites. */
  const createPeerConnection = useCallback(
    (iceServers: RTCIceServer[], label: string) => {
      if (pcRef.current) void handshakesRef.current.get(pcRef.current)?.finish("superseded");
      const pc = new RTCPeerConnection({
        iceServers: iceServers.length > 0 ? iceServers : undefined,
        bundlePolicy: "max-bundle",
      });
      handshakesRef.current.set(pc, new AvatarHandshakeMetrics({ label }));
      pcRef.current = pc;
      wirePc(pc);
      return pc;
    },
    [wirePc],
  );

  /** Run one offer/answer handshake on `pc`: gather ICE, send the base64 offer via `sendSdpOffer`,
   * await the server SDP answer, apply it. Rejects on ICE/SDP timeout. Shared by connect + recovery. */
  const runHandshake = useCallback(
    async (
      pc: RTCPeerConnection,
      sendSdpOffer: (clientSdp: string) => Promise<void> | void,
      wantVideo: boolean,
    ) => {
      // Consult the rate-limit ledger HERE, not at the call sites. `noteAvatarRequest()` already records
      // every offer from this one place, and the check belongs next to it: `attemptRecovery` and
      // `switchMediaMode` asked, but the consumer-driven `connect()` did not — and that is a reachable
      // hole, not a theoretical one. `useInterviewVoice`'s WS reconnect loop retries at 1s/3s/7s and
      // resets `avatarStartedRef` each time, so a link that drops the socket three times inside 20 s
      // fires three avatar offers; Azure refuses the third, the failure is caught as non-fatal, and the
      // candidate silently loses the picture for the rest of the session. That is the bug this whole
      // change exists to prevent, arriving through the one path that was still unguarded.
      //
      // Placement is load-bearing: this MUST precede `serverSdpPromise` below, whose 15 s timeout is
      // armed before the offer is sent. Waiting after that point would guarantee an SDP timeout.
      const handshakeGen = genRef.current;
      const handshake = handshakesRef.current.get(pc);
      handshake?.set({ video: wantVideo });
      const budgetWait = avatarRequestWaitMs();
      if (budgetWait > 0) {
        console.info(
          `[avatar-stream] holding the avatar offer ${Math.ceil(budgetWait / 1000)}s — Azure's request allowance is spent`,
        );
        await new Promise((resolve) => setTimeout(resolve, budgetWait));
        if (handshakeGen !== genRef.current) {
          // Someone started a newer handshake while we waited. Sending now would spend a real Azure
          // request on a dead peer connection. The caller's catch treats this as non-fatal, resets its
          // one-shot guard and keeps the voice, so a later `session.updated` can try again.
          void handshake?.finish("superseded");
          throw new Error("avatar handshake superseded while waiting for the rate-limit allowance");
        }
      }

      // Two recvonly transceivers, registered BEFORE createOffer — the avatar only streams TO us.
      // For an audio-only session the video m-line is still offered but marked `inactive`: Azure
      // answers that and sends only the audio track (~100 kbps). DELETING the m-line instead is
      // REJECTED by Azure ("WebRTC SDP negotiation failed: peer connect created failure: None is not
      // in list"), which is why this is a direction flip and not a missing transceiver — measured
      // 2026-09-30, `docs/avatar-weaknet-probe.md` §3.6.
      // The handshake proper starts here, after any rate-limit hold (`hold_ms`).
      handshake?.mark("offer_start");
      pc.addTransceiver("video", { direction: wantVideo ? "recvonly" : "inactive" });
      pc.addTransceiver("audio", { direction: "recvonly" });
      console.info(
        `[avatar-stream] transceivers added (video=${wantVideo ? "recvonly" : "inactive"}); calling createOffer()`,
      );

      // ICE gate: resolve on whichever fires first — the null-candidate signal, the
      // gathering-state transition, a short settle window after the first USABLE candidate, or an
      // 8s safety timeout. The settle window is the fast path that matters in practice: Azure's
      // avatar ICE server is a TURN relay, so the handshake can proceed as soon as one relay (or
      // srflx) candidate is in the SDP — networks with VPN/mDNS interfaces often NEVER signal
      // gathering "complete", which used to stall every connect for the full 8s cap (measured
      // live: the avatar's time-to-first-frame dropped ~7.5s with this gate).
      const offerReadyPromise = new Promise<string>((resolve) => {
        let sent = false;
        let settleTimer: ReturnType<typeof setTimeout> | null = null;
        const sendOnce = () => {
          if (sent || !pc.localDescription) return;
          sent = true;
          if (settleTimer) clearTimeout(settleTimer);
          // localDescription.sdp is re-read here, so it carries every candidate gathered so far.
          resolve(btoa(JSON.stringify({ type: "offer", sdp: pc.localDescription.sdp })));
        };
        pc.onicecandidate = (e) => {
          // first_host / first_srflx (the STUN answer) / first_relay (the TURN allocation).
          const type = candidateType(e.candidate?.candidate);
          if (type) handshake?.mark(`first_${type}`);
          if (!e.candidate) {
            sendOnce();
            return;
          }
          if (!settleTimer && / typ (relay|srflx)(\s|$)/.test(e.candidate.candidate ?? "")) {
            settleTimer = setTimeout(sendOnce, ICE_SETTLE_AFTER_CANDIDATE_MS);
          }
        };
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === "complete") sendOnce();
        };
        setTimeout(sendOnce, ICE_GATHERING_TIMEOUT_MS);
      });

      const offer = await pc.createOffer();
      // Marked BEFORE setLocalDescription: that call is what starts ICE gathering, so the candidate
      // timings (first host / srflx / relay) are measured from here.
      handshake?.mark("offer_created");
      console.info("[avatar-stream] createOffer resolved; calling setLocalDescription()");
      await pc.setLocalDescription(offer);
      console.info("[avatar-stream] setLocalDescription done; gathering ICE for offer");

      const serverSdpPromise = new Promise<string>((resolve, reject) => {
        sdpResolverRef.current = resolve;
        setTimeout(() => {
          sdpResolverRef.current = null;
          reject(new Error("Avatar SDP answer timeout"));
        }, SERVER_SDP_TIMEOUT_MS);
      });
      // The await below is not always reached: if the WS send throws, this promise is left armed and
      // rejects 15 s later with nobody listening, which the browser reports as an unhandled rejection
      // in the middle of a recovery the user can already see failing. Attaching an observer here does
      // not consume the rejection — the real `await` still receives it — it only stops the orphan case
      // from looking like a crash.
      // The timeout is this promise's only rejection, so it is also where the handshake's timing
      // record ends with `sdp_timeout`.
      serverSdpPromise.catch(() => {
        void handshake?.finish("sdp_timeout");
      });

      const encodedOffer = await offerReadyPromise;
      console.info("[avatar-stream] offer ready, sending session.avatar.connect");
      noteAvatarRequest();
      handshake?.mark("offer_sent");
      await sendSdpOffer(encodedOffer);

      const serverSdp = await serverSdpPromise;
      handshake?.mark("answer_received");
      sdpResolverRef.current = null;
      await pc.setRemoteDescription({ type: "answer", sdp: serverSdp });
      handshake?.mark("answer_applied");
      console.info("[avatar-stream] setRemoteDescription success; awaiting first video frame");
    },
    [avatarRequestWaitMs, noteAvatarRequest],
  );

  /** Close the current PC and run a fresh handshake on a new one, reusing the stashed ICE servers +
   * WS-send callback. Shared by the self-heal path (after a backoff) and the deliberate media-mode
   * switch (immediately) — the only difference between them is the recovery budget, which is the
   * caller's business. */
  const rebuildConnection = useCallback(
    (
      sendSdpOffer: (clientSdp: string) => Promise<void> | void,
      wantVideo: boolean,
      label: string,
    ) => {
      const gen = genRef.current;
      stopSampling();
      stopAudibleRef.current?.();
      stopAudibleRef.current = null;

      if (pcRef.current) {
        // The old connection's handshake record ends here; `createPeerConnection` below no longer
        // sees it, because `pcRef` is cleared first.
        void handshakesRef.current.get(pcRef.current)?.finish("rebuilt");
        pcRef.current.close();
        pcRef.current = null;
      }
      if (videoRef.current) videoRef.current.srcObject = null;
      pendingStreamRef.current = null;
      setAudioTrackLive(false);
      wantVideoRef.current = wantVideo;

      const pc = createPeerConnection(iceServersRef.current, label);
      console.info(`[avatar-stream] ${label}: RTCPeerConnection rebuilt (video=${wantVideo ? "on" : "off"})`);

      runHandshake(pc, sendSdpOffer, wantVideo)
        .then(() => {
          // Handshake applied. `recoveringRef` stays true until the session settles (real frames for a
          // video session, a live audio track for an audio-only one) so overlapping ICE events don't
          // spawn a second rebuild meanwhile.
          console.info(`[avatar-stream] ${label} handshake completed`);
        })
        .catch((err: unknown) => {
          void handshakesRef.current.get(pc)?.finish("handshake_failed");
          if (gen !== genRef.current) return;
          console.warn(`[avatar-stream] ${label} handshake failed`, err);
          recoveringRef.current = false;
          // Retry the next attempt (bounded); attemptRecovery re-checks the budget.
          attemptRecoveryRef.current?.("recovery-handshake-failed");
        });
    },
    [createPeerConnection, runHandshake, stopSampling, videoRef],
  );

  /** Rebuild the avatar media connection after a drop, reusing the last ICE servers + WS-send
   * callback. Bounded by MAX_RECOVERY_ATTEMPTS with backoff; falls back to the orb when exhausted. */
  const attemptRecovery = useCallback(
    (reason: string) => {
      const sendSdpOffer = sendOfferRef.current;
      if (!sendSdpOffer) return; // never connected / already disconnected — nothing to rebuild.
      if (recoveringRef.current) return; // a rebuild is already in flight.

      if (recoveryAttemptsRef.current >= MAX_RECOVERY_ATTEMPTS) {
        recoveringRef.current = false;
        setIsConnected(false);
        // Showing the orb and stopping here STRANDED the session: the stats sampler dies with the
        // connection, so the weak-network policy could never act either, and the candidate spent the
        // rest of the interview picture-less with no automatic way back (voice kept working, which is
        // why it went unnoticed). A link that just failed three video handshakes is precisely the link
        // audio-only exists for, so rebuild into the mode it can actually carry instead of giving up.
        if (wantVideoRef.current && onModeSwitchRequestRef.current) {
          const wait = avatarRequestWaitMs();
          console.warn(
            `[avatar-stream] recovery exhausted after ${MAX_RECOVERY_ATTEMPTS} attempts (${reason}); ` +
              `switching to audio-only${wait > 0 ? ` in ${Math.ceil(wait / 1000)}s (avatar rate-limit allowance)` : ""}`,
          );
          const gen = genRef.current;
          recoveryTimerRef.current = setTimeout(() => {
            recoveryTimerRef.current = null;
            if (gen !== genRef.current) return; // superseded by disconnect()/reconnect — abandon.
            // The audio-only session is a different proposition and gets its own self-heal budget; if it
            // also fails three times, `wantVideoRef` is false by then and we fall through to the orb, so
            // this cannot bounce between modes.
            recoveryAttemptsRef.current = 0;
            switchMediaModeRef.current?.("audio-only", "recovery-exhausted");
          }, wait);
          return;
        }
        console.warn(
          `[avatar-stream] recovery exhausted after ${MAX_RECOVERY_ATTEMPTS} attempts (${reason}); showing orb`,
        );
        return;
      }

      recoveringRef.current = true;
      const attempt = ++recoveryAttemptsRef.current;
      // The table is a floor. If we have already spent the allowance, waiting is strictly better than
      // offering: a refused request still costs the attempt, and the refusal cascades into the page
      // showing "voice unavailable" and dropping the candidate to text.
      const budgetWait = avatarRequestWaitMs();
      const backoff = Math.max(RECOVERY_BACKOFF_MS[attempt - 1] ?? 3000, budgetWait);
      console.warn(
        `[avatar-stream] recovery attempt ${attempt}/${MAX_RECOVERY_ATTEMPTS} (${reason}) in ${backoff}ms` +
          (budgetWait > backoff - 1 && budgetWait > 0 ? " (held by the avatar rate-limit allowance)" : ""),
      );
      // Show the orb while we rebuild — the frozen last frame would otherwise masquerade as live.
      setIsConnected(false);
      clearTimers();

      const gen = genRef.current;
      recoveryTimerRef.current = setTimeout(() => {
        recoveryTimerRef.current = null;
        if (gen !== genRef.current) return; // superseded by disconnect()/reconnect — abandon.
        // Rebuild in whatever mode we're currently in: a media drop must not silently hand the
        // picture back on a link that just proved it can't carry it.
        rebuildConnection(sendSdpOffer, wantVideoRef.current, "recovery");
      }, backoff);
    },
    [avatarRequestWaitMs, clearTimers, rebuildConnection],
  );
  attemptRecoveryRef.current = attemptRecovery;

  /** Ask for the picture to be turned on/off. Tears the media down immediately (which is the point when
   * the video is the thing starving the voice) and delegates the rebuild to the consumer, because Azure
   * will not renegotiate an avatar connection on a live session — see the module header. */
  const switchMediaMode = useCallback(
    (next: MediaMode, reason: string): boolean => {
      if (!sendOfferRef.current) return false; // no live avatar session to switch.
      if (wantVideoRef.current === (next === "video")) return false; // already in that mode.
      if (!onModeSwitchRequestRef.current) {
        // Nobody can rebuild the session, so tearing the media down here would kill the avatar for
        // good. Refuse instead — a consumer that wants adaptation must wire the callback.
        console.warn("[avatar-stream] media mode change requested but no onModeSwitchRequest is wired; ignoring");
        return false;
      }
      if (next === "video") {
        // Asymmetric on purpose: Azure rate-limits avatar session creation, and a refused request
        // cascades into a dead voice session. Dropping the picture is never delayed; bringing it back
        // waits. The hysteresis in avatarHealth already spaces AUTOMATIC restores past this, so in
        // practice this only catches an impatient human on the manual toggle.
        const since = avatarConnectedAtRef.current;
        const cooldown = since === null ? 0 : HEALTH_THRESHOLDS.VIDEO_SWITCH_MIN_INTERVAL_MS - (Date.now() - since);
        // Both bounds, not just the cooldown. The 60 s cooldown does cover Azure's ~20 s window today,
        // but only by arithmetic coincidence — consulting the ledger as well makes the guarantee
        // explicit, so lowering the cooldown later cannot quietly reintroduce a refused request.
        const wait = Math.max(cooldown, avatarRequestWaitMs());
        if (wait > 0) {
          console.info(
            `[avatar-stream] not restoring the picture yet (${Math.ceil(wait / 1000)}s left on the Azure avatar ` +
              `rate-limit ${cooldown >= wait ? "cooldown" : "allowance"})`,
          );
          return false;
        }
      }

      console.info(`[avatar-stream] media mode → ${next} (${reason}); rebuilding the Voice Live session`);
      // Remember the target BEFORE tearing down: connect() reads it back out of decisionRef, and the
      // hysteresis counters must survive the restart or a bad link would flap forever.
      applyMode(next);
      teardownMedia();
      onModeSwitchRequestRef.current?.(next);
      return true;
    },
    [applyMode, avatarRequestWaitMs, teardownMedia],
  );
  switchMediaModeRef.current = switchMediaMode;

  /** Pin the picture on/off by hand, or hand control back to the health signal (`auto`). A pinned
   * preference stops the automation from moving the mode, but sampling continues so the UI can keep
   * telling the truth about the link. */
  const setVideoPreference = useCallback((preference: VideoPreference) => {
    const target: MediaMode | null =
      preference === "off" ? "audio-only" : preference === "on" ? "video" : null;
    decisionRef.current = { ...decisionRef.current, preference };
    setVideoPreferenceState(preference);
    if (!target) return; // back to "auto": leave the current mode, let the health signal take over.
    if (!sendOfferRef.current) {
      // No live session yet (e.g. pinned on the pre-flight screen): just decide what the next
      // connect() will offer. Going through switchMediaMode here would bail and silently drop the pin.
      applyMode(target);
      return;
    }
    switchMediaModeRef.current?.(target, `user-pinned-${preference}`);
  }, [applyMode]);

  /**
   * Start the avatar WebRTC handshake.
   * @param iceServers ICE servers from `session.updated`'s `session.avatar.ice_servers`.
   * @param sendSdpOffer Sends the base64-encoded SDP offer as `session.avatar.connect` over the
   *   Voice Live WS (caller's responsibility — this hook has no WS reference).
   */
  const connect = useCallback(
    async (iceServers: RTCIceServer[], sendSdpOffer: (clientSdp: string) => Promise<void> | void) => {
      console.info("[avatar-stream] connect() entry, iceServers=", iceServers.length);
      // Fresh session: reset recovery bookkeeping and stash inputs for any later media-only rebuild.
      genRef.current++;
      clearTimers();
      recoveringRef.current = false;
      recoveryAttemptsRef.current = 0;
      iceServersRef.current = iceServers;
      sendOfferRef.current = sendSdpOffer;

      // Carry the media policy across the reconnect: only the per-window streaks reset. The mode itself
      // must survive, because a mode switch IS a reconnect (module header) — deriving it afresh here
      // would bring the picture straight back and loop. Same for the candidate's manual pin.
      decisionRef.current = resetStreaks(decisionRef.current);
      applyMode(decisionRef.current.mode);
      const wantVideo = decisionRef.current.mode === "video";
      setAudioTrackLive(false);

      pendingStreamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;

      const pc = createPeerConnection(iceServers, "initial");
      console.info("[avatar-stream] RTCPeerConnection created");
      avatarConnectedAtRef.current = Date.now();
      setCanEnableVideo(false);

      await runHandshake(pc, sendSdpOffer, wantVideo).catch((err: unknown) => {
        void handshakesRef.current.get(pc)?.finish("handshake_failed");
        throw err;
      });
    },
    [applyMode, clearTimers, createPeerConnection, runHandshake, videoRef],
  );

  // Let the UI re-enable "turn the picture on" once Azure's avatar rate-limit cooldown has passed.
  // Polled rather than a single timer so a mode switch mid-countdown can't leave a stale timeout.
  useEffect(() => {
    if (canEnableVideo) return;
    const id = setInterval(() => {
      const since = avatarConnectedAtRef.current;
      if (since === null || Date.now() - since >= HEALTH_THRESHOLDS.VIDEO_SWITCH_MIN_INTERVAL_MS) {
        setCanEnableVideo(true);
      }
    }, 1_000);
    return () => clearInterval(id);
  }, [canEnableVideo]);

  // A tab closed mid-call never tears the connection down: send the quality window it was in (often
  // the bad stretch that made the candidate leave) on the way out. `voice.media` is queued without an
  // immediate send, so the unload flush carries it.
  useEffect(() => {
    const onPageHide = () => {
      mediaWindowRef.current?.finish();
      flushForUnload();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  // Re-attach the avatar stream if the <video> element mounts AFTER `ontrack` already fired. The
  // editor Playground mounts <video> only while voice is live, which can race the async handshake;
  // this effect closes that gap so a track is never permanently lost to a transiently-null ref.
  useEffect(() => {
    if (pendingStreamRef.current && videoRef.current && !videoRef.current.srcObject) {
      console.info("[avatar-stream] <video> now mounted; re-attaching pending stream");
      attachStream(pendingStreamRef.current);
    }
  });

  /** Handle a `session.avatar.connecting` event's `server_sdp` (base64 JSON `{type,sdp}`, with a
   * raw-string fallback if decoding fails). */
  const handleServerSdp = useCallback((rawServerSdp: string) => {
    let sdp = rawServerSdp;
    try {
      const decoded = JSON.parse(atob(rawServerSdp)) as { sdp?: string };
      if (decoded.sdp) sdp = decoded.sdp;
    } catch {
      console.debug("[avatar-stream] server_sdp not base64 JSON, using raw value");
    }
    sdpResolverRef.current?.(sdp);
  }, []);

  const disconnect = useCallback(() => {
    teardownMedia();
  }, [teardownMedia]);

  return {
    connect,
    disconnect,
    handleServerSdp,
    /** Video frames are painting. Drives AvatarView's video-vs-orb choice. */
    isConnected,
    /** The media path can carry the interviewer's voice: painted frames, OR a live audio track in an
     * audio-only session. This — not `isConnected` — is what the first-question read must wait for;
     * an audio-only session never paints a frame, so gating on `isConnected` made every audio-only
     * turn sit out the full gate timeout before speaking. */
    isMediaReady: isConnected || (mediaMode === "audio-only" && audioTrackLive),
    mediaMode,
    videoPreference,
    setVideoPreference,
    /** False while Azure's avatar rate-limit cooldown blocks a switch back into video. The UI should
     * disable its "turn the picture on" control rather than let the click silently do nothing — and
     * say WHY, using `videoEnableAtMs`. */
    canEnableVideo,
    /** Epoch ms when the cooldown lifts, or null if there is nothing to wait for. Deliberately a fixed
     * timestamp rather than a ticking countdown: a per-second counter would re-render the whole
     * interview page once a second for a minute, and the useful information is the reason, not the tick. */
    videoEnableAtMs:
      avatarConnectedAtRef.current === null || canEnableVideo
        ? null
        : avatarConnectedAtRef.current + HEALTH_THRESHOLDS.VIDEO_SWITCH_MIN_INTERVAL_MS,
  };
}
