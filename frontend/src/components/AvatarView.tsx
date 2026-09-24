/**
 * AvatarView (SPEC F5/F9) — the interviewer's visual presence.
 *
 * Layers, in order:
 * 1. A `<video>` element (always in the DOM so `ontrack` can attach a stream at any time) — shown
 *    once a real digital-human avatar video track arrives from Voice Live.
 * 2. A cached still portrait of the interviewer (issue 5) — shown while the live stream is still
 *    connecting, so the PERSON appears instantly on every visit after the first. The portrait is a
 *    frame captured from the previous live session (localStorage), overlaid with the "connecting"
 *    hint; the live video fades in over it when frames arrive.
 * 3. The AudioOrb — shown when there's no avatar video AND no cached portrait yet (first-ever
 *    visit, voice-only session, or the persona has no character). So the page always has a
 *    presence.
 *
 * The `<video>` visibility is driven by opacity/z-index (not display:none) so the browser's
 * autoplay pipeline stays alive while a track is attaching.
 *
 * The `<video>` is **muted** on purpose: Chrome's autoplay policy blocks `play()` on an unmuted
 * media element outside a user gesture, and the avatar track is attached from the async `ontrack`
 * handler — an unmuted video silently fails to play and leaves a blank box. Muting the video is
 * safe because the avatar's AUDIO arrives on a SEPARATE `<audio>` element (see useInterviewVoice
 * ontrack), not this element.
 */
import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { makeStyles, mergeClasses, Text } from "@fluentui/react-components";
import { useTranslation } from "react-i18next";
import { AudioOrb } from "./AudioOrb";
import { fitFor } from "./avatarFit";
import type { AudioState } from "../types/voice";

/** Single-slot portrait cache. This deployment runs ONE default interviewer persona, so the slot
 * isn't keyed by character; a persona/avatar change self-corrects on the next successful session
 * (the capture below overwrites the slot). Bump the suffix if the stored format ever changes. */
export const AVATAR_PORTRAIT_STORAGE_KEY = "avatar-portrait-v1";
/** Give the stream a beat after the first frames so the captured pose is settled, not mid-fade. */
const PORTRAIT_CAPTURE_DELAY_MS = 2000;
/** Downscale the 1080p frame for storage — a stage-quality still at a fraction of the quota. */
const PORTRAIT_CAPTURE_WIDTH = 480;

const useStyles = makeStyles({
  root: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    // Fill the (flex-grown) stage so the avatar video is as large as the space allows, rather than a
    // fixed small box. minHeight:0 so it never forces the bounded stage to overflow the viewport.
    width: "100%",
    height: "100%",
    minHeight: 0,
  },
  video: {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    // The fit is chosen PER STREAM (see `fitFor`): `fitCover` for 16:9 video avatars, `fitContain`
    // for square/portrait photo avatars. Default (before metadata) is contain — never crop blind.
    borderRadius: "12px",
    transition: "opacity 300ms ease",
  },
  // 16:9 VIDEO avatars (lisa, …): fill the stage; the frame is a centred person on wide white
  // margins, so `cover` crops those margins, never the figure — anchored top so the head is the
  // last thing sacrificed.
  fitCover: { objectFit: "cover", objectPosition: "center top" },
  // Square / portrait PHOTO avatars (vasa-1: amira, adrian, …) stream 512×512 (live-verified). On
  // the interview page's wider-than-square stage `cover` scaled by width and cut the shoulders and
  // chin off the bottom (issue1, 2026-09-24), so these keep the WHOLE frame — the same head-and-
  // shoulders framing the editor's photo preview shows.
  fitContain: { objectFit: "contain", objectPosition: "center center" },
  hidden: { opacity: 0, zIndex: 0, pointerEvents: "none" },
  shown: { opacity: 1, zIndex: 10 },
  // The still portrait sits UNDER the video layer (z-index 5 < shown 10) so the live stream fades
  // in over it with no orb flash in between.
  portrait: {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    borderRadius: "12px",
    zIndex: 5,
    // Slightly dimmed so "not live yet" is perceptible without hiding the person.
    filter: "saturate(0.85) brightness(0.92)",
  },
  connectingHint: {
    position: "absolute",
    bottom: "16px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 6,
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 14px",
    borderRadius: "16px",
    backgroundColor: "rgba(0, 0, 0, 0.55)",
    color: "#fff",
    whiteSpace: "nowrap",
  },
  connectingDot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    backgroundColor: "#7ee787",
    animationName: {
      "0%": { opacity: 0.3 },
      "50%": { opacity: 1 },
      "100%": { opacity: 0.3 },
    },
    animationDuration: "1.2s",
    animationIterationCount: "infinite",
  },
});

