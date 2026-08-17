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
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

/** All candidates gathered within this window before falling back to sending whatever we have. */
const ICE_GATHERING_TIMEOUT_MS = 8000;
/** Azure's SDP answer (`session.avatar.connecting`) must arrive within this window. */
const SERVER_SDP_TIMEOUT_MS = 15000;

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

  /**
   * Start the avatar WebRTC handshake.
   * @param iceServers ICE servers from `session.updated`'s `session.avatar.ice_servers`.
   * @param sendSdpOffer Sends the base64-encoded SDP offer as `session.avatar.connect` over the
   *   Voice Live WS (caller's responsibility — this hook has no WS reference).
   */
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

  const connect = useCallback(
    async (iceServers: RTCIceServer[], sendSdpOffer: (clientSdp: string) => Promise<void> | void) => {
      console.info("[avatar-stream] connect() entry, iceServers=", iceServers.length);
      pendingStreamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;

      const pc = new RTCPeerConnection({
        iceServers: iceServers.length > 0 ? iceServers : undefined,
        bundlePolicy: "max-bundle",
      });
      pcRef.current = pc;
      console.info("[avatar-stream] RTCPeerConnection created");

      pc.onconnectionstatechange = () => {
        console.info("[avatar-stream] connectionState:", pc.connectionState);
      };
      pc.oniceconnectionstatechange = () => {
        console.info("[avatar-stream] iceConnectionState:", pc.iceConnectionState);
      };

      pc.ontrack = (event) => {
        console.info("[avatar-stream] ontrack kind=", event.track.kind, "streams=", event.streams.length);
        if (event.track.kind === "video") {
          const stream = event.streams[0] ?? new MediaStream([event.track]);
          event.track.onended = () => setIsConnected(false);
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
        audioElRef.current = audio;
      };

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
    [videoRef, attachStream],
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
  }, [videoRef]);

  return { connect, disconnect, handleServerSdp, isConnected };
}
