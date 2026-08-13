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
import { useCallback, useRef, useState } from "react";
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

  /**
   * Start the avatar WebRTC handshake.
   * @param iceServers ICE servers from `session.updated`'s `session.avatar.ice_servers`.
   * @param sendSdpOffer Sends the base64-encoded SDP offer as `session.avatar.connect` over the
   *   Voice Live WS (caller's responsibility — this hook has no WS reference).
   */
  const connect = useCallback(
    async (iceServers: RTCIceServer[], sendSdpOffer: (clientSdp: string) => Promise<void> | void) => {
      if (videoRef.current) videoRef.current.srcObject = null;

      const pc = new RTCPeerConnection({
        iceServers: iceServers.length > 0 ? iceServers : undefined,
        bundlePolicy: "max-bundle",
      });
      pcRef.current = pc;

      pc.onconnectionstatechange = () => {
        console.debug("[avatar-stream] connectionState:", pc.connectionState);
      };
      pc.oniceconnectionstatechange = () => {
        console.debug("[avatar-stream] iceConnectionState:", pc.iceConnectionState);
      };

      pc.ontrack = (event) => {
        if (event.track.kind === "video") {
          const videoEl = videoRef.current;
          if (!videoEl) return;
          videoEl.srcObject = event.streams[0] ?? null;
          // Flip isConnected (which hides AvatarView's fallback orb) ONLY once the video is
          // actually producing real frames — a track that connects but never paints (0x0) must
          // leave the orb visible, matching the existing frame-gate pattern in useInterviewVoice.
          const reflectDimensions = () => {
            const hasFrames = videoEl.videoWidth > 0 && videoEl.videoHeight > 0;
            console.debug(
              `[avatar-stream] video ${hasFrames ? "has frames" : "0x0 (no frames yet)"}: ` +
                `${videoEl.videoWidth}x${videoEl.videoHeight}`,
            );
            setIsConnected(hasFrames);
          };
          videoEl.onloadedmetadata = reflectDimensions;
          videoEl.onresize = reflectDimensions;
          event.track.onended = () => setIsConnected(false);
          videoEl
            .play()
            .then(reflectDimensions)
            .catch((err: unknown) => {
              console.debug("[avatar-stream] video play() rejected; keeping orb", err);
              setIsConnected(false);
            });
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
      await pc.setLocalDescription(offer);

      const serverSdpPromise = new Promise<string>((resolve, reject) => {
        sdpResolverRef.current = resolve;
        setTimeout(() => {
          sdpResolverRef.current = null;
          reject(new Error("Avatar SDP answer timeout"));
        }, SERVER_SDP_TIMEOUT_MS);
      });

      const encodedOffer = await offerReadyPromise;
      await sendSdpOffer(encodedOffer);

      const serverSdp = await serverSdpPromise;
      sdpResolverRef.current = null;
      await pc.setRemoteDescription({ type: "answer", sdp: serverSdp });
      console.debug("[avatar-stream] setRemoteDescription success; awaiting first video frame");
    },
    [videoRef],
  );

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