function readCachedPortrait(): string | null {
  try {
    const v = localStorage.getItem(AVATAR_PORTRAIT_STORAGE_KEY);
    return v && v.startsWith("data:image/") ? v : null;
  } catch {
    return null; // storage unavailable (privacy mode) → orb fallback, as before
  }
}

interface AvatarViewProps {
  audioState: AudioState;
  /** True once a real avatar video track is playing → show video, hide the orb. */
  isAvatarConnected: boolean;
}

/** Ref is the `<video>` element the voice hook attaches the avatar stream to (via `videoRef`). */
export const AvatarView = forwardRef<HTMLVideoElement, AvatarViewProps>(function AvatarView(
  { audioState, isAvatarConnected },
  ref,
) {
  const styles = useStyles();
  const { t } = useTranslation();
  const [portrait, setPortrait] = useState<string | null>(readCachedPortrait);
  const innerRef = useRef<HTMLVideoElement | null>(null);
  // Per-stream fit, read from the element's intrinsic size (the voice hook assigns the element's
  // own on* handlers, so listen with addEventListener to coexist). Contain until metadata arrives.
  const [videoFit, setVideoFit] = useState<"cover" | "contain">("contain");
  const [portraitFit, setPortraitFit] = useState<"cover" | "contain">("contain");
  useEffect(() => {
    const video = innerRef.current;
    if (!video) return;
    const reflect = () => setVideoFit(fitFor(video.videoWidth, video.videoHeight));
    reflect();
    video.addEventListener("loadedmetadata", reflect);
    video.addEventListener("resize", reflect);
    return () => {
      video.removeEventListener("loadedmetadata", reflect);
      video.removeEventListener("resize", reflect);
    };
  }, []);

  // Merge the forwarded ref (the voice hook's stream target) with a local one (frame capture).
  const setVideoRef = useCallback(
    (el: HTMLVideoElement | null) => {
      innerRef.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );

  // Refresh the portrait slot from the LIVE stream so the next visit shows the person instantly.
  // Best-effort: a failed capture (no frames yet, canvas unavailable, storage quota) just keeps
  // whatever the slot already holds. MediaStream frames never taint the canvas, so toDataURL is
  // safe here.
  useEffect(() => {
    if (!isAvatarConnected) return;
    const timer = setTimeout(() => {
      const video = innerRef.current;
      if (!video || video.videoWidth === 0) return;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = PORTRAIT_CAPTURE_WIDTH;
        canvas.height = Math.round((video.videoHeight / video.videoWidth) * PORTRAIT_CAPTURE_WIDTH);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.75);
        localStorage.setItem(AVATAR_PORTRAIT_STORAGE_KEY, dataUrl);
        setPortrait(dataUrl);
      } catch {
        /* best-effort — keep the previous portrait (or none) */
      }
    }, PORTRAIT_CAPTURE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isAvatarConnected]);

  const showPortrait = !isAvatarConnected && portrait !== null;
  return (
    <div className={styles.root} data-testid="avatar-view" data-avatar-connected={isAvatarConnected}>
      <video
        ref={setVideoRef}
        autoPlay
        playsInline
        muted
        className={mergeClasses(
          styles.video,
          videoFit === "cover" ? styles.fitCover : styles.fitContain,
          isAvatarConnected ? styles.shown : styles.hidden,
        )}
        data-fit={videoFit}
        data-testid="avatar-video"
      />
      {showPortrait && (
        <>
          <img
            src={portrait}
            alt=""
            className={mergeClasses(
              styles.portrait,
              portraitFit === "cover" ? styles.fitCover : styles.fitContain,
            )}
            onLoad={(e) => setPortraitFit(fitFor(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight))}
            data-fit={portraitFit}
            data-testid="avatar-portrait"
          />
          <div className={styles.connectingHint} data-testid="avatar-connecting-hint">
            <span className={styles.connectingDot} aria-hidden />
            <Text size={200}>{t("voice.connecting")}</Text>
          </div>
        </>
      )}
      {!isAvatarConnected && !showPortrait && <AudioOrb audioState={audioState} />}
    </div>
  );
});
