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
 * Ported from the reference Avatar layer's `use-avatar-stream.ts`, trimmed of its getStats
 * telemetry/anomaly-detection polling (not requested here; the core ask is a working handshake) —
 * connection-state logging is kept via plain `console.debug/warn`.
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
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

/** All candidates gathered within this window before falling back to sending whatever we have. */
const ICE_GATHERING_TIMEOUT_MS = 8000;
/** Azure's SDP answer (`session.avatar.connecting`) must arrive within this window. */
const SERVER_SDP_TIMEOUT_MS = 15000;
/** An ICE `disconnected` often self-heals (brief network blip). Wait this long before treating it
 * as a real drop and rebuilding — so a momentary blip never flashes the fallback orb. `failed` is
 * terminal and skips this grace (it won't recover without a full renegotiation). */
const DISCONNECTED_GRACE_MS = 3000;
/** Cap re-handshake attempts per drop so a persistently-broken media path can't loop forever (the
 * orb is the honest fallback once we give up). Budget resets when real frames paint again. */
const MAX_RECOVERY_ATTEMPTS = 3;
/** Backoff before each re-handshake attempt (index = attempt-1). */
const RECOVERY_BACKOFF_MS = [500, 1500, 3000];

export function useAvatarStream(videoRef: RefObject<HTMLVideoElement | null>) {
  const pcRef = useRef<RTCPeerConnection | null>(null);
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
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveringRef = useRef(false);
  // Bumped by disconnect()/connect() so a stale in-flight recovery (or a dead PC's late event) can
  // detect it's been superseded and bail instead of clobbering the current connection.
  const genRef = useRef(0);

  const clearTimers = useCallback(() => {
    if (recoveryTimerRef.current) {
      clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }
  }, []);

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
      let pollId: ReturnType<typeof setInterval> | null = null;
      const stopPolling = () => {
        if (pollId) {
          clearInterval(pollId);
          pollId = null;
        }
      };
      const reflectDimensions = () => {
        const hasFrames = videoEl.videoWidth > 0 && videoEl.videoHeight > 0;
        if (hasFrames && !settled) {
          settled = true;
          stopPolling();
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
      pollId = setInterval(reflectDimensions, 250);
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
    [videoRef],
  );

  // Forward declaration so wirePc (used by both connect and recovery) can call the recovery routine.
  const attemptRecoveryRef = useRef<((reason: string) => void) | null>(null);

  /** Wire connection/track handlers on a freshly-built PC. Shared by the initial connect and every
   * recovery rebuild. Guards every state-triggered action on `pc === pcRef.current` so a superseded
   * (closed) PC's late-firing event can't touch the live connection. */
  const wirePc = useCallback(
    (pc: RTCPeerConnection) => {
      pc.onconnectionstatechange = () => {
        console.info("[avatar-stream] connectionState:", pc.connectionState);
      };
      pc.oniceconnectionstatechange = () => {
        if (pc !== pcRef.current) return;
        const state = pc.iceConnectionState;
        console.info("[avatar-stream] iceConnectionState:", state);
        if (state === "connected" || state === "completed") {
          // Recovered (or never really lost) — cancel any pending grace/rebuild.
          if (graceTimerRef.current) {
            clearTimeout(graceTimerRef.current);
            graceTimerRef.current = null;
          }
          return;
        }
        if (state === "failed") {
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
      };
    },
    [attachStream],
  );

  /** Run one offer/answer handshake on `pc`: gather ICE, send the base64 offer via `sendSdpOffer`,
   * await the server SDP answer, apply it. Rejects on ICE/SDP timeout. Shared by connect + recovery. */
  const runHandshake = useCallback(
    async (pc: RTCPeerConnection, sendSdpOffer: (clientSdp: string) => Promise<void> | void) => {
      // Two recvonly transceivers, registered BEFORE createOffer — the avatar only streams TO us.
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });
      console.info("[avatar-stream] transceivers added; calling createOffer()");

      // ICE-complete gate: resolve on whichever fires first — the null-candidate signal, the
      // gathering-state transition, or an 8s safety timeout (some networks never signal complete).
      const offerReadyPromise = new Promise<string>((resolve) => {
        let sent = false;
        const sendOnce = () => {
          if (sent || !pc.localDescription) return;
          sent = true;
          resolve(btoa(JSON.stringify({ type: "offer", sdp: pc.localDescription.sdp })));
        };
        pc.onicecandidate = (e) => {
          if (!e.candidate) sendOnce();
        };
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === "complete") sendOnce();
        };
        setTimeout(sendOnce, ICE_GATHERING_TIMEOUT_MS);
      });

      const offer = await pc.createOffer();
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

      const encodedOffer = await offerReadyPromise;
      console.info("[avatar-stream] offer ready, sending session.avatar.connect");
      await sendSdpOffer(encodedOffer);

      const serverSdp = await serverSdpPromise;
      sdpResolverRef.current = null;
      await pc.setRemoteDescription({ type: "answer", sdp: serverSdp });
      console.info("[avatar-stream] setRemoteDescription success; awaiting first video frame");
    },
    [],
  );

  /** Rebuild the avatar media connection after a drop, reusing the last ICE servers + WS-send
   * callback. Bounded by MAX_RECOVERY_ATTEMPTS with backoff; falls back to the orb when exhausted. */
  const attemptRecovery = useCallback(
    (reason: string) => {
      const sendSdpOffer = sendOfferRef.current;
      if (!sendSdpOffer) return; // never connected / already disconnected — nothing to rebuild.
      if (recoveringRef.current) return; // a rebuild is already in flight.

      if (recoveryAttemptsRef.current >= MAX_RECOVERY_ATTEMPTS) {
        console.warn(
          `[avatar-stream] recovery exhausted after ${MAX_RECOVERY_ATTEMPTS} attempts (${reason}); showing orb`,
        );
        recoveringRef.current = false;
        setIsConnected(false);
        return;
      }

      recoveringRef.current = true;
      const attempt = ++recoveryAttemptsRef.current;
      const backoff = RECOVERY_BACKOFF_MS[attempt - 1] ?? 3000;
      console.warn(`[avatar-stream] recovery attempt ${attempt}/${MAX_RECOVERY_ATTEMPTS} (${reason}) in ${backoff}ms`);
      // Show the orb while we rebuild — the frozen last frame would otherwise masquerade as live.
      setIsConnected(false);
      clearTimers();

      const gen = genRef.current;
      recoveryTimerRef.current = setTimeout(() => {
        recoveryTimerRef.current = null;
        if (gen !== genRef.current) return; // superseded by disconnect()/reconnect — abandon.

        // Tear down the old PC before rebuilding.
        if (pcRef.current) {
          pcRef.current.close();
          pcRef.current = null;
        }
        if (videoRef.current) videoRef.current.srcObject = null;

        const pc = new RTCPeerConnection({
          iceServers: iceServersRef.current.length > 0 ? iceServersRef.current : undefined,
          bundlePolicy: "max-bundle",
        });
        pcRef.current = pc;
        wirePc(pc);
        console.info("[avatar-stream] recovery: RTCPeerConnection rebuilt");

        runHandshake(pc, sendSdpOffer)
          .then(() => {
            // Handshake applied. `recoveringRef` stays true until real frames paint (reset in
            // reflectDimensions) so overlapping ICE events don't spawn a second rebuild meanwhile.
            console.info("[avatar-stream] recovery handshake completed; awaiting frames");
          })
          .catch((err: unknown) => {
            if (gen !== genRef.current) return;
            console.warn("[avatar-stream] recovery handshake failed", err);
            recoveringRef.current = false;
            // Retry the next attempt (bounded); attemptRecovery re-checks the budget.
            attemptRecoveryRef.current?.("recovery-handshake-failed");
          });
      }, backoff);
    },
    [clearTimers, runHandshake, videoRef, wirePc],
  );
  attemptRecoveryRef.current = attemptRecovery;

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

      pendingStreamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;

      const pc = new RTCPeerConnection({
        iceServers: iceServers.length > 0 ? iceServers : undefined,
        bundlePolicy: "max-bundle",
      });
      pcRef.current = pc;
      wirePc(pc);
      console.info("[avatar-stream] RTCPeerConnection created");

      await runHandshake(pc, sendSdpOffer);
    },
    [clearTimers, runHandshake, videoRef, wirePc],
  );

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
    genRef.current++; // supersede any in-flight recovery so its timer/handshake bails.
    clearTimers();
    recoveringRef.current = false;
    recoveryAttemptsRef.current = 0;
    sendOfferRef.current = null;
    iceServersRef.current = [];
    sdpResolverRef.current = null;
    pendingStreamRef.current = null;
    if (pcRef.current) {
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
  }, [clearTimers, videoRef]);

  return { connect, disconnect, handleServerSdp, isConnected };
}
